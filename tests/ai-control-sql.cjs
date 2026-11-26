// Runs solely against a fresh in-memory PostgreSQL database (PGlite).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require(process.env.PGLITE_MODULE_PATH ||
  path.resolve(__dirname, '../.preview/sql-runtime/node_modules/@electric-sql/pglite'));

const db = new PGlite();
const owner = randomUUID(), teacher = randomUUID(), alice = randomUUID(), bob = randomUUID();
const query = (sql, args = []) => db.query(sql, args);
const first = async (sql, args) => (await query(sql, args)).rows[0];
const deny = (action, code) => assert.rejects(action, e => e.code === code);
async function rpc(name, args) {
  const slots = args.map((_, i) => '$' + (i + 1)).join(',');
  return (await first('select public.mannsathi_ai_' + name + '(' + slots + ') as result', args)).result;
}
const change = (scope, target, fields, actor = owner) =>
  rpc('admin_change', [actor, scope, target, JSON.stringify(fields), 'Reviewed policy']);
const reserve = (user, amount, id = randomUUID(), retry = null) =>
  rpc('reserve', [id, user, retry, 'test-model', 'chat', amount]);
const finish = (id, status, input, output, total, thought = null) =>
  rpc('finish', [id, status, input, output, total, thought, 75, status === 'failed' ? 'provider_timeout' : null, 'test-version']);
const assertBlock = (value, code) => assert.deepEqual(value, { allowed: false, code });

async function run() {
  await db.exec(`
    create role authenticated nologin nobypassrls;
    create role anon nologin nobypassrls;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}',email text,is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to authenticated,anon,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    create table public.profiles(id uuid primary key references auth.users(id),full_name text,created_at timestamptz default now(),updated_at timestamptz default now());
    create table public.batch_permissions(id uuid primary key default gen_random_uuid(),user_id uuid not null unique references auth.users(id),
      batch_code text not null,status text not null,approved_by uuid references auth.users(id),approved_at timestamptz,created_at timestamptz default now());
  `);
  const directory = path.resolve(__dirname, '../database/migrations');
  for (const file of fs.readdirSync(directory).filter(n => /^00[0-6]_.*\.sql$/.test(n)).sort()) {
    await db.exec(fs.readFileSync(path.join(directory, file), 'utf8'));
  }
  for (const id of [owner, teacher, alice, bob]) {
    await query("insert into auth.users(id,raw_user_meta_data) values ($1,'{\"role\":\"admin\"}')", [id]);
  }
  await query('insert into public.ai_admins(user_id) values ($1)', [owner]);
  await query("insert into public.teacher_permissions(user_id,batch_code) values ($1,'25cs')", [teacher]);
  for (const role of ['anon', 'authenticated']) {
    await db.exec('set role ' + role);
    for (const t of ['ai_admins','ai_usage','ai_audit','ai_global_policy','ai_student_policies','ai_model_pricing','ai_daily_counters']) {
      await deny(() => query('select * from public.' + t), '42501');
    }
    await deny(() => rpc('admin_gate', [owner]), '42501');
    await deny(() => rpc('assert_admin', [owner]), '42501');
    await deny(() => reserve(bob, 1), '42501');
    await deny(() => change('global', null, {enabled:false}), '42501');
    await deny(() => query('insert into ai_admins(user_id) values ($1)', [bob]), '42501');
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  await deny(() => query('select * from public.ai_usage'), '42501');
  assert.equal(await rpc('admin_gate', [owner]), true);
  for (const user of [alice, teacher]) {
    await deny(() => rpc('admin_gate', [user]), 'PT403');
    await deny(() => change('global', null, {enabled:false}, user), 'PT403');
  }
  for (let i = 1; i < 120; i++) await rpc('admin_gate', [owner]);
  await deny(() => rpc('admin_gate', [owner]), 'PT429');
  console.log('PASS full migration chain, default Supabase grants, row privacy, trusted admin membership and rolling admin rate limit');

  const config = await change('global', null, {monthly_budget:2.5,warning_thresholds:[100,40]});
  assert.deepEqual(config.warning_thresholds, [40,100]);
  for (const fields of [{enabled:'false'},{daily_token_limit:'1'},{monthly_token_limit:-1},{request_limit:2},
      {daily_token_limit:1000000000001},{warning_thresholds:[0]},{warning_thresholds:[1,1]},
      {warning_thresholds:['50']},{warning_thresholds:[]},{monthly_budget:-0.01}]) {
    await deny(() => change('global', null, fields), 'PT400');
  }
  await deny(() => change('student', teacher, {enabled:false}), 'PT404');
  await deny(() => change('student', randomUUID(), {enabled:false}), 'PT404');
  await change('pricing', null, {model:'test-model',input_per_million:10,output_per_million:20});
  const firstId = randomUUID();
  assert.equal((await reserve(alice, 100, firstId)).allowed, true);
  assertBlock(await reserve(alice, 100, firstId), 'duplicate');
  assertBlock(await reserve(alice, 1, randomUUID(), firstId), 'invalid_retry');
  await change('pricing', null, {model:'test-model',input_per_million:90});
  await finish(firstId, 'success', 4, 6, 12, 2);
  await finish(firstId, 'success', 4, 6, 12, 2);
  assertBlock(await reserve(bob, 1, randomUUID(), firstId), 'invalid_retry');
  await db.exec('reset role');
  const billed = await first('select estimated_cost,total_tokens from ai_usage where request_id=$1', [firstId]);
  assert.equal(Number(billed.estimated_cost), 0.0002);
  assert.equal(billed.total_tokens, 12);
  assert.equal(Number((await first("select charged_tokens from ai_daily_counters where scope_key='global'")).charged_tokens), 12);
  const saved = await first("select * from ai_audit where action='global_changed'");
  assert.equal(saved.admin_id, owner);
  assert.equal(saved.previous_value.monthly_budget, null);
  assert.equal(saved.new_value.monthly_budget, 2.5);
  assert.equal(saved.reason, 'Reviewed policy');
  await db.exec('set role service_role');
  console.log('PASS numeric and target validation, previous/new audit, price snapshots, thought-token billing and idempotent settlement');

  await change('student', alice, {monthly_token_limit:30,daily_token_limit:20,request_limit:3});
  assertBlock(await reserve(alice, 9), 'student_daily');
  const failedId = randomUUID();
  await reserve(alice, 1, failedId, firstId);
  assertBlock(await rpc('resize', [failedId, 9]), 'student_daily');
  const unknownId = randomUUID();
  assert.equal((await reserve(alice, 1, unknownId, failedId)).allowed, true);
  assert.equal((await rpc('resize', [unknownId, 7])).allowed, true);
  await finish(unknownId, 'failed', null, null, null);
  assertBlock(await reserve(alice, 1), 'student_requests');
  await change('student', alice, {request_limit:null,daily_token_limit:null});
  assertBlock(await reserve(alice, 12), 'student_monthly');
  await change('global', null, {monthly_token_limit:20,daily_token_limit:19});
  assertBlock(await reserve(bob, 1), 'global_daily');
  await change('global', null, {daily_token_limit:null});
  assertBlock(await reserve(bob, 2), 'global_monthly');
  await change('global', null, {monthly_token_limit:null,requests_per_minute:2});
  assertBlock(await reserve(bob, 1), 'global_rpm');
  await change('global', null, {requests_per_minute:null});
  assertBlock(await reserve(null, 1), 'guest_requests');
  await change('global', null, {guest_request_limit:2,guest_token_limit:5});
  assert.equal((await reserve(null, 4)).allowed, true);
  assertBlock(await reserve(null, 2), 'guest_tokens');
  assert.equal((await reserve(null, 1)).allowed, true);
  assertBlock(await reserve(null, 1), 'guest_requests');
  await db.exec('reset role');
  const missing = await first('select * from ai_usage where request_id=$1', [unknownId]);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error_category, 'provider_timeout');
  for (const key of ['input_tokens','output_tokens','total_tokens','estimated_cost']) assert.equal(missing[key], null);
  assert.equal(missing.reserved_tokens, 7);
  assert.equal(missing.retry_of, failedId);
  assert.equal(Number((await first('select charged_tokens from ai_daily_counters where scope_key=$1', [alice])).charged_tokens), 19);
  await db.exec('set role service_role');
  console.log('PASS UTC token and request limits, atomic resize, guest pool, blocked requests, missing metadata and conservative settlement');

  await change('student', alice, {enabled:false});
  assertBlock(await reserve(alice, 1), 'student_disabled');
  const future = new Date(Date.now() + 3600000).toISOString();
  await change('student', alice, {enabled:true,restricted:true,restriction_reason:'Reviewed usage',restricted_until:future});
  assertBlock(await reserve(alice, 1), 'student_restricted');
  assert.equal((await reserve(bob, 1)).allowed, true);
  await change('student', alice, {restricted_until:'2020-01-01T00:00:00Z'});
  assert.equal((await reserve(alice, 1)).allowed, true);
  const unblocked = await change('student', alice, {restricted:false});
  assert.equal(unblocked.restriction_reason, null);
  assert.equal(unblocked.restricted_until, null);
  const inFlight = randomUUID();
  await reserve(bob, 1, inFlight);
  await change('global', null, {enabled:false});
  assertBlock(await rpc('resize', [inFlight, 10]), 'global_disabled');
  assertBlock(await reserve(alice, 1), 'global_disabled');
  await change('global', null, {enabled:true});
  await change('student', bob, {daily_token_limit:10});
  // PGlite queues query execution. These promises exercise admission of outstanding
  // requests with unreleased holds; tests/ai-postgres-race.cjs exercises two sessions.
  const admissions = await Promise.all([reserve(bob, 6), reserve(bob, 6)]);
  assert.equal(admissions.filter(r => r.allowed).length, 1);
  assert.equal(admissions.find(r => !r.allowed).code, 'student_daily');
  console.log('PASS blocking, expiry, unblocking, global switch while counting and outstanding parallel reservations');

  async function counter() {
    await db.exec('reset role');
    const row = await first('select requests,charged_tokens from ai_daily_counters where scope_key=$1', [bob]);
    await db.exec('set role service_role');
    return { requests:Number(row.requests), tokens:Number(row.charged_tokens) };
  }
  await change('student', bob, {daily_token_limit:null});
  const before = await counter();
  const preflight = randomUUID();
  await reserve(bob, 200, preflight);
  const preflightArgs = [preflight,'failed',null,null,null,null,3,'provider_timeout',null,false];
  await rpc('finish',preflightArgs);
  await rpc('finish',preflightArgs);
  assert.deepEqual(await counter(), {requests:before.requests+1,tokens:before.tokens});
  const ambiguous = randomUUID();
  await reserve(bob, 100, ambiguous);
  await rpc('finish',[ambiguous,'failed',null,null,null,null,3,'provider_timeout',null,true]);
  assert.deepEqual(await counter(), {requests:before.requests+2,tokens:before.tokens+100});
  const partial = randomUUID();
  await reserve(bob, 3, partial);
  await deny(() => rpc('finish',[partial,'failed',4,null,null,null,3,'provider_timeout',null,false]), 'PT400');
  await rpc('finish',[partial,'failed',4,5,null,1,3,'provider_timeout',null,true]);
  assert.deepEqual(await counter(), {requests:before.requests+3,tokens:before.tokens+110});
  await db.exec('reset role');
  const preflightRecord = await first('select generation_attempted,input_tokens,total_tokens from ai_usage where request_id=$1',[preflight]);
  assert.deepEqual(preflightRecord,{generation_attempted:false,input_tokens:null,total_tokens:null});
  console.log('PASS confirmed pre-generation release, uncertain generation hold, partial metadata and idempotent recovery');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
