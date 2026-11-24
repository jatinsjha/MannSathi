/* Execute migrations 002+003 in ephemeral PostgreSQL; never contact live Supabase. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require(process.env.PGLITE_MODULE_PATH || path.resolve(__dirname, '../.preview/sql-runtime/node_modules/@electric-sql/pglite'));
const db = new PGlite(), query = (sql, params = []) => db.query(sql, params);
const people = { teacher:'00000000-0000-4000-8000-000000000010', teacher2:'00000000-0000-4000-8000-000000000011',
  alice:'00000000-0000-4000-8000-000000000001', bob:'00000000-0000-4000-8000-000000000002', cara:'00000000-0000-4000-8000-000000000003',
  outsider:'00000000-0000-4000-8000-000000000012' };
async function admin() { await db.exec('reset role'); await query("select set_config('request.jwt.claim.sub','',false)"); }
async function actor(name, role='authenticated') { await admin(); await query("select set_config('request.jwt.claim.sub',$1,false)",[people[name]]); await db.exec(role==='anon'?'set role anon':'set role authenticated'); }
async function rpc(name, args=[], casts=[]) {
  const inputs = args.map((_,i)=>'$'+(i+1)+(casts[i]?'::'+casts[i]:''));
  return (await query('select public.mannsathi_task_'+name+'('+inputs.join(',')+') as value',args)).rows[0].value;
}
async function deny(action, code, label) { await assert.rejects(action,error=>error.code===code,label); }
const taskData = changes => ({title:'Division assignment',description:'Complete this work',subject:'CS',task_type:'assignment',priority:'medium',
  due_at:null,estimated_minutes:null,status:'pending',audience:'class',batch_id:'25cs',assigned_to:null,target_division:null,...changes});
async function create(changes={}, id=randomUUID()) { return rpc('create',[id,JSON.stringify(taskData(changes))],['uuid','jsonb']); }
async function save(name,division,extra={}) { return rpc('save_settings',[JSON.stringify({full_name:name+' Student',roll_number:name.slice(0,1)+'01',class_code:'25cs',division,...extra})],['jsonb']); }
async function approve(name,accept=true,batch='25cs',reviewedDivision={alice:'A',bob:'B',cara:'C'}[name]) {
  return rpc('approve_enrollment',[people[name],batch,accept,reviewedDivision],['uuid','text','boolean','text']);
}
async function total(table) { return Number((await query('select count(*) as value from public.'+table)).rows[0].value); }
(async()=>{
  await db.exec(`
    create role authenticated nologin nobypassrls; create role anon nologin nobypassrls;
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
    grant select,update on public.profiles to authenticated;
  `);
  for(const [name,id] of Object.entries(people)) if(name!=='outsider') await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)',
    [id,name+'@example.test',JSON.stringify({full_name:name,role:'teacher'})]);
  await db.exec(fs.readFileSync(path.resolve(__dirname,'../database/migrations/002_tasks_and_teachers.sql'),'utf8'));
  await query("insert into public.teacher_permissions(user_id,batch_code) values($1,'25cs'),($2,'25cs')",[people.teacher,people.teacher2]);
  await db.exec(fs.readFileSync(path.resolve(__dirname,'../database/migrations/003_student_divisions.sql'),'utf8'));
  assert.equal(await total('batch_permissions'),0,'reproduce five registered users and no class enrollment');
  await actor('teacher');
  let context=await rpc('context'); assert.equal(context.students.length,0); assert.equal(context.batches[0].student_count,0);
  await assert.rejects(()=>create(),error=>error.code==='PT422'&&error.message==='No approved students are enrolled in this class.');
  await admin(); assert.equal(await total('tasks'),0); assert.equal(await total('task_notifications'),0);
  await actor('alice');
  let settings=await rpc('settings'); assert.equal(settings.profile.full_name,'alice'); assert.equal(settings.membership,null); assert.equal(settings.role,'student');
  settings=await save('Alice','a',{class_code:'25CS'}); assert.equal(settings.profile.division,'A'); assert.equal(settings.membership.status,'pending');
  await deny(()=>query("update public.batch_permissions set status='approved' where user_id=$1",[people.alice]),'42501','student cannot approve membership');
  await deny(()=>query("update public.profiles set division='B' where id=$1",[people.alice]),'42501','direct settings updates cannot bypass review');
  await deny(()=>approve('alice'),'PT403','student cannot execute an enrollment approval');
  await deny(()=>rpc('pending_enrollments'),'PT403','student cannot read enrollment emails');
  await actor('teacher');
  const pending=await rpc('pending_enrollments'); assert.equal(pending.length,1); assert.equal(pending[0].email,'alice@example.test');
  context=await rpc('context'); assert.equal(context.batches[0].student_count,0); assert.equal(context.batches[0].pending_count,1);
  const reviewedA=pending[0].division;
  await actor('alice'); await save('Alice','B');
  await actor('teacher'); await deny(()=>approve('alice',true,'25cs',reviewedA),'PT409','stale A review cannot approve a changed B request');
  await actor('alice'); settings=await rpc('settings'); assert.equal(settings.membership.status,'pending'); assert.equal(settings.membership.division,'B');
  await actor('teacher'); assert.deepEqual(await approve('alice',true,'25cs','B'),{updated:true,status:'approved'},'fresh B review succeeds');
  await actor('alice'); await save('Alice','A'); await actor('teacher');
  assert.deepEqual(await approve('alice'),{updated:true,status:'approved'});
  assert.deepEqual(await approve('alice'),{updated:true,status:'approved'},'approval retry is idempotent');
  context=await rpc('context'); assert.equal(context.students.length,1); assert.equal(context.students[0].roll_number,'A01'); assert.equal(context.students[0].division,'A');
  assert.equal(context.batches[0].divisions.find(d=>d.id==='A').student_count,1);
  await deny(()=>save('Teacher','A'),'PT403','teacher cannot self-enroll through student settings');
  await actor('alice'); settings=await save('Alice','A',{full_name:'Alice Revised',roll_number:'25CS/001'});
  assert.equal(settings.membership.status,'approved','name/roll edits do not revoke class approval');
  console.log('PASS empty roster diagnosis, student settings, teacher enrollment approval, direct-write restrictions and names/rolls');

  await admin(); await query("insert into public.batch_permissions(user_id,batch_code,status) values($1,'25cs','pending')",[people.bob]);
  await actor('teacher2'); assert.deepEqual(await approve('bob',true,'25cs',null),{updated:true,status:'approved'},'legacy class-only review accepts an explicit null division');
  await actor('bob'); await save('Bob','B'); await actor('teacher2'); await approve('bob');
  // Preserve a legacy approved student with no division, as required for existing users.
  await admin(); await query("insert into public.batch_permissions(user_id,batch_code,status) values($1,'25cs','approved')",[people.cara]);
  await actor('teacher'); context=await rpc('context'); assert.equal(context.students.length,3); assert.equal(context.batches[0].student_count,3);
  assert.equal(context.students.find(s=>s.id===people.cara).division,null);
  const whole=await create({title:'All 25CS'}); assert.equal(whole.recipient_count,3);
  const key=randomUUID();
  const a=await create({title:'A only',audience:'division',target_division:'A'},key); assert.equal(a.recipient_count,1);
  assert.equal((await create({audience:'division',target_division:'A'},key)).id,a.id,'division retry returns the existing assignment');
  const b=await create({title:'B only',audience:'division',target_division:'B'}); assert.equal(b.recipient_count,1);
  const single=await create({title:'Alice only',audience:'student',assigned_to:people.alice}); assert.equal(single.recipient_count,1);
  await actor('alice'); let list=await rpc('list'); assert(list.some(t=>t.id===whole.id)&&list.some(t=>t.id===a.id)&&list.some(t=>t.id===single.id)); assert(!list.some(t=>t.id===b.id));
  let notes=await rpc('notifications'); assert.equal(notes.unread_count,3);
  await rpc('status',[a.id,'completed'],['uuid','text']);
  await actor('bob'); list=await rpc('list'); assert(list.some(t=>t.id===b.id)&&list.some(t=>t.id===whole.id)); assert(!list.some(t=>t.id===a.id)); assert(!list.some(t=>t.id===single.id));
  assert.equal(list.find(t=>t.id===b.id).status,'pending'); assert.equal((await rpc('notifications')).unread_count,2);
  await actor('cara'); list=await rpc('list'); assert.equal(list.length,1); assert.equal(list[0].id,whole.id,'legacy null division sees whole class only');
  await actor('teacher'); await assert.rejects(()=>create({audience:'division',target_division:'C'}),error=>error.code==='PT422'&&/this division/.test(error.message));
  await admin(); assert.equal(await total('tasks'),4); assert.equal(await total('task_notifications'),6,'idempotent division fan-out adds no duplicate notices');
  console.log('PASS whole-class, A/B division, single-student scopes, legacy membership, independent progress and notification idempotency');

  await actor('cara'); await save('Cara','C'); await actor('teacher'); await approve('cara');
  const c=await create({title:'C only',audience:'division',target_division:'C'}); assert.equal(c.recipient_count,1);
  await actor('cara'); list=await rpc('list'); assert.deepEqual(new Set(list.map(t=>t.id)),new Set([whole.id,c.id]));
  await actor('alice');
  const own=await create({title:'Private revision',audience:'personal',batch_id:null});
  assert.equal(own.assigned_to,people.alice); assert.equal(own.target_division,null);
  assert.equal((await rpc('status',[own.id,'completed'],['uuid','text'])).status,'completed');
  assert.equal((await rpc('status',[own.id,'pending'],['uuid','text'])).completed_at,null);
  await actor('bob'); assert(!(await rpc('list')).some(t=>t.id===own.id));
  await deny(()=>rpc('status',[a.id,'completed'],['uuid','text']),'PT404','B student cannot change A assignment status');
  await deny(()=>rpc('delete',[single.id],['uuid']),'PT404','recipient cannot delete assignment parent');
  await actor('teacher');
  await deny(()=>create({audience:'division',target_division:null}),'PT400','division audience requires a division');
  await deny(()=>create({audience:'class',target_division:'A'}),'PT400','whole class cannot hide a division filter');
  await deny(()=>create({audience:'division',target_division:'D'}),'PT400','only A/B/C divisions are valid');
  await rpc('delete',[a.id],['uuid']);
  await actor('alice'); notes=await rpc('notifications');
  assert(notes.notifications.some(n=>n.task_id===null),'deleted division assignment keeps its historical notification');
  settings=await save('Alice','B'); assert.equal(settings.membership.status,'pending');
  assert.deepEqual((await rpc('list')).map(t=>t.id),[own.id],'pending division change has no assignment access');
  assert.equal((await rpc('notifications')).unread_count,0);
  await actor('teacher'); await approve('alice',true,'25cs','B');
  await actor('alice'); list=await rpc('list');
  assert(!list.some(t=>t.id===b.id),'moving into B does not retroactively add an unintended recipient');
  assert(list.some(t=>t.id===whole.id)&&list.some(t=>t.id===single.id),'approved same-class student keeps intended whole-class and individual work');
  assert(!(await rpc('notifications')).notifications.some(n=>n.task_id===null),'former division notices stay hidden after task deletion');
  await actor('teacher'); const newB=await create({title:'New B work',audience:'division',target_division:'B'}); assert.equal(newB.recipient_count,2);
  await actor('alice'); assert((await rpc('list')).some(t=>t.id===newB.id));
  console.log('PASS C division, private personal tasks, division changes, no retroactive access and historical notification privacy');

  await admin(); await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)',[people.outsider,'outsider@example.test','{}']);
  await query("insert into public.teacher_permissions(user_id,batch_code) values($1,'26cs')",[people.outsider]);
  await actor('cara'); await save('Cara','C',{roll_number:'C02'});
  await save('Cara','B');
  await actor('outsider'); assert.deepEqual(await rpc('pending_enrollments'),[],'other class teachers cannot see pending emails');
  await deny(()=>approve('cara'),'PT403','other class teacher cannot approve 25CS');
  await deny(()=>create({audience:'division',target_division:'A'}),'PT403','other class teacher cannot assign 25CS divisions');
  await actor('teacher'); assert.equal((await rpc('pending_enrollments')).length,1);
  assert.deepEqual(await approve('cara',false,'25cs','B'),{updated:true,status:'rejected'});
  await actor('cara'); settings=await rpc('settings'); assert.equal(settings.membership.status,'rejected');
  assert.deepEqual(await rpc('list'),[]); await save('Cara','C');
  await actor('teacher2'); await approve('cara');
  await actor('cara'); assert.equal((await rpc('settings')).membership.status,'approved');
  const invalidSettings=[{full_name:'X'},{roll_number:''},{roll_number:'<script>'},{class_code:'26cs'},{division:'D'},{status:'approved'},{user_id:people.alice}];
  for(const change of invalidSettings) await deny(()=>save('Cara','C',change),'PT400','SQL validates settings '+Object.keys(change).join(','));
  await actor('alice','anon');
  await deny(()=>rpc('settings'),'42501','anonymous users cannot read settings');
  await deny(()=>rpc('pending_enrollments'),'42501','anonymous users cannot list enrollments');
  console.log('PASS teacher class isolation, rejected request resubmission, SQL settings validation and anonymous denial');
  console.log('All PostgreSQL student settings, enrollment and division checks passed; no live database was touched.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await db.close();});
