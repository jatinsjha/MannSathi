# AI administration

Sign in with a provisioned account and open **AI administration** in the MannSathi sidebar. The overview starts with the last seven UTC dates. The student directory sorts by reported tokens and includes accounts with no recorded use. Choose a student's name to inspect their history or restrict their AI access. The **At warning threshold** filter uses current policy counters. **Request logs** exports the applied filters as CSV.

## Repository and database audit

The original `api/chat.py` validated up to 12 messages and sent them to the Gemini Developer API through the Google GenAI SDK. It had no verified caller, persistent request ID, usage ledger or billing feed. Earlier conversations in browser storage contain no authoritative usage metadata. Accounting starts when this release handles traffic.

The existing stack includes static HTML, the shared workspace shell and theme, vanilla JavaScript, Vercel Python handlers and Supabase Auth/Postgres. Migrations 000–005 cover profile permissions, calendar, teacher permissions and tasks, student divisions, focus, and exams. The existing schema review describes an earlier database export. There was no live schema inspection for this release. The deployment inventory below establishes what is installed in the target project.

## How a request is accounted for

1. The chat client sends the current Supabase bearer token and a UUID. The backend verifies the token at Supabase Auth. Anonymous visitors use a separate, platform-wide guest pool. Invalid bearer credentials fail authentication.
2. A service-only PostgreSQL function serializes admission against the global policy row, checks current restrictions, assigns the request ID and reserves an initial token before calling Google's token counter. Counters use UTC admission dates. A second transaction reserves the measured prompt plus the maximum reply of 1,024 tokens, rechecking applicable controls. The database lock ends before generation begins.
3. The existing Google SDK generates a reply. The backend records prompt, candidate, thinking and total counts when the response supplies them, along with model, outcome, timing and a safe error category. It finalizes the same request ID once. An intentional retry can link to a prior request. Conversation text, replies, authorization headers and API keys have no columns in the ledger.
4. Unknown usage remains null. A confirmed failure before generation releases the token reservation and preserves the attempt in request history. An uncertain outcome after generation can retain the reservation because the provider may have processed it. The current day's or month's allowance may therefore be smaller than reported token totals suggest. A request can be rejected if a full 1,024-token reply would exceed the remaining allowance. Pending records are visible under **Request logs → Pending**. Avoid manually releasing them without independent evidence of what Google processed.

The usage overview covers the platform, including guests and identified non-students. Student rankings use current non-anonymous accounts outside the teacher and administrator registries. Class and division come from approved enrollment. Active AI users count distinct identified accounts with at least one non-blocked request. Total attempts also include blocked and pending rows. Average tokens uses the requests with measured totals. A Gemini total can include thinking tokens in addition to prompt and visible output.

New signed-in chat histories use an account-specific key in this browser. Switching accounts clears the visible conversation, draft and retry state. Guest history lasts for the current page session. Earlier releases stored transcripts in a shared browser key without an owner ID. That old data stays on the device and is excluded from account histories because the app cannot establish ownership.

## Authorization and storage

Every admin API request verifies the bearer token with Supabase, derives the actor UUID, checks membership in `ai_admins` and consumes a slot in a database-backed rolling admin rate limit. Report and change functions check membership again. Teacher rights, editable Auth metadata, email addresses, URL parameters and sidebar visibility do not grant that membership.

| Migration | Purpose |
| --- | --- |
| 006 | Admin membership, global and student policies, model prices, request ledger, transactionally updated counters, admin actions and service-only admission/finalization functions |
| 007 | Student directory over existing profile/enrollment data, filtered SQL aggregates, paged history and audit reports |
| 008 | Project-scoped Google quota observations and current-month USD Cloud Billing snapshots, with privileged import functions and an admin-checked reader |

Private tables have RLS and restricted grants. The directory and internal reporting helpers also have explicit grant restrictions. Requests from the browser go through `/api/admin`. No administrative table is queried from browser code. Report filters have bounded dates and page sizes. CSV exports are restricted to 10,000 matching rows and are generated from whitelisted usage fields.

## Supabase and Vercel deployment

1. Use the intended Supabase staging project first. Run the read-only [schema inventory](../database/inspect_ai_schema.sql) in its SQL editor. Review the existing migrations and the project’s migration history. Resolve missing prerequisites or preexisting AI objects before continuing. Supabase projects with earlier MannSathi releases can be at different migration levels.
2. Apply each **missing** numbered migration, in order, using a trusted SQL editor administrator. For an installation current through 005, run [006](../database/migrations/006_ai_control.sql), [007](../database/migrations/007_ai_reporting.sql), then [008](../database/migrations/008_ai_provider.sql). Each file runs inside a transaction. If one fails, inspect the error and the inventory before retrying. Do not rerun a successful migration.
3. In **Authentication → Users**, verify the intended owner's UUID. Provision the membership with the SQL below. The owner can use the existing sign-in flow appropriate for their account. Remove the membership to revoke access on the next request.

   ```sql
   insert into public.ai_admins (user_id)
   values ('<verified-owner-auth-uuid>'::uuid)
   on conflict (user_id) do nothing;
   ```

4. Set the following environment variables in Vercel for the intended deployment environment. Keep preview and production Supabase projects and credentials paired. For local development use the ignored `.env` with `python local_test.py`.

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | HTTPS URL of the same project that owns the users and migrations |
   | `SUPABASE_KEY` | Browser-safe publishable key or legacy anon key, as used by the existing application |
   | `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase secret key or legacy service-role JWT for this project |
   | `GEMINI_API_KEY` | Server-only Gemini Developer API credential |
   | `GEMINI_MODEL` | Model ID available to this key. The code preserves the repository’s default, `gemini-3.5-flash-lite`. Confirm access for the deployed project. |
   | `GEMINI_CLOUD_PROJECT` | Optional Google project **ID** owning the Gemini key. The reader only returns imported snapshots for this ID. |

5. Keep the Vercel root at the repository root, with the project's Python 3.12 runtime, existing Python dependencies and static files. Deploy the backend and frontend together following the database upgrade. The new function route is `/api/admin`. Set the function duration high enough for authentication, token counting, generation and settlement within your Vercel plan. Redeploy after changing Vercel environment variables.
6. In staging, check that the owner sees administration and a student and an unprovisioned teacher receive 403 from `GET /api/admin?action=overview` with their valid tokens. Sign in as a test student, send a short chat, then verify a single record and its token coverage. Restrict that student, confirm the next paid generation is blocked, open Calendar and Tasks, then lift the restriction and review the audit entry. Repeat the schema inventory and check that both browser roles lack administrative privileges. Promote the tested deployment after configuring the production project manually.

**Initial policy.** Signed-in AI is enabled. Global and student token limits and model prices start unconfigured. Both daily guest allowances start at zero. Enabling guest AI gives anyone who signs out access to the shared guest pool, including people with a restricted account. Keep the guest pool closed when restrictions must require a signed-in identity. AI controls apply only to chat. Blocked attempts remain in request history with a restriction category.

## Monitor Gemini quota

Google documents project- and model-specific request and token limits. RPD follows Pacific midnight. Google also publishes named `generativelanguage.googleapis.com` Cloud Monitoring metric descriptors. Some models, limits and tiers have different coverage. A Gemini key alone does not grant access to private Cloud Monitoring series. Use the project's active limit names from AI Studio or Google Cloud. [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) · [Google Cloud metric catalog](https://docs.cloud.google.com/monitoring/api/metrics_gcp_d_h) · [Quota monitoring](https://docs.cloud.google.com/monitoring/alerts/using-quota-metrics)

The optional [Google importer](../scripts/sync_ai_provider.py) runs on a trusted machine. Its read credentials stay outside the web app. It writes a snapshot through the service-only Supabase RPC. Set the same Supabase variables, model and Google project in the import process environment. The script reads process environment variables directly.

1. Enable the Cloud Monitoring API (`monitoring.googleapis.com`) in the relevant project. Give the read identity `roles/monitoring.viewer` there, including `monitoring.timeSeries.list`. Use Application Default Credentials, for example `gcloud auth application-default login` for a permitted operator, or a workload identity attached to a trusted job. If using user ADC with a quota project, configure that quota project and grant `serviceusage.services.use` there. No Google password or service-account JSON belongs in the browser. [Monitoring access control](https://docs.cloud.google.com/monitoring/access-control) · [Application Default Credentials](https://docs.cloud.google.com/docs/authentication/provide-credentials-adc)
2. In Metrics Explorer, inspect the actual project's Gemini API **Location** resource, model, reported limit name and quota base. Look for a `GAUGE INT64` limit series and corresponding `DELTA INT64` usage series. The importer currently accepts global, per-project/per-model generate-content request and input-token metrics for recognized free or paid tiers. Cloud Quotas can help discover supported quota definitions with `cloudquotas.quotas.get` (`roles/cloudquotas.viewer`). A definition by itself does not establish consumption. [Cloud Quotas permissions](https://docs.cloud.google.com/docs/quotas/permissions) · [Metrics Explorer](https://console.cloud.google.com/monitoring/metrics-explorer)
3. From the repository root in the import environment, install `google-auth[requests]` and `tzdata`. Run `python -m scripts.sync_ai_provider --quota <metric-base> <exact-google-limit-name>`. Supply more than one `--quota` to import multiple limits for the configured model. For example, the published free-tier request metric base is `generate_content_free_tier_requests`. Copy the corresponding RPM or RPD limit name from the project's series. Times and figures are provider observations.
4. Refresh **Gemini monitor**. The importer selects a completed minute ending five minutes behind the clock to allow publication lag, or the observed portion of the current Pacific quota day for RPD. It only joins matching project, service, model, metric, dimension, limit name and observation window. A consistent limit at each minute sample and contiguous usage observations are required for utilization. Missing observations leave consumption and remaining capacity unavailable. A displayed percentage is `100 × observed usage / reported limit`. Percentage remaining is its complement. A zero limit yields no percentage. A prior snapshot keeps its observation and sync timestamps when another import fails. Treat the displayed capacity as historical to that window.

Google also provides the [AI Studio rate-limit dashboard](https://aistudio.google.com/rate-limit) and [Cloud Quotas dashboard](https://console.cloud.google.com/iam-admin/quotas). The app's connection evidence comes from recorded generations for the configured model. “Latest request succeeded” describes a past observation; it is not a synthetic health probe. Missing provider series, billing data or a reset timestamp appear as **Not available from provider**. Imports run only when an operator invokes the script or schedules it on their infrastructure.

## Billing, pricing and spend controls

In **Settings & audit**, enter USD per million input and output tokens for each configured model and tier. Use zero for a verified free rate. Prices are captured at admission so later edits preserve historical estimates. The app uses a simple input/output text tariff. Caching, tiered context prices, incentives, taxes, credits and other SKUs can differ from those rates. Model estimates and provider-reported costs have separate fields. The month-end projection extrapolates complete app estimates by UTC calendar day. Incomplete coverage suppresses the projection and estimate-based budget remainder. A current-month provider snapshot takes precedence for budget utilization. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

For reported spending, enable standard or detailed Cloud Billing export to BigQuery manually. Setup requires a Billing Account Costs Manager or Billing Account Administrator on the billing account and BigQuery User on the dataset project. Enable the BigQuery API. Give the import identity BigQuery Data Viewer on the export dataset and BigQuery Job User on the query project (the configured Gemini project). Enable billing on that query project where required. Keep these Google read permissions off the browser and ordinary backend. [Billing export setup](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup) · [BigQuery IAM](https://docs.cloud.google.com/bigquery/docs/access-control)

Install `google-cloud-bigquery` in the trusted importer environment and run:

```sh
python -m scripts.sync_ai_provider --billing-table BILLING_PROJECT.DATASET.gcp_billing_export_v1_ACCOUNT --billing-location DATASET_LOCATION
```

Use the real fully qualified export table. The query restricts by project, Gemini API service ID, and current UTC usage month. It adds reported credits to cost and accepts USD records. Missing export rows do not create a zero-dollar snapshot. **Provider export updated through** is the latest export timestamp among matching records. New exports, late records and adjustments can leave a partial month. The figure is the amount present in the export at synchronization, and an invoice can change it. The default maximum billed query size is 1 GiB. Change `--max-query-bytes` only if appropriate for the dataset and query budget. [Cloud Billing export fields](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/standard-usage)

The MannSathi monthly budget tracks spending locally. For a provider-enforced cap, eligible customers can configure a monthly **Spend cap enforcement** budget for one Google project and the **Gemini API** service (`generativelanguage.googleapis.com`, service ID `AEFD-7695-64FA`) under Cloud Billing → Budgets & alerts. The project-scoped permissions include `resourcemanager.projects.get`, `billing.resourcebudgets.read`, `billing.resourcebudgets.write` and `billing.resourcebudgets.configureSpendCap`. Google also documents an AI Studio project spend cap for eligible accounts, with project editor/owner/admin access. Check account eligibility and the option actually offered. Alerts-only budgets send notifications. Enforcement can lag usage and allow overages. This application creates no billing resources. [Google Cloud spend-cap eligibility, setup and permissions](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps) · [AI Studio billing and project caps](https://ai.google.dev/gemini-api/docs/billing#project-spend-caps)

## Verification and operational limits

- Python API tests use verified-auth and provider fixtures. The Google SDK wire-format test can run with the project dependency installed. Run `python -m unittest discover -s tests`.
- The PostgreSQL migrations and grants run in the existing PGlite harness. Run `node tests/ai-control-sql.cjs` and `node tests/ai-reporting-sql.cjs`. Follow the harness instructions for `PGLITE_MODULE_PATH`. The separate `node tests/ai-postgres-race.cjs` test uses a disposable native PostgreSQL cluster and two independent connections. See the script for `PG_BIN_DIR` and `PG_MODULE_PATH`.
- Run `node tests/ai-admin-browser.cjs` and the existing browser suites with a local Chrome installation. Set `CHROME_PATH` if Chrome is installed outside the driver's default path. Browser fixtures exercise the workspace entry point, report filters, saves, export, mobile layout and account switches without production records.
- There is no historical backfill, invoice reconciliation or automated deletion of request records. Restrict access to usage exports and set an operational retention period appropriate for your deployment. Repeated blocked requests still create log entries. Database monitoring and hosting edge rate limits can help manage heavy request volume.
- Live migration state, Google metric availability, project tier, actual billing export, IAM grants and deployed Vercel behavior require the staging and project-specific checks above.

### Local results for this release

| Stage | Verification |
| --- | --- |
| 1. Audit | All 42 pre-existing Python tests passed on the original checkout. |
| 2. Schema and access | Real PostgreSQL/PGlite migrations, service-only grants, ordinary student and teacher denial, owner checks, and admin rate limits passed. |
| 3. Metering | Chat HTTP tests passed for successful, failed, duplicate and incomplete usage. The real Google GenAI Python SDK also passed a localhost wire-format test. |
| 4. Overview and students | Database checks passed for measured totals, missing metadata, guest exclusion from student totals, student search, sorting, warnings and pagination. Chrome exercised both screens. |
| 5. Logs and export | Authorized CSV, rejected callers, safe columns, complete filtered exports and page boundaries passed. |
| 6. Limits | Native PostgreSQL testing with two independent sessions confirmed lock waiting, denial at capacity, and enforcement of a newly committed student restriction. |
| 7. Provider | Fixture tests passed for missing series, mismatched dimensions, time windows, incomplete or invalid measurements and genuine zero values. No project credentials were used. |
| 8. Billing | Tests passed for model-specific estimates, incomplete coverage, month rollover, matching-project USD snapshots, dated export corrections and separate budget bases. |
| 9. Audit and integration | The Python regression run passed all 69 tests with the SDK installed. The seven existing browser suites passed. Sidebar, Calendar and Dashboard passed again after chat-history isolation. The admin browser suite exercised all seven sections, mobile layout, account switches and policy writes. The final quota display, chart spacing and student subtotal passed inert DOM checks. Server-relative and custom dates passed API tests. A repeat Chrome run after those UI refinements could not launch because automatic approval review failed. |
