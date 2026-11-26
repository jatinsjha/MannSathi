// Creates a private, disposable loopback-only cluster. No database URL is accepted.
// Point PG_BIN_DIR at a native PostgreSQL bin directory and PG_MODULE_PATH at pg,
// or use the ignored Windows test runtime described in the administration guide.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const preview = path.resolve(__dirname, '../.preview');
const binaries = process.env.PG_BIN_DIR || path.join(preview, 'ai-postgres/node_modules/@embedded-postgres/windows-x64/native/bin');
const suffix = process.platform === 'win32' ? '.exe' : '';
const { Client } = require(process.env.PG_MODULE_PATH || path.join(preview, 'ai-postgres/node_modules/pg'));
const owner = randomUUID(), student = randomUUID();
const reserveSql = "select mannsathi_ai_pilot_reserve($1,$2,null,'model','chat',$3) as result";

async function loopbackPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function assertWaiting(observer, application) {
  for (let attempts = 0; attempts < 100; attempts++) {
    const result = await observer.query("select wait_event_type from pg_stat_activity where application_name=$1", [application]);
    if (result.rows.some(row => row.wait_event_type === 'Lock')) return;
    await delay(20);
  }
  assert.fail('Second session did not block on the first transaction');
}

async function main() {
  fs.mkdirSync(preview, {recursive:true});
  const root = fs.mkdtempSync(path.join(preview, 'ai-race-'));
  const data = path.join(root, 'database'), port = await loopbackPort();
  const password = randomBytes(32).toString('hex');
  const passwordFile = path.join(root, 'password');
  const clients = [];
  function run(command, args) {
    // A Windows postgres daemon can inherit the parent's output handles even
    // with pg_ctl -l. Avoid waiting for EOF on a pipe held by the new server.
    return execFileSync(path.join(binaries, command + suffix), args, {
      windowsHide:true,encoding:'utf8',timeout:120000,stdio:command === 'pg_ctl' ? 'ignore' : 'pipe'
    });
  }
  try {
    fs.writeFileSync(passwordFile, password, {mode:0o600});
    run('initdb', ['-D',data,'-U','test_operator','-A','scram-sha-256','--pwfile',passwordFile,'--encoding=UTF8','--no-locale','--no-sync']);
    fs.unlinkSync(passwordFile);
    run('pg_ctl', ['-D',data,'-l',path.join(root,'postgres.log'),'-o','-h 127.0.0.1 -p ' + port,'-w','start']);
    for (const application_name of ['observer','first','second']) {
      const client = new Client({host:'127.0.0.1',port,user:'test_operator',database:'postgres',password,application_name,
        connectionTimeoutMillis:10000,statement_timeout:10000});
      await client.connect();
      clients.push(client);
    }
    const [observer, first, second] = clients;
    await observer.query(`
      create role service_role nologin bypassrls;
      create role anon nologin; create role authenticated nologin;
      create schema auth; create table auth.users(id uuid primary key,is_anonymous boolean default false,email text,raw_user_meta_data jsonb);
      create table profiles(id uuid primary key,full_name text);
      create table batch_permissions(user_id uuid,batch_code text,division text,status text);
      create table teacher_permissions(user_id uuid references auth.users);
      create table calendar_exams(id uuid primary key);
    `);
    const migrations = path.resolve(__dirname,'../database/migrations');
    for (const file of fs.readdirSync(migrations).filter(name=>/^(00[6-9]|010)_/.test(name)).sort()) {
      await observer.query(fs.readFileSync(path.join(migrations,file),'utf8'));
    }
    await observer.query('insert into auth.users(id) values($1),($2)', [owner,student]);
    await observer.query('insert into ai_admins(user_id) values($1)', [owner]);
    await observer.query("select mannsathi_ai_review_pilot($1,$2,true)",[owner,student]);
    await observer.query("select mannsathi_ai_admin_change($1,'global',null,$2,null)", [owner,{daily_token_limit:10}]);

    // Second connection starts before commit and must see the first reservation.
    await first.query('begin');
    const id = randomUUID();
    assert.equal((await first.query(reserveSql,[id,student,6])).rows[0].result.allowed, true);
    const waiting = second.query(reserveSql, [randomUUID(),student,6]);
    await assertWaiting(observer, 'second');
    await first.query('commit');
    assert.equal((await waiting).rows[0].result.code, 'global_daily');
    assert.equal((await observer.query("select charged_tokens::integer as tokens from ai_daily_counters where scope_key='global'")).rows[0].tokens, 6);

    // A new restriction committed while another transaction waits for resize must
    // take effect before that in-flight request can invoke the generation API.
    await first.query('begin');
    await first.query("select mannsathi_ai_admin_change($1,'student',$2,$3,null)", [owner,student,{restricted:true}]);
    const resize = second.query('select mannsathi_ai_pilot_resize($1,7) as result', [id]);
    await assertWaiting(observer, 'second');
    await first.query('commit');
    assert.equal((await resize).rows[0].result.code,'student_restricted');
    assert.equal((await observer.query("select charged_tokens::integer as tokens from ai_daily_counters where scope_key='global'")).rows[0].tokens, 0);
    await first.query("select mannsathi_ai_admin_change($1,'student',$2,$3,null)",[owner,student,{restricted:false}]);
    const pendingId = randomUUID();
    assert.equal((await first.query(reserveSql,[pendingId,student,1])).rows[0].result.allowed,true);
    await first.query('begin');
    await first.query('select mannsathi_ai_review_pilot($1,$2,false)',[owner,student]);
    const revoked = second.query('select mannsathi_ai_pilot_resize($1,7) as result',[pendingId]);
    await assertWaiting(observer,'second');
    await first.query('commit');
    assert.equal((await revoked).rows[0].result.code,'ai_unavailable');
    assert.equal((await observer.query("select charged_tokens::integer as tokens from ai_daily_counters where scope_key='global'")).rows[0].tokens,0);
    console.log('PASS native two-session PostgreSQL lock contention, committed capacity, concurrent restriction and pilot revocation');
  } finally {
    // Close a lock holder before its waiter if an assertion interrupted the test.
    for (const client of clients) await client.end();
    if (fs.existsSync(path.join(data,'postmaster.pid'))) run('pg_ctl', ['-D',data,'-m','fast','-w','stop']);
    if (path.dirname(root) === preview && path.basename(root).startsWith('ai-race-')) {
      fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
    }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
