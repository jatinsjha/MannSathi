# Existing Supabase schema review — 24 November 2026

Source: the user ran `database/inspect_calendar_schema.sql` in the Supabase SQL editor and supplied the single `schema_review` result. No student records were read. Agent network inspection was unavailable; these findings rely on that supplied export.

Public tables are `profiles` and `batch_permissions` only. No existing calendar/event table was present, so the proposed `calendar_events` table does not duplicate an existing module.

## Profiles

Columns: `id` UUID (primary key, foreign key to `auth.users` with cascading deletion), `full_name` text, and `created_at`/`updated_at` timestamptz. There are no role, teacher, batch, or approval fields.

RLS is enabled. The two authenticated policies allow selecting and updating only the row where `auth.uid() = id`; the update policy also checks that condition on the resulting row. There is no INSERT policy or profile trigger in the supplied schema. Existing signup saves the name in Auth metadata, and the workspace already reads that metadata. Calendar references `auth.users` directly and does not require a profile row.

Both `anon` and `authenticated` have broad table grants including TRUNCATE, REFERENCES, and TRIGGER. PostgreSQL RLS does **not** cover TRUNCATE. While normal PostgREST CRUD does not expose TRUNCATE as an endpoint, this privilege is unnecessary and should be removed.

Smallest proposed fix: `database/migrations/000_profile_privileges.sql` revokes all profile table privileges from `anon` and revokes TRUNCATE/REFERENCES/TRIGGER from `authenticated`. Existing authenticated owner SELECT/UPDATE policies and ordinary account flows stay valid. It does not introduce profile INSERT/DELETE policies or alter batch access.

## Batch permissions

Columns: UUID `id`, `user_id` (unique foreign key to `auth.users`), `batch_code` constrained to `25cs`, status constrained to pending/approved/rejected (default pending), optional approving user/time, and creation time.

RLS is enabled. There are no policies or table grants for `anon`/`authenticated` in the supplied export; only `postgres` and `service_role` have privileges. This denies student access and mutation, including self-approval. There is no current student request or teacher approval flow to reuse. Calendar does not change this table or depend on approved batch membership for private personal events.

## Calendar migration and current status

`database/migrations/001_smart_calendar.sql` adds the private event table, constraints, timestamps/immutability trigger, owner indexes, restricted column grants, and owner-only RLS. It does not add tasks, focus sessions, progress tables, teacher permissions, or AI actions.

The user subsequently confirmed migrations 000/001 are applied. This document records the original baseline review; do not rerun those migrations. Task Manager adds migration 002 with administrator-managed teacher permissions, tasks, recipients and notifications; see [task-manager.md](task-manager.md). Migration 002 is still unapplied by the agent. Local PostgreSQL authorization tests and browser fixtures do not replace verification against deployed Supabase.
