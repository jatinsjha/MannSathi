# Smart Calendar: implementation and deployment

This guide records the Calendar implementation. Task Manager, separate teacher/student sign-in and assignment notifications have now been added; see [task-manager.md](task-manager.md). The user confirmed Calendar/profile migrations 000/001 are applied. Focus Room, progress statistics and AI calendar actions remain future work.

## Existing architecture and reuse

The repository serves static HTML/CSS/vanilla JavaScript, with Python handlers in `api/` deployed by Vercel. `index.html` and `signup.html` use the Supabase CDN SDK through `js/supabase.js` and `/api/config`. `app.html` loads the current chat workspace from `js/app.js`; `/api/chat` validates conversations and calls Gemini. Chat history is stored in this browser's localStorage. The active styles are `css/auth.css`, `css/account.css`, `css/workspace.css`, and their shared `css/cosmic.css` palette. Older CSS files and the unused root `login.js` are left intact.

Calendar reuses the workspace, theme, dialogs, mobile drawer, Supabase initialization, and existing account flows. New date utilities, a service, and a UI module keep calendar logic separate from chat. Opening Chat, New chat, a history item, or Ctrl/Cmd+K returns to the existing conversation workspace.

## Security findings and smallest fixes

Previously `/api/config` returned any configured `SUPABASE_KEY`. It now accepts only an `sb_publishable_` key or a legacy JWT whose key role is `anon`, and rejects secret/service-role keys before returning configuration. This key-type check does **not** authenticate students.

Every calendar request verifies the Bearer token through Supabase `/auth/v1/user`. The returned identity owns new events; ownership fields supplied in a request body are rejected. Reads, edits, and deletes filter by both the verified owner and (when applicable) event ID. Requests to PostgREST use the original student's Bearer token plus the public key, preserving RLS. Missing or foreign event IDs return the same 404. Responses and credentials are never cached in the calendar service. Calendar records are not saved to localStorage. Visible events are cleared on account changes.

Existing guest chat and its public API remain available. Existing chat history is browser-wide, not account-scoped, and chat requests are not tied to Supabase identity. These are existing limitations, not authorization for calendar access. No profile or batch permissions are assumed to establish identity. No student permission-approval path is added.

## Database proposal: review before applying

The repository originally had no database schema or RLS migrations. The user supplied the full read-only output of `database/inspect_calendar_schema.sql`; the review is recorded in [database-review.md](database-review.md). It confirms only `profiles` and `batch_permissions` exist and there is no event table. Profile policies limit ordinary reads/updates to the owner; batch permissions deny student access and self-approval. Profile grants include unnecessary TRUNCATE privileges, which RLS does not cover. The separate proposed `database/migrations/000_profile_privileges.sql` removes anonymous profile privileges and authenticated structural privileges without changing the existing owner policies.

`database/migrations/001_smart_calendar.sql` is a **proposed, unapplied** migration matching the supplied schema. Review and approve both scripts before applying them, 000 then 001. It intentionally fails if `calendar_events` already exists. It creates only:

- `calendar_events`: UUID ID; `user_id` referencing `auth.users`; title/description/category/location; all-day flag; UTC `starts_at`/`ends_at` for timed events; `start_date`/exclusive `end_date` for all-day events; IANA `time_zone`; optional `reminder_minutes`; created/updated timestamps.
- Mode and range constraints, text limits, categories, reminder choices, and owner/date indexes.
- A trigger validating the timezone and preserving ID, owner, and creation time while updating `updated_at`.
- Owner-only SELECT/INSERT/UPDATE/DELETE RLS policies, plus a restrictive owner boundary; no access for `anon`. Authenticated clients cannot update identity/ownership/timestamp columns. RLS remains enforced for frontend direct Supabase calls as well as the backend.

The calendar migration does not change `profiles`, `batch_permissions`, or their policies. The separate profile privilege script addresses the confirmed grant issue. Nothing in this change approves batch access or introduces teacher privileges.

## Time, overlaps, reminders, and error behavior

Timed values are converted from the browser's current local timezone to UTC. They render in the viewer's current local timezone. The editor shows that timezone and notes the original event timezone when different. Nonexistent local times at a daylight-saving change are rejected; an unchanged time preserves the original instant during an edit, including repeated-hour cases. Day queries use the student's IANA timezone on the backend, so DST days can be 23 or 25 hours.

All-day values remain dates across timezones. The form's inclusive last day becomes an exclusive end boundary in the database. Events ending exactly at midnight do not appear on the following day. Overnight and multi-day events appear on every date they intersect.

Overlaps are allowed and marked rather than discarded. Month cells scroll to show all events; week/day use chronological event stacks. The editor shows an overlap warning for events in the currently loaded calendar and upcoming range. This is advisory; conflicts outside those ranges are not exhaustively checked. The backend validates ranges independently.

Reminder preferences persist with each event. **No push, email, or background notifications are sent in Module 1.** The stored offset and timezone are the foundation for a later notification worker; for all-day reminders that worker should define a local delivery time explicitly.

The calendar loads its visible range and today's next 30 days. Navigation uses fresh server data and manual Refresh is available. Loading, empty, missing-schema, expired-session, denied-access, validation, offline, and retry states are explicit. Only confirmed server writes close the editor. After an ambiguous timeout, refresh before resubmitting to check whether the original write succeeded.

## Deployment

1. Review the supplied schema findings and both proposed SQL scripts. Rerun inspection if the schema has since changed.
2. After approval, apply 000 (profile privileges) then 001 (calendar) in the Supabase SQL editor. Each is transactional.
3. Configure `SUPABASE_URL` and a **publishable/anon** `SUPABASE_KEY` in Vercel and local `.env`. Keep Gemini credentials in the backend. Never use a service-role/secret key as `SUPABASE_KEY`.
4. Install `requirements.txt`. The added `tzdata` package makes IANA timezone handling work consistently on Windows and Vercel. No frontend build or framework is introduced.
5. Deploy static assets and the Python `/api/calendar` function alongside `/api/chat` and `/api/config` using the existing Vercel setup.
6. For local development, use Python 3.12, `pip install -r requirements.txt`, then `python local_test.py`. The server routes calendar GET/POST/PATCH/DELETE as well as the existing endpoints.

## Verification and limits

Completed local validation on 24 November 2026: all 11 Python HTTP integration tests passed; date and service tests passed; Calendar browser CRUD/navigation/validation, reload and logout/login persistence against the test server, account isolation, guest denial, offline/expired-session recovery, both themes, and 1440/390/320px layouts passed. Screenshots were visually inspected. Existing login/signup/chat/history/breathing/mobile regression checks also passed, together with syntax, asset-reference, and whitespace checks. Chrome required an approved execution outside the filesystem sandbox because its renderer did not respond within the sandbox.

Local automated checks:

```powershell
python -m unittest discover -s tests -p 'test_calendar_api.py'
node tests/calendar-dates.cjs
node tests/calendar-service.cjs
node tests/calendar-browser.cjs
git diff --check
```

Browser tests launch headless Chrome (override its path with `CHROME_PATH` if necessary), serve fixtures only in a test HTTP server, and save screenshots under ignored `.preview/calendar-screenshots/`. Production has no fixtures or demo fallback. Backend tests exercise the real Python handler with a controlled Supabase transport. These verify application behavior; they do not establish that deployed PostgreSQL RLS is configured correctly.

After the migration and deployment, verify against actual Supabase using two separate student accounts:

1. With account A, create timed, overnight, multi-day all-day, and overlapping events with categories, location, descriptions, and reminder offsets. Reload and log out/in; verify all values persist. Edit and delete events, including cancelling deletion.
2. With account B, verify A's records are absent. Request A's event ID through PATCH/DELETE: expect 404. Make direct PostgREST requests with B's token as well: SELECT/PATCH/DELETE for A's event must return no records; inserting a row owned by A must fail. Anonymous direct requests must fail.
3. Verify invalid ranges/mixed all-day and timed boundaries fail in both API and direct database writes, and owner changes fail. Never send access tokens in chat or commit them.
4. Check day/week/month, Today/previous/next, today's schedule, upcoming events, DST dates, different browser timezones, both themes, mobile menu, and the editor at 320px, 390px, and desktop widths.
5. Expire a session, disconnect the network, and check loading/errors/retry. Verify no other account's events remain visible after switching accounts.
6. Confirm login/signup/email verification and existing guest/signed-in chat still work with the deployed configuration.

The supplied live schema has been reviewed. Live CRUD, persistence across authentication, database constraints, and RLS verification remain pending until the SQL is approved/applied and the app deployed. No database changes have been executed. Do not describe fixture tests as live database verification.

## Changed files

| File | Purpose |
| --- | --- |
| `app.html` | Calendar entry, view controls, event editor, confirmation dialogs, scripts/styles |
| `css/modules/calendar.css` | Scoped calendar layout using existing themes and responsive rules |
| `js/utils/date-utils.js` | Local date/UTC conversion, view ranges, overlap and day membership |
| `js/services/calendar-service.js` | Authenticated calendar HTTP requests and error handling |
| `js/modules/calendar.js` | Views, CRUD, schedule summaries, validation, account clearing |
| `api/calendar.py` | Protected Python calendar endpoints |
| `api/shared/__init__.py` | Shared Python package |
| `api/shared/supabase.py` | Key-type guard, verified auth, owner-filtered Supabase requests |
| `api/shared/validation.py` | Deterministic event/date/timezone validation |
| `api/config.py` | Prevent secret/service-role keys reaching the browser |
| `local_test.py` | Calendar routing in local Python server |
| `requirements.txt`, `pyproject.toml` | Timezone data dependency |
| `database/inspect_calendar_schema.sql` | Read-only schema and policy review |
| `database/migrations/000_profile_privileges.sql` | Proposed fix for confirmed overly broad profile grants |
| `database/migrations/001_smart_calendar.sql` | Proposed owner-protected event table migration |
| `tests/test_calendar_api.py` | Backend contract, auth, ownership, validation/error tests |
| `tests/calendar-dates.cjs`, `tests/calendar-service.cjs` | Date and HTTP service checks |
| `tests/calendar-browser.cjs` | UI interactions, test-server persistence, responsive checks |
| `docs/smart-calendar.md`, `docs/database-review.md`, `README.md` | Architecture, reviewed schema, security, SQL and deployment instructions |

