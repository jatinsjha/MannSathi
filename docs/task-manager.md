# Task Manager, teacher sign-in and notifications

The workspace now fills the window edge to edge, with the existing sidebar, chat, Calendar, themes and mobile drawer. Task Manager supports personal task CRUD, descriptions, subjects, task types, deadlines, estimates, priorities, completion/reopening, search, status/priority/source filters, overdue/today/upcoming lists and deadline sorting. These features use real Supabase data and do not call Gemini. Focus Room and Progress remain future modules.

## Separate student and teacher access

`index.html` is student sign-in. `teacher-login.html` is teacher sign-in. Both use the existing Supabase Auth accounts and password/reset flows. Each successful or existing session must pass `/api/tasks?action=context` before redirecting. The backend verifies the token with Supabase Auth; the database determines the role from administrator-managed `teacher_permissions`. A student choosing the teacher page, or writing `role=teacher` in editable signup metadata, never gains teacher privileges. Wrong-role sign-in closes the session and points to the correct page.

Students can sign up normally and use personal tasks. To receive class work they must already have an approved entry in the existing `batch_permissions` table. Teachers can assign only within their approved classes and can select only approved students from those classes. The initial reviewed student schema is restricted to 25CS; no existing membership constraints or approval policies are relaxed.

## Database changes and approval

The user confirmed the earlier profile fix and Calendar migrations are applied. **Do not rerun 000/001.** The new, unapplied `database/migrations/002_tasks_and_teachers.sql` creates:

- `teacher_permissions`: administrator-managed authorization per teacher and class, separate from editable profiles/Auth metadata.
- `tasks`: personal tasks or teacher assignment parents, including `created_by`, optional `assigned_to`, `batch_id`, type, deadline, estimate, priority and an idempotency UUID.
- `task_recipients`: the intended students, each with their own pending/in-progress/completed status and completion timestamp.
- `task_notifications`: private, persistent assignment notices and read timestamps.

It adds indexes, constraints, RLS and authorized RPC functions. Browser roles have no direct table mutation grants. SQL functions use `auth.uid()`, verify current class/teacher authorization, and run with a fixed search path; migration execution requires a trusted superuser/BYPASSRLS administrator because the tables force RLS. Backend requests preserve the original user's JWT. IDs supplied by a browser locate records and do not establish identity.

Assignment creation, recipient selection and notifications commit in one transaction. Retrying the same create request cannot generate another task or duplicate notifications. A class assignment snapshots approved students at creation; students enrolled later do not automatically receive earlier assignments. Recipients cannot edit/delete the teacher's task or alter another student's progress. Teachers edit/delete only their own assignments. Leaving a class or losing teacher permissions revokes the corresponding task access. Students retain their own private tasks.

Read and approve the SQL before applying it in the Supabase SQL editor. The script deliberately fails if these objects already exist; inspect/reconcile existing objects rather than ignoring conflicting schemas. It does not alter Calendar, profile policies, batch approvals, passwords or Gemini configuration.

## Onboarding teachers and students

1. Create or invite the teacher account through Supabase Auth and have them set their password. There is no public teacher self-promotion flow.
2. As an administrator, edit `database/provision_teacher.sql` with that account's email and approved class, then run it. Teacher access becomes available at `/teacher-login.html`.
3. Students use the existing signup/email-verification flow. If their 25CS membership is not already approved, an administrator edits/runs `database/approve_student.sql` for each intended student. These scripts refuse their placeholder emails and do not send emails or change passwords themselves.
4. If a signed-in account receives or loses teacher access, sign out/in or refresh the workspace so its UI context is refreshed. Permissions are enforced in every database action regardless of cached UI context.

Names in the teacher roster come from profiles or Auth name metadata, never a frontend sample roster. A teacher with no approved students sees an empty roster; the database refuses an empty-class assignment rather than claiming it was delivered.

## Notifications

Each intended student receives a database notification saying the teacher assigned work. The bell and unread badge work from Chat, Calendar or Tasks; the inbox supports marking a notice as read and opening its task. Notices and read state survive refresh and logout/login. New notices are checked on load, when opening the inbox, on tab focus, and every 30 seconds while the page is visible. A new notice produces an in-app alert. Internet access and the applied migration are required.

The inbox shows the latest 100 notices while the unread count covers all authorized notices. “Mark shown as read” affects only the displayed notices. Deleting an assignment retains its historical notice with no task link. Membership revocation also hides notices for the former class. This module sends no email, OS push notification, or background mobile notification.

## Deployment

1. Review/apply migration 002; run the administrator onboarding scripts only for the intended accounts.
2. Deploy the updated HTML/CSS/JavaScript and Python `/api/tasks` alongside the existing `/api/calendar`, `/api/chat` and `/api/config`. Keep the existing Vercel configuration and Python dependencies.
3. Keep `SUPABASE_URL` and a publishable/anon `SUPABASE_KEY` configured. No service-role key is added to frontend code or the Python task transport.
4. Add `/teacher-login.html` to Supabase Auth's allowed password-reset redirect URLs alongside the student login URL.
5. Local development remains `python local_test.py`. No frontend framework, build system or paid service was added.

Deploy the role-checked login and task backend together with the migration: missing role RPCs fail closed, so ordinary sign-in cannot redirect until account access can be verified. Existing guest chat remains usable.

## Validation

Local checks pass: all 23 Calendar/Task HTTP tests, role-login checks, date/service checks, account-change save isolation, Task Manager browser CRUD and teacher/student/notification flows, edge-to-edge layouts and dialogs at 1440/390/320px in both themes. Calendar browser regression checks pass. Screenshots are saved under ignored `.preview/tasks-screenshots/` and were visually inspected.

`tests/tasks-sql.cjs` executes the **unchanged production migration** in an ephemeral PostgreSQL engine. It tests real RLS/table grants/RPCs, role spoofing denial, class/single assignment fan-out, private progress, idempotency, empty-class rollback, notification ownership and revocation. It also executes both onboarding templates to verify placeholder/missing-account refusal, administrator-only execution, idempotency and teacher/student separation. This does not access the live Supabase database. The temporary engine is a test-only package in ignored `.preview/sql-runtime/`, not an application dependency.

```powershell
python -m unittest discover -s tests -p 'test_*_api.py' -v
node tests/login-role.cjs
node tests/authenticated-api.cjs
node tests/calendar-dates.cjs
node tests/calendar-service.cjs
node tests/tasks-browser.cjs
node tests/calendar-browser.cjs
```

Optional local PostgreSQL checks:

```powershell
npm install --prefix .preview/sql-runtime --no-audit --no-fund @electric-sql/pglite
node tests/tasks-sql.cjs
```

After applying/deploying, verify using one approved teacher, two approved 25CS students and a student outside that class: create class and single-student assignments; confirm exact recipients and notifications; complete/reopen independently; reload/sign out/in; verify teacher edits/deletes and unread state. Try direct table writes and foreign task/notification RPC IDs with student/anonymous tokens: they must fail. Confirm normal Calendar CRUD and chat still work. Live verification remains pending; no new SQL or user provisioning has been executed by the implementation agents.

## Changed files

| Files | Purpose |
| --- | --- |
| `app.html`, `css/workspace.css`, `css/modules/tasks.css` | Edge-to-edge workspace, task/assignment editor, filters, notification inbox |
| `index.html`, `teacher-login.html`, `css/auth.css`, `js/login.js` | Separate sign-in pages with backend role checks |
| `js/workspace.js`, `js/modules/calendar.js` | Shared navigation keeps only one workspace module visible |
| `js/services/authenticated-api.js`, `js/services/calendar-service.js`, `js/services/task-service.js` | Shared protected transport, session-change guards and task endpoints |
| `js/modules/tasks.js` | Personal/teacher tasks, individual progress, filters and notifications |
| `api/tasks.py`, `api/shared/tasks_validation.py`, `local_test.py` | Protected Python task API, validation and local routes |
| `database/migrations/002_tasks_and_teachers.sql` | Proposed roles/tasks/recipients/notifications migration with RLS/RPCs |
| `database/provision_teacher.sql`, `database/approve_student.sql` | Explicit administrator onboarding templates |
| `tests/test_tasks_api.py`, `tests/tasks-sql.cjs`, `tests/tasks-browser.cjs`, `tests/login-role.cjs`, `tests/authenticated-api.cjs` | HTTP, SQL authorization, UI, role and concurrent-session tests |
| `tests/calendar-browser.cjs`, `tests/calendar-service.cjs` | Regression fixtures for shared transport and role context |
| `docs/task-manager.md`, `README.md`, `docs/smart-calendar.md`, `docs/database-review.md` | Current module status, reviewed schema, deployment and verification |
