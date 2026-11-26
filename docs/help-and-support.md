# Help, privacy requests and public sign-in

The workspace account menu opens an eight-item Help submenu. Each article opens inside the workspace. Signed-out visitors can use the same content at `/help.html`. Privacy and terms links are also on signup and both sign-in pages. The Download apps entry opens the requested black **Coming soon** panel.

## Private inbox

Apply `database/migrations/011_support_inbox.sql` once using the project owner's SQL Editor. The in-app forms write to a private database inbox. They do not send an email or open a public issue. The alternate contact published throughout Help is **mannsathi.official@gmail.com**. Assign someone to monitor both the private queue and that mailbox.

Read new reports with a trusted SQL Editor role. The website has no endpoint for reading support submissions. Production monitoring should count submissions and failures without logging form bodies.

```sql
select id, received_at, kind, email, detail
from mannsathi_support_private.requests
where resolved_at is null
order by received_at;
```

The reference confirms receipt. A reply email or reference alone does not prove identity. Verify account ownership through the existing verified account email before releasing or deleting data. Review the Auth record, profile, class memberships, school-managed records, AI identifiers, support tickets, downloaded exports and provider retention. Record what was removed or retained and the reason. Explain that the student controls older browser-local copies on each device. Mark a handled ticket's `resolved_at` with its resolution time. Keep replies and exports in access-controlled storage.

When pg_cron is already installed, 011 registers an hourly `mannsathi-support-retention` job. Otherwise arrange an hourly owner-only job to run the command below. It clears pseudonymous source identifiers after 24 hours and removes records after 90 days. Check the scheduler’s actual execution history before publishing the retention notice.

```sql
select mannsathi_support_private.prune();
```

Forms can accept five new requests per source per hour and 120 in total per hour. A retry of a confirmed submission can reuse the reference. Keep the published support email available for time-sensitive privacy requests when the inbox or a shared network is rate limited.

## Release checks

- Send a fictional bug report and privacy request on staging. Match the displayed references to the two private rows, verify a response to the supplied address, and resolve the test requests.
- In Supabase **Authentication → URL Configuration**, set **Site URL** to your canonical HTTPS origin. Under **Redirect URLs**, allow both exact URLs for that origin, e.g. `https://mannsathi.vercel.app/recover.html` and `https://mannsathi.vercel.app/recover.html?role=teacher`. Add equivalent URLs for the test origin to the staging project's allowlist.
- The standard **Reset Password** email template can use `{{ .ConfirmationURL }}`. For mail systems that prefetch links, set the email button's destination to `{{ .RedirectTo }}#type=recovery&token_hash={{ .TokenHash }}`. With this template the page verifies the one-time token after the recipient selects **Open password reset**. The button must lead directly to the application. Disable email-provider click tracking for these links. [Supabase password recovery](https://supabase.com/docs/guides/auth/passwords) · [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- On staging, request recovery from both sign-in pages and Account settings. Open the email in a fresh browser, confirm both password fields, then sign in through the correct student or teacher page. Reopen the spent link and verify that you can request a replacement. The recovery session stays in page memory. Reloading the page clears it. If Supabase requests higher assurance, select a previously verified authenticator, submit its current six-digit code, then save the new password. A lost or unavailable factor requires the account administrator’s verified MFA recovery procedure.
- The browser SDK is the official MIT-licensed Supabase JS 2.119.2 UMD build. Its npm archive was verified against the published SHA-512 integrity value. The bundle and license are under `js/vendor/supabase-2.119.2/`. Review and update the pinned release as part of dependency maintenance.
- The Vercel content policy permits Supabase project connections under `*.supabase.co`. For a custom Auth domain update `connect-src` with the exact HTTPS origin (and WebSocket origin if used). Check the deployed HTML response headers and the sign-in, recovery and authenticator screens. The stylesheet uses Google Fonts where available.
- The public link preview uses the Daybreak share card at the existing `mannsathi.vercel.app` domain. Change the absolute URL in `index.html` if the canonical host changes. Share the ordinary homepage URL, never an authentication or recovery link.
