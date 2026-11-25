/* Real PostgreSQL permissions and exam validation, in memory only. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE_PATH || path.resolve(__dirname, '../.preview/sql-runtime/node_modules/@electric-sql/pglite'));
const db = new PGlite(), people = {teacher:'00000000-0000-4000-8000-000000000010', teacher2:'00000000-0000-4000-8000-000000000011',
  alice:'00000000-0000-4000-8000-000000000001',bob:'00000000-0000-4000-8000-000000000002',pending:'00000000-0000-4000-8000-000000000003',foreign:'00000000-0000-4000-8000-000000000004'};
async function admin(){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}
async function actor(name,role='authenticated'){await admin();await db.query("select set_config('request.jwt.claim.sub',$1,false)",[people[name]]);await db.exec('set role '+role);}
async function rpc(name,args=[],casts=[]){return (await db.query('select public.mannsathi_exam_'+name+'('+args.map((_,i)=>'$'+(i+1)+'::'+casts[i]).join(',')+') as value',args)).rows[0].value;}
const data = changes => ({title:'Data structures exam',description:'Bring your ID',category:'examination',location:'Room 12',all_day:false,
  starts_at:'2026-11-26T09:00:00+05:30',ends_at:'2026-11-26T11:00:00+05:30',start_date:null,end_date:null,time_zone:'Asia/Calcutta',reminder_minutes:30,
  audience:'class',batch_id:'25cs',target_division:null,assigned_to:null,...changes});
const create = changes => rpc('create',[JSON.stringify(data(changes))],['jsonb']);
const edit = (id,changes) => rpc('edit',[id,JSON.stringify(data(changes))],['uuid','jsonb']);
const list = () => rpc('list',['2026-11-25','2026-11-28','Asia/Calcutta',0,500],['date','date','text','integer','integer']);
async function deny(action,code){await assert.rejects(action,error=>error.code===code);}
(async()=>{
  await db.exec(`create role authenticated nologin nobypassrls; create role anon nologin nobypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}',email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to authenticated,anon;
    create table public.profiles(id uuid primary key references auth.users(id),full_name text,created_at timestamptz default now(),updated_at timestamptz default now());
    create table public.batch_permissions(id uuid primary key default gen_random_uuid(),user_id uuid not null unique references auth.users(id),
      batch_code text not null,status text not null default 'pending',approved_by uuid references auth.users(id),approved_at timestamptz,created_at timestamptz default now());
    alter table public.profiles enable row level security; alter table public.batch_permissions enable row level security;
    grant select,update on public.profiles to authenticated;`);
  for(const [name,id] of Object.entries(people)) await db.query('insert into auth.users(id,email) values($1,$2)',[id,name+'@example.test']);
  for(const migration of ['001_smart_calendar.sql','002_tasks_and_teachers.sql','003_student_divisions.sql','005_teacher_exams.sql'])
    await db.exec(fs.readFileSync(path.resolve(__dirname,'../database/migrations',migration),'utf8'));
  await db.query("insert into public.teacher_permissions(user_id,batch_code) values($1,'25cs'),($2,'25cs'),($3,'26cs')",[people.teacher,people.teacher2,people.foreign]);
  await db.query("insert into public.batch_permissions(user_id,batch_code,division,status) values($1,'25cs','A','approved'),($2,'25cs','B','approved'),($3,'25cs','A','pending')",[people.alice,people.bob,people.pending]);
  await actor('teacher');
  const whole=await create(),a=await create({title:'A exam',audience:'division',target_division:'A'}),single=await create({title:'Alice exam',audience:'student',assigned_to:people.alice});
  assert.equal(whole.source,'teacher_exam');assert.equal(whole.can_edit,true);assert.equal(whole.user_id,people.teacher);
  assert.equal((await list()).length,3);assert.equal((await edit(whole.id,{title:'Changed exam'})).title,'Changed exam');
  await actor('alice');let rows=await list();assert.equal(rows.length,3);assert(rows.every(row=>row.can_edit===false));
  assert.equal((await db.query('select * from public.calendar_exams')).rows.length,3,'direct read respects RLS');
  await deny(()=>edit(whole.id,{title:'Tampered'}),'PT404');await deny(()=>rpc('delete',[whole.id],['uuid']),'PT404');
  await deny(()=>create(),'PT403');await deny(()=>db.query("update public.calendar_exams set title='Tampered'"),'42501');
  await deny(()=>db.query('delete from public.calendar_exams'),'42501');await deny(()=>db.query('insert into public.calendar_exams default values'),'42501');
  await deny(()=>rpc('save',[null,JSON.stringify(data())],['uuid','jsonb']),'42501','internal writer unavailable');
  await actor('bob');rows=await list();assert.deepEqual(rows.map(row=>row.id),[whole.id]);
  await actor('pending');assert.deepEqual(await list(),[]);assert.equal((await db.query('select * from public.calendar_exams')).rows.length,0);
  await actor('teacher2');assert.deepEqual(await list(),[]);await deny(()=>edit(whole.id,{}),'PT404');
  await actor('foreign');await deny(()=>create(),'PT403');assert.deepEqual(await list(),[]);
  await actor('teacher');await deny(()=>create({audience:'division',target_division:'C'}),'PT422');
  await deny(()=>create({audience:'student',assigned_to:people.pending}),'PT422');
  for(const change of [{user_id:people.bob},{id:whole.id},{source:'teacher_exam'},{can_edit:true},{category:'lecture'},{time_zone:'Mars/Base'},
    {title:1},{all_day:'false'},{audience:'personal'},{audience:'division',target_division:'D'},{audience:'class',target_division:'A'},
    {audience:'student',assigned_to:null},{starts_at:'2026-11-26T09:00:00'},{reminder_minutes:true},{reminder_minutes:31},
    {start_date:'2026-11-26'},{all_day:true,starts_at:null,ends_at:null,start_date:'2026-11-26',end_date:'2026-11-26'}])
    await assert.rejects(()=>create(change),error=>['PT400','23514','22P02','22007','22008'].includes(error.code),JSON.stringify(change));
  const day=await create({title:'All day exam',all_day:true,starts_at:null,ends_at:null,start_date:'2026-11-27',end_date:'2026-11-28'});
  assert.equal(day.end_date,'2026-11-28');assert.equal(day.starts_at,null);
  assert.equal((await rpc('list',['2026-11-28','2026-11-29','UTC',0,500],['date','date','text','integer','integer'])).length,0,'exclusive end');
  await deny(()=>rpc('list',['2026-01-01','2027-01-01','UTC',0,500],['date','date','text','integer','integer']),'PT400');
  await deny(()=>rpc('list',['2026-11-25','2026-11-28','Mars/Base',0,500],['date','date','text','integer','integer']),'PT400');
  await admin();await db.query("update public.batch_permissions set status='pending',division='B' where user_id=$1",[people.alice]);
  await actor('alice');assert.deepEqual(await list(),[],'changed pending membership loses exams');
  await admin();await db.query("update public.batch_permissions set status='approved' where user_id=$1",[people.alice]);
  await actor('alice');rows=await list();assert(!rows.some(row=>row.id===a.id));assert(rows.some(row=>row.id===single.id),'individual exams follow the same class');
  await actor('teacher');assert.deepEqual(await rpc('delete',[whole.id],['uuid']),{deleted:true});
  await actor('bob');assert(!(await list()).some(row=>row.id===whole.id));
  await actor('alice','anon');await deny(()=>list(),'42501');await deny(()=>db.query('select * from public.calendar_exams'),'42501');
  console.log('PASS teacher exam SQL validation, RLS, class/division/student visibility, read-only recipients, creator changes, dates and anonymous denial. No live database touched.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await db.close();});
