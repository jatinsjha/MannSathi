/* Execute the production migration in an ephemeral PostgreSQL engine. No live DB access. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const modulePath = process.env.PGLITE_MODULE_PATH || path.resolve(__dirname, '../.preview/sql-runtime/node_modules/@electric-sql/pglite');
let PGlite;
try { ({ PGlite } = require(modulePath)); }
catch { throw new Error('Install @electric-sql/pglite in ignored .preview/sql-runtime, or set PGLITE_MODULE_PATH to its package directory.'); }

const people = {
  teacher: '00000000-0000-4000-8000-000000000010',
  otherTeacher: '00000000-0000-4000-8000-000000000011',
  alice: '00000000-0000-4000-8000-000000000001',
  bob: '00000000-0000-4000-8000-000000000002',
  pending: '00000000-0000-4000-8000-000000000003'
};
const db = new PGlite();
const query = (sql, params = []) => db.query(sql, params);
async function admin() { await db.exec('reset role'); await query("select set_config('request.jwt.claim.sub','',false)"); }
async function actor(person, role = 'authenticated') {
  await admin();
  await query("select set_config('request.jwt.claim.sub',$1,false)", [people[person] || '']);
  await db.exec(role === 'anon' ? 'set role anon' : 'set role authenticated');
}
async function rpc(name, args = [], casts = []) {
  const params = args.map((_, index) => '$' + (index + 1) + (casts[index] ? '::' + casts[index] : ''));
  const result = await query('select public.mannsathi_task_' + name + '(' + params.join(',') + ') as value', args);
  return result.rows[0].value;
}
function data(changes = {}) {
  return { title: 'Study arrays', description: 'Practice a solution', subject: 'Computer Science',
    task_type: 'homework', priority: 'high', due_at: '2026-11-25T09:00:00+05:30', estimated_minutes: 45,
    audience: 'personal', assigned_to: null, batch_id: null, status: 'pending', ...changes };
}
async function create(changes = {}, request = randomUUID()) { return rpc('create', [request, JSON.stringify(data(changes))], ['uuid', 'jsonb']); }
async function edit(id, changes = {}) {
  const value = data(changes); delete value.audience; delete value.assigned_to; delete value.batch_id; delete value.status;
  return rpc('edit', [id, JSON.stringify(value)], ['uuid', 'jsonb']);
}
async function denies(action, code, label) {
  await assert.rejects(action, error => error.code === code, label);
}
async function count(table) { return Number((await query('select count(*) as value from public.' + table)).rows[0].value); }

(async () => {
  await db.exec(`
    create role authenticated nologin nobypassrls;
    create role anon nologin nobypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb not null default '{}', email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public, auth to authenticated, anon;
    create table public.profiles(id uuid primary key references auth.users(id) on delete cascade,
      full_name text, created_at timestamptz default now(), updated_at timestamptz default now());
    create table public.batch_permissions(id uuid primary key default gen_random_uuid(),
      user_id uuid not null unique references auth.users(id) on delete cascade,
      batch_code text not null check(batch_code='25cs'),
      status text not null default 'pending' check(status in ('pending','approved','rejected')),
      approved_by uuid references auth.users(id), approved_at timestamptz, created_at timestamptz not null default now());
    alter table public.profiles enable row level security;
    alter table public.batch_permissions enable row level security;
    create policy own_profile_read on public.profiles for select to authenticated using(auth.uid()=id);
    create policy own_profile_update on public.profiles for update to authenticated using(auth.uid()=id) with check(auth.uid()=id);
    grant select, update on public.profiles to authenticated;
  `);
  for (const [name, id] of Object.entries(people)) {
    await query('insert into auth.users(id,raw_user_meta_data,email) values($1,$2::jsonb,$3)',
      [id, JSON.stringify({ full_name: name, role: 'teacher' }), name + '@example.test']);
    await query('insert into public.profiles(id,full_name) values($1,$2)', [id, name]);
  }
  for (const name of ['alice', 'bob', 'pending']) {
    await query("insert into public.batch_permissions(user_id,batch_code,status) values($1,'25cs',$2)",
      [people[name], name === 'pending' ? 'pending' : 'approved']);
  }
  await db.exec(fs.readFileSync(path.resolve(__dirname, '../database/migrations/002_tasks_and_teachers.sql'), 'utf8'));
  await query('insert into public.teacher_permissions(user_id,batch_code) values($1,$2),($3,$4)',
    [people.teacher, '25cs', people.otherTeacher, '26cs']);

  await actor('alice');
  let context = await rpc('context');
  assert.equal(context.role, 'student', 'editable Auth role metadata cannot create teacher authority');
  assert.deepEqual(context.students, []);
  await denies(() => query("insert into public.teacher_permissions(user_id,batch_code) values($1,'25cs')", [people.alice]), '42501', 'student cannot self-promote');
  await denies(() => query("update public.batch_permissions set status='approved' where user_id=$1", [people.pending]), '42501', 'student cannot approve class membership');
  await denies(() => create({ audience: 'class', batch_id: '25cs' }), 'PT403', 'student cannot assign class work');
  await actor('teacher');
  context = await rpc('context');
  assert.equal(context.role, 'teacher');
  assert.deepEqual(context.batches, [{ id: '25cs', label: '25CS' }]);
  assert.deepEqual(context.students.map(student => student.id).sort(), [people.alice, people.bob].sort());
  await denies(() => create({ audience: 'class', batch_id: '26cs' }), 'PT403', 'teacher cannot assign another class');
  await denies(() => create({ audience: 'student', batch_id: '25cs', assigned_to: people.pending }), 'PT403', 'pending member is not a recipient');
  await denies(() => create({ audience: 'student', batch_id: '25cs', assigned_to: people.teacher }), 'PT403', 'teacher is not a student recipient');

  const request = randomUUID();
  const classTask = await create({ audience: 'class', batch_id: '25cs' }, request);
  assert.equal(classTask.created_by, people.teacher);
  assert.equal(classTask.recipient_count, 2);
  assert.equal(classTask.completed_count, 0);
  assert.equal((await create({ audience: 'class', batch_id: '25cs' }, request)).id, classTask.id);
  await admin();
  assert.equal(await count('tasks'), 1);
  assert.equal(await count('task_recipients'), 2);
  assert.equal(await count('task_notifications'), 2, 'retry must not duplicate assignment notifications');
  console.log('PASS SQL migration, role verification, roster scope, class fan-out and idempotency');

  await actor('alice');
  assert.equal((await rpc('list')).length, 1);
  assert.equal((await query('select * from public.task_recipients')).rows.length, 1);
  let notes = await rpc('notifications');
  assert.equal(notes.unread_count, 1);
  const aliceNote = notes.notifications[0].id;
  await denies(() => edit(classTask.id, { title: 'Student tampering' }), 'PT404', 'student cannot edit assigned details');
  await denies(() => rpc('delete', [classTask.id], ['uuid']), 'PT404', 'student cannot delete teacher assignment');
  await denies(() => query("update public.tasks set title='tampered' where id=$1", [classTask.id]), '42501', 'direct task write denied');
  await denies(() => query("update public.task_recipients set status='completed' where task_id=$1", [classTask.id]), '42501', 'direct recipient write denied');
  await denies(() => query("insert into public.task_notifications(user_id,task_id,batch_id,title,message) values($1,$2,'25cs','Forged','Forged')", [people.alice, classTask.id]), '42501', 'forged notifications denied');
  await denies(() => query("delete from public.task_notifications where id=$1", [aliceNote]), '42501', 'direct notification deletion denied');
  let complete = await rpc('status', [classTask.id, 'completed'], ['uuid', 'text']);
  assert.equal(complete.status, 'completed');
  assert(complete.completed_at);
  assert.equal(complete.user_id, people.alice);
  assert.equal(complete.recipient_count, null, 'student cannot see whole-class progress counts');
  await actor('bob');
  assert.equal((await rpc('list'))[0].status, 'pending');
  notes = await rpc('notifications');
  const bobNote = notes.notifications[0].id;
  await denies(() => rpc('read_notification', [aliceNote], ['uuid']), 'PT404', 'student cannot mark another notification read');
  assert.equal((await rpc('read_notification', [bobNote], ['uuid'])).read, true);
  assert.equal((await rpc('notifications')).unread_count, 0);
  await actor('alice');
  assert.equal((await rpc('notifications')).unread_count, 1, 'other notification stays unread');
  await actor('teacher');
  assert.equal((await rpc('list'))[0].completed_count, 1);
  await denies(() => rpc('status', [classTask.id, 'completed'], ['uuid', 'text']), 'PT403', 'teacher cannot set recipient progress');
  assert.equal((await query('select * from public.task_recipients')).rows.length, 2);
  assert.equal((await rpc('notifications')).unread_count, 0, 'teacher has no student notification inbox');
  await denies(() => query("update public.tasks set title='Direct teacher edit' where id=$1", [classTask.id]), '42501', 'teacher table writes also denied');
  await actor('pending');
  assert.deepEqual(await rpc('list'), []);
  assert.equal((await rpc('notifications')).unread_count, 0);
  assert.equal((await query('select * from public.tasks')).rows.length, 0);
  await actor('otherTeacher');
  assert.deepEqual(await rpc('list'), []);
  await denies(() => edit(classTask.id), 'PT404', 'other teacher cannot edit assignment');
  await denies(() => rpc('delete', [classTask.id], ['uuid']), 'PT404', 'other teacher cannot delete assignment');
  console.log('PASS SQL direct-write restrictions, per-student completion, RLS visibility and notification ownership');

  await actor('alice');
  const personal = await create({ title: 'Personal revision' });
  assert.equal(personal.assigned_to, people.alice);
  assert.equal(personal.audience, 'personal');
  assert.equal((await edit(personal.id, { title: 'Edited personal task' })).title, 'Edited personal task');
  complete = await rpc('status', [personal.id, 'completed'], ['uuid', 'text']);
  assert.equal(complete.status, 'completed'); assert(complete.completed_at);
  const reopened = await rpc('status', [personal.id, 'in_progress'], ['uuid', 'text']);
  assert.equal(reopened.status, 'in_progress'); assert.equal(reopened.completed_at, null);
  await actor('bob');
  assert(!(await rpc('list')).some(row => row.id === personal.id));
  assert.equal((await query('select * from public.tasks where id=$1', [personal.id])).rows.length, 0);
  await denies(() => rpc('status', [personal.id, 'completed'], ['uuid', 'text']), 'PT404', 'foreign personal status denied');
  const bobPersonal = await create({ title: 'Bob private revision' });
  await actor('teacher');
  assert(!(await rpc('list')).some(row => row.id === bobPersonal.id), 'teacher cannot read student personal tasks');
  const teacherPersonal = await create({ title: 'Teacher private task' });
  const single = await create({ title: 'Alice-only project', audience: 'student', batch_id: '25cs', assigned_to: people.alice });
  assert.equal(single.recipient_count, 1);
  await actor('alice');
  assert((await rpc('list')).some(row => row.id === single.id));
  await actor('bob');
  assert(!(await rpc('list')).some(row => row.id === single.id));
  assert(!(await rpc('notifications')).notifications.some(note => note.task_id === single.id));
  await denies(() => rpc('status', [single.id, 'completed'], ['uuid', 'text']), 'PT404', 'unintended student cannot update assignment');
  await actor('alice');
  assert.equal((await rpc('delete', [personal.id], ['uuid'])).deleted, true);
  assert(!(await rpc('list')).some(row => row.id === personal.id));
  console.log('PASS SQL private personal CRUD, reopen and targeted assignment visibility');

  await actor('teacher');
  const invalidChanges = [
    { title: '' }, { estimated_minutes: 0 }, { estimated_minutes: true }, { estimated_minutes: 10081 },
    { due_at: '2026-11-25T09:00' }, { due_at: '2026-02-30T09:00:00Z' },
    { due_at: 'infinity' }, { priority: 'admin' }, { task_type: 'unknown' },
    { title: 'x'.repeat(201) }, { description: 'x'.repeat(5001) },
    { subject: 'x'.repeat(121) }, { created_by: people.bob },
    { audience: 'class', batch_id: '25cs', status: 'completed' }
  ];
  for (const changes of invalidChanges) await denies(() => create(changes), 'PT400', 'SQL validates ' + Object.keys(changes).join(','));
  await denies(() => rpc('status', [teacherPersonal.id, 'cancelled'], ['uuid', 'text']), 'PT400', 'invalid status denied');
  await denies(() => rpc('edit', [single.id, JSON.stringify({ ...data(), audience: 'class' })], ['uuid','jsonb']), 'PT400', 'audience immutable through edit RPC');
  await admin();
  const beforeEmpty = await count('tasks'), beforeNotes = await count('task_notifications');
  await actor('otherTeacher');
  await denies(() => create({ audience: 'class', batch_id: '26cs' }), 'PT400', 'empty-class assignment rejected');
  await admin();
  assert.equal(await count('tasks'), beforeEmpty, 'failed fan-out rolls parent task back');
  assert.equal(await count('task_notifications'), beforeNotes, 'failed fan-out creates no notifications');
  await denies(() => query(`insert into public.tasks(request_id,created_by,assigned_to,audience,title,task_type,priority)
    values($1,$2,null,'personal','Invalid null owner','personal_task','medium')`, [randomUUID(), people.alice]), '23514', 'CHECK cannot accept a NULL personal assignee');
  console.log('PASS SQL field constraints and rollback of empty class assignment');

  await actor('teacher');
  assert.equal((await rpc('delete', [single.id], ['uuid'])).deleted, true);
  await actor('alice');
  notes = await rpc('notifications');
  assert(notes.notifications.some(note => note.task_id === null), 'deleted task retains historical notification with null link');
  await admin();
  await query("update public.batch_permissions set status='rejected' where user_id=$1", [people.alice]);
  await actor('alice');
  assert(!(await rpc('list')).some(row => row.id === classTask.id));
  assert.equal((await query('select * from public.task_recipients')).rows.length, 0);
  assert.equal((await rpc('notifications')).notifications.length, 0, 'revoked membership hides historical notifications too');
  await denies(() => rpc('status', [classTask.id, 'pending'], ['uuid', 'text']), 'PT404', 'removed student cannot update progress');
  await admin();
  await query('delete from public.teacher_permissions where user_id=$1', [people.teacher]);
  await actor('teacher');
  context = await rpc('context'); assert.equal(context.role, 'student');
  const retained = await rpc('list');
  assert(!retained.some(row => row.id === classTask.id), 'revoked teacher loses assignment access');
  assert(retained.some(row => row.id === teacherPersonal.id), 'own personal task remains private and accessible');
  await denies(() => edit(classTask.id), 'PT404', 'revoked teacher cannot edit assignment');
  await denies(() => rpc('delete', [classTask.id], ['uuid']), 'PT404', 'revoked teacher cannot delete assignment');
  await actor('bob');
  assert((await rpc('list')).some(row => row.id === classTask.id), 'intended student retains legitimate historical work');
  await actor('pending', 'anon');
  await denies(() => rpc('context'), '42501', 'anonymous role cannot execute task RPC');
  await denies(() => query('select * from public.tasks'), '42501', 'anonymous role cannot read task table');
  await denies(() => query('select * from public.task_notifications'), '42501', 'anonymous role cannot read notifications');
  console.log('PASS SQL membership/teacher revocation, historical notifications and anonymous denial');

  // Run onboarding templates after all original RLS tests so fixtures do not affect them.
  const teacherTemplate = fs.readFileSync(path.resolve(__dirname, '../database/provision_teacher.sql'), 'utf8');
  const studentTemplate = fs.readFileSync(path.resolve(__dirname, '../database/approve_student.sql'), 'utf8');
  // Change the declaration only; keep each template's placeholder-refusal guard intact.
  const teacherOnboarding = teacherTemplate.replace('REPLACE_WITH_TEACHER_EMAIL', 'TEACHER@EXAMPLE.TEST');
  const studentOnboarding = studentTemplate.replace('REPLACE_WITH_STUDENT_EMAIL', 'PENDING@EXAMPLE.TEST');
  await admin();
  await denies(() => db.exec(teacherTemplate), 'P0001', 'teacher placeholder must refuse execution');
  await denies(() => db.exec(studentTemplate), 'P0001', 'student placeholder must refuse execution');
  await denies(() => db.exec(teacherTemplate.replace('REPLACE_WITH_TEACHER_EMAIL', 'missing@example.test')), 'P0001', 'teacher Auth account must already exist');
  await denies(() => db.exec(studentTemplate.replace('REPLACE_WITH_STUDENT_EMAIL', 'missing@example.test')), 'P0001', 'student Auth account must already exist');
  await actor('pending');
  await denies(() => db.exec(teacherOnboarding), 'P0001', 'authenticated student cannot run teacher onboarding');
  await denies(() => db.exec(studentOnboarding), 'P0001', 'authenticated student cannot approve membership');
  await admin();
  assert.equal((await query('select * from public.teacher_permissions where user_id=$1', [people.teacher])).rows.length, 0);
  assert.equal((await query('select status from public.batch_permissions where user_id=$1', [people.pending])).rows[0].status, 'pending');
  await db.exec(teacherOnboarding);
  await db.exec(teacherOnboarding);
  assert.equal((await query('select * from public.teacher_permissions where user_id=$1 and batch_code=$2', [people.teacher, '25cs'])).rows.length, 1, 'teacher onboarding is idempotent');
  await actor('teacher');
  context = await rpc('context');
  assert.equal(context.role, 'teacher');
  assert.deepEqual(context.batches, [{ id: '25cs', label: '25CS' }]);
  await admin();
  await db.exec(studentOnboarding);
  await db.exec(studentOnboarding);
  const enrollment = (await query('select * from public.batch_permissions where user_id=$1', [people.pending])).rows;
  assert.equal(enrollment.length, 1, 'existing membership is updated rather than duplicated');
  assert.equal(enrollment[0].status, 'approved');
  assert.equal(enrollment[0].batch_code, '25cs');
  assert(enrollment[0].approved_at);
  await actor('pending');
  context = await rpc('context');
  assert.equal(context.role, 'student', 'student approval cannot create teacher permissions');
  assert.deepEqual(context.batches, [{ id: '25cs', label: '25CS' }]);
  await admin();
  await denies(() => db.exec(studentTemplate.replace('REPLACE_WITH_STUDENT_EMAIL', 'teacher@example.test')), 'P0001', 'teacher account cannot be enrolled through the student template');
  assert.equal((await query('select * from public.batch_permissions where user_id=$1', [people.teacher])).rows.length, 0);
  await actor('teacher');
  assert.equal((await rpc('context')).role, 'teacher', 'rejected student enrollment preserves teacher authority');
  console.log('PASS SQL administrator onboarding guards, placeholders, idempotency, approved membership and role separation');
  console.log('All ephemeral PostgreSQL task/RLS checks passed; no live Supabase records were touched.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await db.close(); });
