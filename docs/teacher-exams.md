# Teacher scheduled exams

Teachers can open Calendar → **Assign exam**, select their class, one division (A/B/C), or one approved student, and set the exam's date, time, location and description. Whole-day and multi-day exams use the same date rules as personal calendar events. Students see the exam in Calendar and the homepage's Upcoming exams card. Their exam details are read-only. The creating teacher can edit or delete an exam while they still have permission for its class.

Apply [005_teacher_exams.sql](../database/migrations/005_teacher_exams.sql) once in Supabase after calendar migration 001 and teacher/class migrations 002/003. The script is transactional and creates a separate `calendar_exams` table and authenticated RPCs; existing personal `calendar_events` stay private. It intentionally fails if the exam table already exists. Deploy the updated static files and `/api/calendar` handler after applying the migration. No live database changes were executed during implementation.

Exam audiences follow **current approved enrollment**. Newly approved members of a class or division can see its scheduled exams. Moving division removes access to the previous division's exams; pending and rejected enrollment cannot read class exams. An individual exam requires the selected student to remain an approved member of the same class. Teacher permissions come from `teacher_permissions`, not editable profile or Auth metadata.

The browser uses `MannSathiCalendarService.listExams(start,end,timeZone)` and create/update/remove exam methods through `/api/calendar?action=exams`. List responses contain `{events:[...]}`; service methods return the event array. Rows include normal calendar fields plus `source:"teacher_exam"`, `can_edit`, `audience`, `batch_id`, `target_division`, and `assigned_to`. The database validates recipients and permissions for each operation and permits authenticated direct SELECT only through RLS. Direct writes and anonymous access are denied. The backend forwards the user's verified token and never uses a service-role key.

The calendar can continue displaying personal events when the exam schema is unavailable and displays an exam loading error with Retry. Dashboard reports the unavailable exam feed. Stored reminder preferences do not send background or email notifications.

Local verification:

```powershell
node tests/exams-sql.cjs
python -m unittest discover -s tests -p 'test_exams_api.py'
node tests/exams-browser.cjs
```

SQL checks execute the real migrations and RPCs in an ephemeral PostgreSQL database (PGlite). HTTP checks use a fake Supabase transport; browser checks use a local server with explicit test fixtures. These do not verify a deployed database. After setup, use actual teacher and student accounts to confirm class/division visibility, save/reload, edits, deletion and student read-only details. Confirm direct Supabase mutation requests are denied under the student's token.
