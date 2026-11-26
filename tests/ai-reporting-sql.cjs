/* Run the migrations and reports against an isolated in-memory PostgreSQL engine. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { PGlite } = require(process.env.PGLITE_MODULE_PATH ||
  path.resolve(__dirname, '../.preview/sql-runtime/node_modules/@electric-sql/pglite'));
const db = new PGlite();
const owner = '00000000-0000-4000-8000-000000000010';
const teacher = '00000000-0000-4000-8000-000000000011';
const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';

async function report(action, filters, actor=owner) {
  return (await db.query('select public.mannsathi_ai_report($1::uuid,$2,$3::jsonb) as v',
    [actor, action, JSON.stringify(filters)])).rows[0].v;
}
async function main() {
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to authenticated,anon;
    create table public.profiles(id uuid primary key references auth.users(id), full_name text, created_at timestamptz,updated_at timestamptz);
    create table public.batch_permissions(id uuid primary key default gen_random_uuid(),user_id uuid unique references auth.users(id),
      batch_code text,status text,approved_by uuid,approved_at timestamptz,created_at timestamptz);
    alter table public.profiles enable row level security; alter table public.batch_permissions enable row level security;`);
  const dir = path.resolve(__dirname, '../database/migrations');
  for (const file of fs.readdirSync(dir).filter(f=>/^00[0-8]_/.test(f)).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  for (const [id,name] of [[owner,'owner'],[teacher,'teacher'],[alice,'Alice'],[bob,'Bob']]) {
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id,name+'@example.test',JSON.stringify({full_name:name})]);
  }
  await db.query('insert into public.ai_admins(user_id) values($1)',[owner]);
  await db.query("insert into public.teacher_permissions(user_id,batch_code) values($1,'25cs')",[teacher]);
  await db.query("insert into public.batch_permissions(user_id,batch_code,status,division) values($1,'25cs','approved','A')",[alice]);
  await db.query("insert into public.ai_student_policies(user_id,daily_token_limit) values($1,100)",[alice]);
  await db.query("insert into public.ai_daily_counters values($1,(now() at time zone 'UTC')::date,2,78)",[alice]);
  await db.exec("update public.ai_global_policy set monthly_budget=25");
  const today = (await db.query("select ((now() at time zone 'UTC')::date)::text as v")).rows[0].v;
  const range = {start:today,end:today};
  // Alice has one metered success and one upstream error, Bob's success omitted
  // all metadata. Guests remain separate, and an old request is outside the range.
  for (const [user,status,category,i,o,total,cost,offset] of [
    [alice,'success',null,10,2,14,0.001,0],
    [alice,'failed','provider_rate_limit',null,null,null,null,0],
    [bob,'success',null,null,null,null,null,0],
    [bob,'blocked','student_disabled',null,null,null,null,0],
    [null,'success',null,3,2,5,0.002,0],
    [alice,'success',null,111,22,133,1,430]
  ]) {
    await db.query(`insert into public.ai_usage(request_id,user_id,created_at,finished_at,model,feature,status,admitted,
      error_category,input_tokens,output_tokens,total_tokens,reserved_tokens,estimated_cost)
      values(gen_random_uuid(),$1,now()-make_interval(days=>$8),now()-make_interval(days=>$8),'gemini-test','academic_chat',$2,$2<>'blocked',$3,$4,$5,$6,99,$7)`,
      [user,status,category,i,o,total,cost,offset]);
  }
  await db.query(`insert into public.ai_usage(request_id,user_id,created_at,finished_at,model,feature,status,admitted,
    generation_attempted,error_category,reserved_tokens) values(gen_random_uuid(),$1,now(),now(),'gemini-test','academic_chat',
    'failed',true,false,'provider_rate_limit',1)`,[bob]);
  await db.exec('set role authenticated');
  for (const statement of ['select * from public.ai_student_directory', 'select * from public.ai_usage',
    'select * from public.ai_quota_snapshots', 'select * from public.ai_billing_snapshots',
    "select public.mannsathi_ai_import_billing('example-project',current_date,0,now())",
    "select public.mannsathi_ai_import_quota('example-project','gemini-test','RPM','metric','minute',now(),now(),10,0)",
    "select public.mannsathi_ai_provider_snapshot(null,'provider','example-project')",
    "select * from public.mannsathi_ai_rollup(current_date,current_date,null)"]) {
    await assert.rejects(db.query(statement), e=>e.code==='42501');
  }
  await assert.rejects(report('logs',range),e=>e.code==='42501');
  await db.exec('reset role; set role anon');
  await assert.rejects(report('export',range),e=>e.code==='42501');
  await db.exec('reset role; set role service_role');
  for (const id of [alice,teacher]) {
    for (const action of ['logs','export','student','settings','billing','audit']) {
      await assert.rejects(report(action,{...range,user_id:bob},id),e=>e.code==='PT403');
    }
  }
  const overview=await report('overview',range);
  assert.equal(overview.summary.requests,6);
  assert.equal(overview.summary.succeeded,3);
  assert.equal(overview.summary.failed,2);
  assert.equal(overview.summary.blocked,1);
  assert.equal(overview.summary.guest_requests,1);
  assert.equal(overview.summary.active_users,2);
  assert.equal(overview.summary.total_tokens,19);
  assert.equal(overview.summary.average_tokens,9.5);
  assert.equal(overview.summary.unknown_tokens,2);
  assert.equal(overview.summary.unknown_cost,2);
  assert.deepEqual(overview.student_summary,{requests:5,total_tokens:14,unknown_total:2});
  assert.equal(overview.daily[0].day,today);
  assert.equal(overview.models[0].model,'gemini-test');
  assert.equal(overview.students[0].user_id,alice);
  const empty=await report('overview',{start:'2000-01-01',end:'2000-01-02'});
  assert.equal(empty.summary.requests,0); assert.equal(empty.summary.total_tokens,0);
  const list=await report('students',{...range,status:'warning',division:'A',class_code:'25cs',q:'ali',sort:'cost',page_size:1});
  assert.equal(list.total,1); assert.equal(list.rows[0].usage_pct,78); assert.equal(list.rows[0].warning_pct,75);
  const page=await report('students',{...range,page:3,page_size:1});
  assert.equal(page.total,2); assert.deepEqual(page.rows,[]);
  const student=await report('student',{...range,user_id:bob,page_size:1});
  assert.equal(student.summary.total_tokens,null); assert.equal(student.summary.unknown_tokens,1);
  assert.equal(student.logs.total,3); assert.equal(student.logs.rows.length,1);
  assert.equal(student.logs.rows[0].user_id,bob); assert.equal(student.monthly.length,1);
  await assert.rejects(report('student',{...range,user_id:teacher}),e=>e.code==='PT404');
  const logs=await report('logs',{...range,user_id:alice,status:'failed',model:'gemini-test',feature:'academic_chat'});
  assert.equal(logs.total,1); assert.equal(logs.rows[0].error_category,'provider_rate_limit');
  const csv=await report('export',{...range,status:'success'});
  assert.equal(csv.total,3); assert(csv.rows.every(r=>!('reserved_tokens' in r)));
  const billing=await report('billing',{});
  assert.equal(billing.budget,25); assert.equal(billing.actual_spend,null);
  assert.equal(billing.estimated_cost,0.003); assert.equal(billing.projection,null);
  assert.equal(billing.remaining_budget,null); assert.equal(billing.budget_pct,null);
  assert.equal((await report('provider',{model:'gemini-test'})).rate_limits,2);
  assert.equal((await report('provider',{model:'other'})).last_success,null);
  const updated=await db.query("select public.mannsathi_ai_admin_change($1,'student',$2,$3,'Requested break')",
    [owner,bob,JSON.stringify({restricted:true,restriction_reason:'Requested break'})]);
  assert(updated.rows.length); assert.equal((await report('students',{...range,status:'restricted'})).rows[0].user_id,bob);
  const trail=await report('audit',range);
  assert.equal(trail.rows[0].admin_id,owner); assert.equal(trail.rows[0].reason,'Requested break');
  const denial=trail.rows.find(r=>r.action==='request_blocked');
  assert.equal(denial.target_user_id,bob); assert.equal(denial.reason,'student_disabled');
  assert.equal(denial.admin_id,null); assert(denial.new_value.request_id);
  await checkSnapshots();
  await db.exec('reset role');
  await db.exec(`with people as (insert into auth.users(id,email)
    select gen_random_uuid(),'student'||n||'@example.test' from generate_series(1,11) n returning id)
    insert into public.ai_usage(request_id,user_id,created_at,model,feature,status,admitted,generation_attempted,reserved_tokens,total_tokens)
    select gen_random_uuid(),id,now(),'gemini-test','chat','success',true,true,10,10 from people`);
  await db.exec('set role service_role');
  const larger=await report('overview',range);
  assert.equal(larger.students.length,10);
  assert.equal(larger.student_summary.total_tokens,124);
  assert.equal(larger.summary.total_tokens,129);
  assert.equal(larger.student_summary.requests,16);
  await db.query("select public.mannsathi_ai_admin_change($1,'student',$2,$3::jsonb,'Zero allowance')",
    [owner,bob,JSON.stringify({request_limit:0,restricted:false})]);
  const exhausted = await report('students',{...range,q:'Bob',status:'restricted'});
  assert.equal(exhausted.rows[0].access_status,'limit reached');
  assert.equal(exhausted.rows[0].usage_pct,null);
  console.log('PASS PostgreSQL admin reports, authorization, guest/unknown totals, costs, filters, pagination, restrictions, thresholds, CSV, audit and scoped Google snapshots.');
}
async function checkSnapshots() {
  const project='example-project';
  async function snapshot(action, p=project, id=owner) {
    return (await db.query('select public.mannsathi_ai_provider_snapshot($1,$2,$3) as v',[id,action,p])).rows[0].v;
  }
  async function quota(metric,limit,usage) {
    const base='generativelanguage.googleapis.com/quota/generate_content_free_tier_'+(metric==='TPM'?'input_token_count':'requests');
    const name='Generate'+(metric==='TPM'?'InputTokens':'Requests')+'Per'+(metric==='RPD'?'Day':'Minute')+'PerProjectPerModel-FreeTier';
    return db.query(`select public.mannsathi_ai_import_quota($1,'gemini-test',$2,$3,$4,
      case when $2='RPD' then date_trunc('day',at_time-interval '1 microsecond','America/Los_Angeles')
        else at_time-interval '1 minute' end,at_time,$5,$6)
      from (select date_trunc('minute',now())-interval '5 minutes' as at_time) obs`,[project,metric,base,name,limit,usage]);
  }
  assert.deepEqual((await snapshot('provider')).metrics,[]);
  await assert.rejects(snapshot('provider',project,teacher),e=>e.code==='PT403');
  await assert.rejects(snapshot('billing',project,alice),e=>e.code==='PT403');
  await quota('RPM',250,100); await quota('TPM',1000,null); await quota('RPD',0,0);
  await assert.rejects(quota('TPM',10,-5),e=>e.code==='23514');
  await assert.rejects(db.query(`select public.mannsathi_ai_import_quota($1,'gemini-test','RPM',
    'generativelanguage.googleapis.com/quota/generate_content_free_tier_requests','GenerateRequestsPerMinutePerProjectPerModel',
    now()-interval '1 day',now(),20,5)`,[project]),e=>e.code==='23514');
  const metrics=(await snapshot('provider')).metrics;
  const rpm=metrics.find(m=>m.metric==='RPM'), tpm=metrics.find(m=>m.metric==='TPM'), rpd=metrics.find(m=>m.metric==='RPD');
  assert.equal(rpm.used_pct,40); assert.equal(rpm.remaining_pct,60); assert.equal(rpm.remaining,150);
  assert.equal(tpm.used_pct,null); assert.equal(tpm.remaining,null);
  assert.equal(rpd.used_pct,null); assert.equal(rpd.remaining_pct,null);
  assert.deepEqual((await snapshot('provider','other-project')).metrics,[]);
  assert.deepEqual((await snapshot('provider',null)).metrics,[]);
  await db.query(`select public.mannsathi_ai_import_billing($1,date_trunc('month',timezone('UTC',now())-interval '1 month')::date,
    100,now()-interval '1 month')`,[project]);
  assert.equal((await snapshot('billing')).actual_spend,null);
  await db.query(`select public.mannsathi_ai_import_billing($1,date_trunc('month',timezone('UTC',now()))::date,0,now())`,[project]);
  await db.query(`select public.mannsathi_ai_import_billing($1,date_trunc('month',timezone('UTC',now()))::date,8,
    greatest(date_trunc('month',now(),'UTC'),now()-interval '1 hour'))`,[project]);
  await assert.rejects(db.query(`select public.mannsathi_ai_import_billing($1,date_trunc('month',timezone('UTC',now()))::date,10,now()+interval '1 hour')`,[project]),e=>e.code==='23514');
  assert.equal((await snapshot('billing')).actual_spend,0);
  assert.equal((await snapshot('billing','other-project')).actual_spend,null);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.close());
