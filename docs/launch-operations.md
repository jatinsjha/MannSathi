# Launching the adult AI pilot

Calendar, Tasks, Focus and other academic tools can operate while AI is closed. Enable Gemini chat only for a deployment whose intended and likely audience satisfies the Gemini API age and regional requirements. If this deployment is directed to children or likely to be accessed by under-18s as an API client, leave its Gemini credentials unconfigured. Review the audience and the applicable terms before inviting adults. [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) · [Available regions](https://ai.google.dev/gemini-api/docs/available-regions)

## Deploy the controls

1. Use an isolated staging Supabase project and matching Vercel Preview environment. Run the read-only schema inventory to determine which migrations are installed. Confirm a usable backup and test restore for the database you intend to upgrade. [Schema inventory](../database/inspect_ai_schema.sql)
2. Apply missing migrations in sequence with the trusted Supabase SQL Editor role. Migration 009 repairs the report transaction. Migration 010 starts an empty pilot allowlist, closes guest AI and revokes the old AI admission and admin gate RPCs. Existing explicit global limits carry forward, and missing limits receive finite defaults. Old builds lose AI access during the rollout. Migration 011 is the independent private support inbox. [Migration 009](../database/migrations/009_ai_report_transaction.sql) · [Migration 010](../database/migrations/010_ai_launch_controls.sql) · [Support setup](help-and-support.md)
3. Enable TOTP **enrollment and verification** in Supabase Authentication → Multi-factor authentication. Using a trusted SQL Editor account, provision the verified owner's Auth UUID in `public.ai_admins` following the administration guide. Supervise first sign-in and authenticator enrollment before distributing access. Sign out, sign back in, then verify a fresh authenticator code. A password-only admin request returns HTTP 403 with `code=mfa_required`. Valid MFA for a non-admin account still returns 403. Revoke lost access by removing that verified account's admin membership, then follow the project's verified-owner factor recovery procedure. [Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa) · [Owner provisioning](ai-administration.md)
4. Configure `SUPABASE_URL`, browser-safe `SUPABASE_KEY` and server-only `SUPABASE_SERVICE_ROLE_KEY` for the same project. Deploy the complete repository as one Vercel revision. Protect or retire old deployment URLs and remove production secrets from other environments. Follow the Help runbook for the public contact route, private inbox, Auth recovery redirects and security headers. [Environment example](../.env.example) · [Help rollout](help-and-support.md)

## Verify billing before activating chat

In Google AI Studio verify the API key's owning Cloud **project ID**, its current paid tier and its available model. Check that Cloud Billing is active for that project, review the applicable Paid Services data terms, disable voluntary data sharing or payload logging unless separately approved, and check your intended use, regions and spend controls. Complete this review using authorized Google project access. A free-tier key, a configured monthly budget, or the presence of a historical billing export cannot establish current Paid Services eligibility. [AI Studio billing](https://ai.google.dev/gemini-api/docs/billing) · [Gemini API terms](https://ai.google.dev/gemini-api/terms)

Set the following values in the Vercel server environment. Use separate keys and reviews in Preview and Production.

| Setting | Value |
| --- | --- |
| `GEMINI_API_KEY` | The reviewed key, restricted in Google's console to the intended Generative Language API |
| `GEMINI_MODEL` | A model available to that project's paid tier |
| `GEMINI_CLOUD_PROJECT` | The reviewed Google project ID |
| `GEMINI_PAID_PROJECT_ATTESTATION` | Lowercase SHA-256 of the project ID, one LF character, then the exact key |
| `GEMINI_PAID_REVIEW_UNTIL` | Last approved UTC date, in `YYYY-MM-DD` form, at most 30 days ahead |

Generate the fingerprint on a trusted local terminal after the review. The prompt conceals the API key and prints only the fingerprint.

```sh
python -c "import getpass,hashlib; project=input('Reviewed Google project ID: ').strip(); key=getpass.getpass('Reviewed Gemini API key: ').strip(); print(hashlib.sha256((project+chr(10)+key).encode()).hexdigest())"
```

Redeploy the environment after saving the values. Key rotation, a project change, a missing setting or an expired review closes chat. The check reflects the operator's dated review. Monitor billing externally and disable chat promptly if eligibility changes before expiry. The app's billing importer and usage estimates have separate setup. [Provider monitoring and costs](ai-administration.md)

## Verify and provision each participant

Use a trusted institutional record or an appropriate independent age check to establish that the individual is 18 or older and controls the exact Supabase account. A classroom assignment, declared age, email domain, checkbox or teacher role alone is insufficient. Keep identity documents, dates of birth and document numbers out of the ledger, chat and support inbox. An authorized project operator records only the reviewer account, participant UUID, review time and expiry.

In the trusted SQL Editor replace both placeholders with verified Auth UUIDs. Use `true` after a completed initial review or renewal. Use `false` to revoke immediately. These are operator-only SQL calls.

```sql
select public.mannsathi_ai_review_pilot(
  '<verified-admin-uuid>'::uuid, '<verified-adult-participant-uuid>'::uuid, true
);
```

Approval expires after 90 days. Access also requires an enabled global policy and an unrestricted account. Approval is rechecked before Google token counting and again before generation. A revocation stops a waiting request on the second check. A generation already sent can finish. After migration 010 guests cannot access Gemini even if they alter browser requests.

New global policy defaults are 20 requests per rolling minute, 200,000 tokens per UTC day and 2,000,000 per UTC month. A newly approved participant receives 30 requests per day, 20,000 daily tokens and 200,000 monthly tokens unless individual limits already exist. Choose suitable finite global limits and prices in **AI administration → Usage limits** and **Billing**. Set the global AI switch off to suspend chat immediately. It is safe to keep the rest of the platform online. For a release rollback retain migration 010, close AI, and deploy a compatible build. Avoid restoring revoked privileges for obsolete handlers.

## Retention and accounting

Verify the recurring retention job before opening the pilot. If Supabase Cron is already enabled, migration 010 registers `mannsathi-ai-retention` every ten minutes. Otherwise enable Cron and schedule the command below, or use an equivalent trusted database scheduler. The owner can run one batch with `select public.mannsathi_ai_prune();`. Each call processes up to 2,000 expired rows per detailed table. Overlapping runs skip the extra invocation. Use the same job name when updating the schedule. [Supabase Cron quickstart](https://supabase.com/docs/guides/cron/quickstart)

```sql
select cron.schedule('mannsathi-ai-retention', '*/10 * * * *',
  'select public.mannsathi_ai_prune();');
```

| Records | Live-database retention target |
| --- | --- |
| Individual AI request metadata, request-linked retries, admin audit and per-user accounting counters | Today plus 365 prior UTC calendar days |
| Provider quota observations | Today plus 29 prior UTC calendar days |
| Provider billing snapshots and anonymous monthly accounting archives | The current UTC month plus 23 prior months |
| Adult pilot approval | Access expires after 90 days, followed by pruning of expired approvals |

Dashboard and CSV date filters reject ranges before the detailed retention window. Pruning transactionally moves expired request counts, measured totals, estimated dollars and counts of missing measurements into monthly aggregates. The archive contains no participant IDs or per-request identifiers. Treat stored known totals and costs as partial when their corresponding unknown counts are positive. An archive month may still have detailed records in its newer days. Current quota counters remain intact. Retry links whose original request expires become null. Request-ID deduplication lasts for the detail retention period.

Check job status in the Supabase Cron dashboard after setup and after restores. Repeated batches of 2,000 in one category indicate a backlog. Run additional batches until counts fall below the batch limit and investigate any failures. Verify backup expiry, CSV export deletion, Google retention and hosting logs separately. Never include authorization tokens, Gemini keys, prompts or replies in monitoring. Support messages use a separate 90-day process. [Support retention](help-and-support.md)

## Staging acceptance

- Confirm guests, unapproved adults and ordinary registered students cannot invoke Gemini. Verify a mismatched fingerprint or expired billing review closes chat. After per-account approval and a valid review, send a synthetic study question and check the single measured ledger record.
- Revoke the participant and check that AI closes while Calendar and Tasks still work. Confirm restricted users cannot regain AI by signing out or by changing a request body.
- Check a password-only admin receives the MFA challenge. Complete a real TOTP challenge and inspect an overview and filtered CSV. Confirm an unprovisioned teacher remains denied after MFA. Check audit and limit changes against the intended student.
- Verify scheduled pruning in the target database, confirm a monitored support contact, and record the project, release revision, review expiry, test outcomes and responsible operator. Live Google billing, Auth factor delivery, hosted backups and deployment routing require checks with the actual project owner.
