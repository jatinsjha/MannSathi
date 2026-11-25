# Focus Room and teacher Notifications

Focus Room adds private student subjects, configurable Pomodoros, optional task links, session history and study statistics. Teacher enrollment requests now appear inside **Notifications**, with pending requests included in the bell badge. They are absent from Tasks. Approval still checks the reviewed division against the locked request, and the inbox refreshes when opened and every 30 seconds while the page is visible.

## Database setup

The earlier supplied schema/count diagnostic confirmed the Task Manager baseline, migration 002. The user confirmed 000/001 are already applied. Check whether **003_student_divisions.sql** has been applied; it is needed for student details/divisions and teacher enrollment review. Do not rerun earlier migrations that are already installed.

Before adding Focus storage, run the read-only **database/inspect_focus_schema.sql** in the Supabase SQL editor. It returns table/function presence and policies without student records. This implementation creates `study_subjects`, `focus_preferences`, `focus_sessions` and `focus_segments`. If those names already exist, inspect their definitions before proceeding. The migration uses transactional CREATE statements and fails rather than replacing an unexpected table.

Review **database/migrations/004_focus_subjects.sql**, then run it once as a trusted Supabase SQL administrator after 003. It adds:

- Private subjects with color, archive status and optional weekly minute goals.
- Per-student focus/break duration, cycle, automatic-transition and sound preferences.
- Timestamp-based focus sessions, limited to one running or paused session per student.
- Actual running intervals, allowing daily/weekly totals to split correctly across local midnight and daylight-saving changes.
- Owner-only SELECT policies with restrictive boundaries and forced RLS; direct client table writes are denied. Authenticated RPCs validate the student and every subject/task/session owner.

No agent has applied migration 004 to live Supabase. Deploy the frontend and Python API together after the database upgrade. No new environment variables or paid services are required. `SUPABASE_KEY` remains a browser-safe publishable/anon key; protected requests retain the user's verified JWT.

## What students can do

Open **Focus Room**, add a subject, optionally set a weekly goal, select a related pending task and start studying. Defaults are 25-minute focus, 5-minute short break and 15-minute long break after four completed focus blocks. Durations, cycle count, automatic transitions and sound are configurable; sound is opt-in and starts only after a user gesture.

Pause stops time accrual. Resume starts a new running interval. **Finish early** saves the actual time studied as an interrupted session. **Reset → Discard session** excludes that session's time. Archiving a subject preserves its history; a subject with an active session must be ended before it can be archived.

Completed and interrupted sessions contribute to total/daily/weekly/subject time; only completed sessions count as completed Pomodoros. Running, paused, cancelled and break intervals are excluded from saved study totals. Statistics update after a server-confirmed outcome. The dashboard includes fourteen daily bars, weekly subject time compared with goals, accessible data tables, recent history, upcoming-task suggestions and break guidance. The subject chart shows up to twelve subjects; its table includes all subjects.

Recorded minutes show effort, not academic understanding. Suggestions compare a student's own goals and deadlines with their saved time; they do not invent grades, productivity scores, weaknesses or health diagnoses. Practice questions, recall and feedback help students decide what still needs work.

## Timer recovery and counting

The server stamps session start/resume times, calculates actual running seconds, and caps a naturally completed session at its planned duration. The browser redraws from the server deadline and a monotonic clock; it does not decrement a counter to measure study time. An unconfirmed start retry reuses the same session UUID. Repeated terminal transitions preserve the recorded outcome.

Refreshing or returning to the tab reads the authoritative session. Opening another tab cannot create a second active study session. A running session continues toward its one planned deadline while the page is closed; a paused session remains paused. This records timer duration, not proof that the student was physically studying throughout it.

Breaks and a small per-user cycle/selection cache use browser storage, never study statistics. An automatic next study block begins only during a visible ongoing timer flow. Recovered/expired breaks and hidden-page breaks do not backfill new study cycles. If saving fails, the timer stays at zero with retry guidance rather than presenting fabricated saved minutes. Account changes clear private subjects, timer fields, history and graphs from the page.

## Verification

Local checks include Python HTTP contracts (`tests/test_focus_api.py`), real PostgreSQL RPC/RLS tests (`tests/focus-sql.cjs`), clock tests (`tests/focus-clock.cjs`), browser fixtures (`tests/focus-browser.cjs`) and teacher enrollment inbox regressions (`tests/divisions-browser.cjs`). Browser fixtures never contact live Supabase. Run:

```text
python -m unittest discover -s tests -p "test_*_api.py"
node tests/focus-sql.cjs
node tests/focus-clock.cjs
node tests/focus-browser.cjs
node tests/divisions-browser.cjs
```

The SQL harness uses an ephemeral PGlite installation under `.preview/sql-runtime/node_modules/@electric-sql/pglite`, or a module path provided through `PGLITE_MODULE_PATH`. Browser checks require Chrome or `CHROME_PATH` and include 1440/390/320px layouts in both themes. These development tools are not production dependencies.

After deployment, verify with two real student accounts and a provisioned teacher: create a subject, start/pause/resume a session, reload, save early, discard another and confirm only intended time appears. Check cross-account isolation and teacher denial. Submit student details and approve them from the teacher bell. Live setup and verification remain pending until the migration is applied and these real-account checks are performed.

Local verification on 25 November 2026 passed: all 39 Python API tests, Focus PostgreSQL/RLS and midnight/DST checks, timestamp clock checks, teacher inbox browser regressions, Focus browser workflows including configurable long breaks and expired-break recovery, and existing authentication/login/Calendar utilities. Screenshots of the timer, graphs and teacher inbox were inspected in both themes, including phone widths. Static syntax, page IDs, asset references and whitespace checks also passed.

## Changed files

| Area | Files |
| --- | --- |
| Interface | `app.html`, `css/modules/focus.css`, `css/modules/tasks.css` |
| Browser behavior | `js/modules/focus.js`, `js/modules/tasks.js`, `js/services/focus-service.js`, `js/utils/focus-clock.js`, `js/workspace.js` |
| Python API/local routing | `api/focus.py`, `api/shared/focus_validation.py`, `api/tasks.py`, `local_test.py` |
| Database | `database/migrations/004_focus_subjects.sql`, `database/inspect_focus_schema.sql` |
| Documentation | `README.md`, `docs/focus-room.md`, `docs/task-manager.md`, `docs/student-divisions.md` |
| Verification | `tests/browser-driver.cjs`, `tests/focus-browser.cjs`, `tests/focus-clock.cjs`, `tests/focus-sql.cjs`, `tests/test_focus_api.py`, `tests/divisions-browser.cjs` |
