/* Run real focus RPC/RLS checks in ephemeral PostgreSQL; never contact Supabase. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require(process.env.PGLITE_MODULE_PATH || path.resolve(__dirname, '../.preview/sql-runtime/node_modules/@electric-sql/pglite'));
const db = new PGlite(), query = (sql, args=[]) => db.query(sql,args);
const users = {alice:'00000000-0000-4000-8000-000000000001',bob:'00000000-0000-4000-8000-000000000002',teacher:'00000000-0000-4000-8000-000000000010'};
const prefs = {focus_minutes:25,short_break_minutes:5,long_break_minutes:15,sessions_before_long:4,auto_start:false,sound:false};
async function admin() { await db.exec('reset role'); }
async function actor(name,role='authenticated') { await admin(); await query("select set_config('request.jwt.claim.sub',$1,false)",[users[name]||'']); await db.exec('set role '+role); }
async function rpc(name,args=[],casts=[]) { return (await query('select public.mannsathi_focus_'+name+'('+args.map((_,i)=>'$'+(i+1)+(casts[i]?'::'+casts[i]:'')).join(',')+') as value',args)).rows[0].value; }
async function deny(action,code,label) { await assert.rejects(action,error=>error.code===code,label); }
async function subject(name='Mathematics',changes={}) { return (await rpc('create_subject',[JSON.stringify({name,color:'#bda0ed',weekly_goal_minutes:120,...changes})],['jsonb'])).subject; }
async function start(subjectId,id=randomUUID(),extra={}) { return rpc('start',[id,subjectId,extra.task_id||null,extra.minutes||1,extra.zone||'Asia/Kolkata'],['uuid','uuid','uuid','integer','text']); }
async function transition(id,action) { return rpc('transition',[id,action],['uuid','text']); }
async function elapsed(id,seconds) {
  await admin();
  await query("update public.focus_sessions set last_started_at=clock_timestamp()-$2*interval '1 second' where id=$1",[id,seconds]);
  await query('update public.focus_segments set started_at=(select last_started_at from public.focus_sessions where id=$1) where session_id=$1 and ended_at is null',[id]);
  await actor('alice');
}
function close(actual,expected,delta=.3) { assert(Math.abs(actual-expected)<delta,`${actual} expected ${expected} within ${delta}`); }
async function fixture(subjectId,startAt,endAt,minutes=60,status='completed') {
  const id=randomUUID(); await admin();
  await query(`insert into public.focus_sessions(id,user_id,subject_id,status,planned_seconds,focused_seconds,started_at,finished_at,time_zone)
    values($1,$2,$3,$4,$5::integer,$5::integer,$6,$7,'America/New_York')`,[id,users.alice,subjectId,status,minutes*60,startAt,endAt]);
  await query('insert into public.focus_segments(user_id,session_id,started_at,ended_at) values($1,$2,$3,$4)',[users.alice,id,startAt,endAt]);
  return id;
}
(async()=>{
  await db.exec(`create role authenticated nologin nobypassrls; create role anon nologin nobypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}',email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to authenticated,anon;
    create table public.profiles(id uuid primary key references auth.users(id),full_name text,created_at timestamptz default now(),updated_at timestamptz default now());
    create table public.batch_permissions(id uuid primary key default gen_random_uuid(),user_id uuid not null unique references auth.users(id),
      batch_code text not null check(batch_code='25cs'),status text not null default 'pending' check(status in('pending','approved','rejected')),
      approved_by uuid references auth.users(id),approved_at timestamptz,created_at timestamptz not null default now());
    alter table public.profiles enable row level security; alter table public.batch_permissions enable row level security;
    create policy own_profile_read on public.profiles for select to authenticated using(auth.uid()=id);
    create policy own_profile_update on public.profiles for update to authenticated using(auth.uid()=id) with check(auth.uid()=id);
    grant select,update on public.profiles to authenticated;`);
  for(const [name,id] of Object.entries(users)) await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)',[id,name+'@example.test',JSON.stringify({role:name==='teacher'?'student':'teacher',full_name:name})]);
  for(const file of ['002_tasks_and_teachers.sql','003_student_divisions.sql']) await db.exec(fs.readFileSync(path.resolve(__dirname,'../database/migrations/'+file),'utf8'));
  await query("insert into public.teacher_permissions(user_id,batch_code) values($1,'25cs')",[users.teacher]);
  await db.exec(fs.readFileSync(path.resolve(__dirname,'../database/migrations/004_focus_subjects.sql'),'utf8'));
  const inspection=(await query(fs.readFileSync(path.resolve(__dirname,'../database/inspect_focus_schema.sql'),'utf8'))).rows[0].focus_schema_review;
  assert.equal(inspection.tables.length,4); assert(inspection.functions.length>=15);
  assert(inspection.tables.every(t=>t.rls_enabled&&t.rls_forced),'inspection confirms all private tables have forced RLS');
  await actor('alice'); assert.deepEqual(await rpc('subjects'),{role:'student',subjects:[]}); assert.deepEqual((await rpc('state')).prefs,prefs);
  const math=await subject(); assert.equal(math.user_id,users.alice); assert.equal(math.weekly_goal_minutes,120);
  await deny(()=>subject(' mathematics '),'PT409','active names are unique ignoring case/space');
  await deny(()=>subject('Bad',{weekly_goal_minutes:true}),'PT400','SQL rejects boolean goals');
  await deny(()=>subject('Bad',{user_id:users.bob}),'PT400','SQL rejects supplied owners');
  await deny(()=>subject('Bad',{name:''}),'PT400','SQL rejects empty names');
  await deny(()=>subject('Bad',{color:'#000000;background:red'}),'PT400','SQL accepts only safe colors');
  await deny(()=>query("update public.study_subjects set weekly_goal_minutes=999 where id=$1",[math.id]),'42501','direct subject writes denied');
  await deny(()=>rpc('require_student'),'42501','private authorization helpers not exposed');
  await actor('bob'); assert.deepEqual((await rpc('subjects')).subjects,[]); await deny(()=>start(math.id),'PT404','foreign subject denied');
  const biology=await subject('Biology');
  await actor('teacher'); await deny(()=>rpc('subjects'),'PT403','stored teacher status denies focus despite student metadata');
  await deny(()=>rpc('state'),'PT403','teacher cannot load a student timer');
  assert.equal((await query('select * from public.study_subjects')).rows.length,0,'teacher RLS has no subjects');
  await actor('alice','anon'); await deny(()=>rpc('subjects'),'42501','anonymous RPC execution denied');
  await deny(()=>query('select * from public.focus_sessions'),'42501','anonymous table select denied');
  await actor('alice'); const changed={...prefs,focus_minutes:45,auto_start:true}; assert.deepEqual(await rpc('save_prefs',[JSON.stringify(changed)],['jsonb']),{prefs:changed});
  await deny(()=>rpc('save_prefs',[JSON.stringify({...prefs,focus_minutes:0})],['jsonb']),'PT400','SQL preferences validate ranges');
  await actor('bob'); assert.deepEqual((await rpc('state')).prefs,prefs,'preferences are private');
  await actor('alice');
  const key=randomUUID(), first=await start(math.id,key); assert.equal(first.session.status,'running');
  assert.equal((await start(math.id,key)).session.id,key,'same request ID is idempotent');
  await deny(()=>start(math.id),'PT409','one active session per student');
  await deny(()=>start(math.id,key,{minutes:2}),'PT409','same ID cannot change parameters');
  await deny(()=>transition(key,'finish'),'PT409','early completion rejected');
  await deny(()=>rpc('edit_subject',[math.id,JSON.stringify({name:'Mathematics',color:'#bda0ed',weekly_goal_minutes:120,archived:true})],['uuid','jsonb']),'PT409','cannot archive active subject');
  await actor('bob'); await deny(()=>transition(key,'pause'),'PT404','foreign session transition denied');
  assert.equal((await query('select * from public.focus_sessions')).rows.length,0,'foreign sessions hidden');
  await actor('alice'); await elapsed(key,25); const paused=(await transition(key,'pause')).session; close(paused.focused_seconds,25);
  await admin(); await query("update public.focus_sessions set paused_at=clock_timestamp()-interval '2 hour' where id=$1",[key]);
  await actor('alice'); close((await rpc('state')).active.focused_seconds,paused.focused_seconds,.00001);
  assert.equal((await transition(key,'pause')).session.focused_seconds,paused.focused_seconds,'pause retries are idempotent');
  await transition(key,'resume'); await elapsed(key,120);
  const completed=(await transition(key,'finish')).session; assert.equal(completed.status,'completed'); assert.equal(completed.focused_seconds,60);
  assert.equal((await transition(key,'cancel')).session.status,'completed','terminal retries never rewrite recorded outcomes');
  await admin(); const segments=(await query('select extract(epoch from ended_at-started_at) as seconds from public.focus_segments where session_id=$1 order by id',[key])).rows;
  close(Number(segments[0].seconds)+Number(segments[1].seconds),60,.00001); assert(Number(segments[1].seconds)<36,'late completion capped at exact deadline');
  await actor('alice'); let summary=await rpc('summary',['Asia/Kolkata'],['text']); assert.equal(summary.total_seconds,60); assert.equal(summary.completed_sessions,1);
  assert.equal(summary.daily.length,14); close(summary.subjects[0].week_seconds,60,.00001);
  console.log('PASS SQL ownership, trusted roles, safe fields, private preferences, idempotency, pauses and exact deadline reconciliation');

  const early=(await start(math.id)).session; await elapsed(early.id,12);
  const interrupted=(await transition(early.id,'interrupt')).session; assert.equal(interrupted.status,'interrupted'); close(interrupted.focused_seconds,12);
  const discard=(await start(math.id)).session; await elapsed(discard.id,20);
  assert.equal((await transition(discard.id,'cancel')).session.focused_seconds,0); summary=await rpc('summary',['Asia/Kolkata'],['text']);
  close(summary.total_seconds,72); assert.equal(summary.completed_sessions,1); close(summary.subjects[0].total_seconds,72);
  assert(summary.history.some(s=>s.id===discard.id&&s.status==='cancelled'),'history records discarded session without counting it');
  const expires=(await start(math.id)).session; await elapsed(expires.id,100);
  const state=await rpc('state'); assert.equal(state.active,null); assert.equal(state.finished.id,expires.id); assert.equal(state.finished.focused_seconds,60);
  assert.equal((await rpc('state')).finished,null,'reconciled outcome is returned once by state');
  const archived=(await rpc('edit_subject',[math.id,JSON.stringify({name:'Math',color:'#8899aa',weekly_goal_minutes:90,archived:true})],['uuid','jsonb'])).subject;
  assert.equal(archived.archived,true); await deny(()=>start(math.id),'PT404','archived subjects cannot start sessions');
  const secondMath=await subject('Math'); assert.notEqual(secondMath.id,math.id,'archived names can be reused');
  summary=await rpc('summary',['UTC'],['text']); assert(summary.subjects.some(s=>s.id===math.id&&s.archived&&s.total_seconds>100),'archive preserves statistics');

  // Existing task access rules are reused; merely knowing a task UUID gives no access.
  await actor('bob'); const taskId=(await query(`select public.mannsathi_task_create($1::uuid,$2::jsonb) as value`,[randomUUID(),JSON.stringify({title:'Private work',description:'',subject:'Biology',task_type:'personal_task',priority:'medium',due_at:null,estimated_minutes:null,status:'pending',audience:'personal',assigned_to:null,batch_id:null})])).rows[0].value.id;
  await actor('alice'); await deny(()=>start(secondMath.id,randomUUID(),{task_id:taskId}),'PT404','foreign task linkage denied');
  await deny(()=>start(secondMath.id,randomUUID(),{zone:'../../etc/passwd'}),'PT400','invalid timezone rejected');
  await actor('bob'); const linked=(await start(biology.id,randomUUID(),{task_id:taskId})).session; assert.equal(linked.task_id,taskId); await transition(linked.id,'cancel');
  console.log('PASS interrupted/cancelled semantics, reload recovery, subject archival and task link authorization');

  // Split a completed hour across local midnight on the DST fall-back day.
  const dstId=await fixture(math.id,'2026-11-02T04:30:00Z','2026-11-02T05:30:00Z');
  await admin(); await query("select set_config('request.jwt.claim.sub',$1,false)",[users.alice]);
  const range=async(a,b,z)=>Number((await query('select public.mannsathi_focus_range_seconds($1::date::timestamp at time zone $3,$2::date::timestamp at time zone $3) as value',[a,b,z])).rows[0].value);
  close(await range('2026-11-01','2026-11-02','America/New_York'),1800,.00001);
  close(await range('2026-11-02','2026-11-03','America/New_York'),1800,.00001);
  assert.equal(Number((await query("select extract(epoch from ('2026-11-02'::date::timestamp at time zone 'America/New_York')-('2026-11-01'::date::timestamp at time zone 'America/New_York')) as seconds")).rows[0].seconds),90000,'fall DST boundary is 25 hours');
  const springId=await fixture(math.id,'2026-03-09T03:30:00Z','2026-03-09T04:30:00Z');
  close(await range('2026-03-08','2026-03-09','America/New_York'),1800,.00001);
  close(await range('2026-03-09','2026-03-10','America/New_York'),1800,.00001);
  await actor('alice'); const history=await rpc('history',['2026-11-01','2026-11-02','America/New_York',0,500],['date','date','text','integer','integer']);
  assert(history.some(s=>s.id===dstId)); assert(!history.some(s=>s.id===springId));
  await deny(()=>rpc('history',['2025-01-01','2026-12-31','UTC',0,500],['date','date','text','integer','integer']),'PT400','history range cap enforced in SQL');
  await actor('bob'); assert.deepEqual(await rpc('history',['2026-11-01','2026-11-02','America/New_York',0,500],['date','date','text','integer','integer']),[],'history stays private');
  await admin(); await db.exec('create policy adversarial_broad_read on public.study_subjects for select to authenticated using(true)');
  await actor('bob'); assert.equal((await query('select * from public.study_subjects')).rows.length,1,'restrictive boundary survives an extra permissive policy');
  for(const table of ['study_subjects','focus_preferences','focus_sessions','focus_segments']) {
    await deny(()=>query('delete from public.'+table),'42501','direct deletes denied for '+table);
  }
  console.log('PASS exact midnight/DST day allocation, history ranges and restrictive RLS boundaries');
  console.log('All Focus PostgreSQL checks passed; no live database was touched.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await db.close();});
