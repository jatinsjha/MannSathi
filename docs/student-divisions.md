# Student details, class enrollment and division assignments

## Confirmed cause of the empty roster

The user supplied `database/diagnose_roster.sql` output on 24 November 2026. It showed five Supabase Auth accounts, two teacher permissions for `25cs`, and **no rows in `batch_permissions`**. Existing task constraints matched migration 002. Signup only stored Auth name metadata, so registered students never entered the approved class roster. A whole-class assignment with no recipients raised a safe database validation error, but the API replaced that explanation with “This task change is invalid.”

The API now checks empty class/division scopes before writing and returns guidance to submit/review enrollment requests. It also maps only known empty-roster database messages to safe text; arbitrary PostgreSQL details remain hidden. The editor shows recipient counts and disables sending to an empty selection.

## Upgrade

Review and run **only** `database/migrations/003_student_divisions.sql` in the trusted Supabase SQL editor, then deploy the updated API/UI assets together. Do not rerun 000, 001 or 002. Migration 003 is transactional and has been tested against an ephemeral PostgreSQL database. It has not been applied to live Supabase by the agent.

Changes:

- Adds student-requested name/roll/class/division settings through protected RPCs; name stays in existing `profiles.full_name`, with new `roll_number`, `class_code` and `division` columns.
- Adds authoritative division to `batch_permissions`. Students can submit/update a **pending** enrollment request, but cannot approve it or grant teacher access.
- Adds teacher-only review/approval RPCs scoped to the teacher's approved class permissions. Existing administrator-managed `teacher_permissions` stays unchanged.
- Approval includes the division shown in the reviewed request. If the student changes it before the teacher decides, the server returns a conflict and keeps the request pending until it is refreshed/reviewed.
- Adds `target_division` to tasks and notifications, and a `division` audience. Task identity, ownership and per-student progress remain intact.
- Updates read authorization so a pending or changed division cannot reveal another division's assignments or historical notices.
- Routes profile writes through validated RPCs rather than broad direct UPDATE grants. Existing profile rows, timestamps, Calendar data, tasks and approvals are preserved.

The initial class supported by the reviewed database remains **25CS**, with divisions **A, B and C**. This migration does not silently relax the existing 25CS membership constraint or introduce other college classes.

## How students join

1. Sign in with a student account.
2. Select your name or avatar at the bottom of the sidebar, then choose **Profile**.
3. Enter full name, roll number, class 25CS and division A/B/C, then save.
4. The form shows **Pending — waiting for teacher approval**. Saving details does not approve membership.

Students can edit name and roll number without losing an unchanged approved class/division. Changing class/division submits a new pending request and temporarily removes access to class work until reviewed. Rejected requests can be corrected and resubmitted. Unsaved profile edits are preserved while moving between settings sections; closing the dialog discards unsaved edits when the next load occurs.

Roll numbers support letters, digits, spaces, slash, underscore and hyphen, up to 30 characters, starting with a letter or digit. Names support 2–100 characters. Both frontend, Python and SQL validate the data. Roll numbers are labels, not identity or authorization keys; assignment identity remains the authenticated UUID.

## How teachers approve and assign

1. Sign in with an approved teacher account and open **Notifications** using the bell. Pending enrollment requests appear here and contribute to the badge.
2. Click **Refresh roster** after students submit their details.
3. Review the requested name, roll, division and account email, then approve or reject each request. Email is shown only to authorized teachers reviewing requests for their own class.
4. Approved students and A/B/C counts update. Open **New task** and choose:
   - **Everyone in a class:** all approved 25CS students, across divisions.
   - **One division:** only approved students in A, B or C.
   - **One student:** one approved student; optionally filter the picker by division first.

Assignments snapshot the eligible recipients at creation and create their notifications in the same transaction. A student moving into B later does not gain earlier B assignments automatically; create a new assignment if that is intended. Completion/reopening remains private to each recipient. Empty selections are refused and create no partial task or notifications. Repeated create requests remain idempotent.

Approval controls are disabled during a roster refresh. If a student changes the reviewed division before the decision, approval returns a conflict; refresh the roster and review the new request. The API sends the reviewed `expected_division` to the four-argument approval RPC, which compares it with the locked membership row before writing.

Legacy approved class members with no division continue receiving whole-class assignments. They receive no division-specific assignments until their division request is approved. A deleted assignment's notice retains its original division boundary, so moving divisions cannot expose historical notices from the previous group.

## Settings sections

- **Appearance:** existing dark/light theme and chat-history controls.
- **Student details:** persistent name, roll, class, division and approval status.
- **Account:** own verified account email/type and a user-triggered password-reset email.

Teacher accounts see Appearance/Account; they cannot use student settings to change their permissions or enroll themselves as students. Guest browsing cannot read or save private details. The sidebar uses the saved profile name after save and on subsequent reload/login.

## Validation and live verification

Completed local checks: 34 Python HTTP tests, unchanged migration 002 plus migration 003 executed in ephemeral PostgreSQL with actual RLS/RPC assertions, and an end-to-end browser flow starting with zero enrolled students. Checks cover pending requests, teacher approvals, stale division-review denial, all 25CS/A/B/C/individual scopes, independent progress, notifications, name persistence, invalid input, direct-write denial, class isolation, rejected requests, division moves, legacy membership and anonymous denial. Browser checks include settings and assignment dialogs at 1440/390/320px in both themes; screenshots were inspected.

```powershell
python -m unittest discover -s tests -p 'test_*_api.py' -v
node tests/divisions-sql.cjs
node tests/divisions-browser.cjs
```

The SQL test uses the existing ignored `.preview/sql-runtime` PGlite test package; no application dependency or paid service was added. Production remains static HTML/CSS/JavaScript, Python, Supabase and Vercel. No AI action is used by settings or assignments.

After applying 003 and deploying, repeat the workflow with the actual student/teacher accounts. A schema upgrade alone does not invent enrollments: students must save their details and teachers must approve them. Confirm the approved/division counts and recipients, and check that a student cannot approve their own request, edit another student's profile/progress, or see another division's tasks. Live verification is still pending.

## Changed files

| Files | Purpose |
| --- | --- |
| `api/tasks.py`, `api/shared/tasks_validation.py` | Settings/review routes, division targets and actionable safe error messages |
| `app.html`, `css/modules/tasks.css`, `css/modules/settings.css` | Settings sections, teacher roster/review and division controls |
| `js/modules/settings.js`, `js/modules/tasks.js`, `js/services/task-service.js`, `js/app.js` | Profile persistence, approvals, recipient counts/filters and saved sidebar names |
| `database/migrations/003_student_divisions.sql` | Proposed profile/enrollment/division schema and authorization upgrade |
| `database/diagnose_roster.sql` | Read-only schema/count diagnostics |
| `tests/test_settings_api.py`, `tests/divisions-sql.cjs`, `tests/divisions-browser.cjs` | HTTP, actual SQL/RLS and end-to-end coverage |
| `docs/student-divisions.md`, `docs/task-manager.md`, `README.md` | Diagnosis, migration and workflow instructions |
