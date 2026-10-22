# Deploy

CI deploys **staging only**, and only when `STAGING_AUTODEPLOY` is exactly `true`. See [STAGING.md](STAGING.md). Production is a separate Wrangler env. Nothing in this repository deploys it.

Do not put database URLs, Supabase keys, or Cloudflare tokens in git.

## Production

Worker name: `condola-prod`. Wrangler env: `production`.

Hostname on this Worker:

- `https://app.condola.app`

`condola.app` belongs to the condola-site Worker. `/` on this app redirects to `/login`, or to `/m` when a session cookie is present.

Tokyo placement is the same as staging: `aws:ap-northeast-1`. Use a **production** Supabase project in that region, not the staging project.

Plain vars:

| Name | Value |
| --- | --- |
| `CONDOLA_ENV` | `production` |
| `DEMO_MODE` | `false` |
| `LINE_LOGIN_ENABLED` | `false` |
| `STAGING_AUTODEPLOY` | `false` |
| `MAIL_PROVIDER` | `cloudflare` |

`CONDOLA_ENV=production` refuses to start if `DEMO_MODE` or `LINE_LOGIN_ENABLED` is `true`. `workers.dev` is off.

Required secret names. Each `ID_DOC_*` value is exactly 32 bytes (64 hex characters, or standard base64 that decodes to 32 bytes). `openssl rand -hex 32` prints one. Do not reuse one key for all three.

- `DATABASE_URL` — production transaction pooler, port **6543**, Tokyo
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ID_DOC_ENCRYPTION_KEY` — raw AES-256-GCM key
- `ID_DOC_HMAC_KEY` — raw HMAC-SHA256 key for the ID number
- `ID_DOC_SIGNING_SECRET` — raw HMAC-SHA256 key for photo tokens
- `CRON_SECRET` — shared secret for the Worker crons. `0 1 * * *` (09:00 Asia/Taipei) sends it as `x-cron-secret` to `/api/cron/reminders`. `0 19 * * *` (03:00 Asia/Taipei) sends the same header to `/api/cron/purge-id-documents`. Cron Triggers are on the Workers Free plan.

Optional, not required to boot, and not one of the required secrets above:

- `CONDOLA_PLATFORM_ADMIN_EMAILS` — comma-separated emails allowed to open `/m/admin` (create partner codes and per-firm price overrides). Leave it unset to keep that screen closed. Set it as a Worker var or secret on staging and production when you want the screen. Sign-up confirmation uses the existing Supabase URL and anon key.
- `BREVO_API_KEY` — fallback mail provider for this round. Leave it unset unless Cloudflare Email Sending blocks reminders. Then set `MAIL_PROVIDER` to `brevo`. The Worker calls Brevo's transactional API (`https://api.brevo.com/v3/smtp/email`), which delivers through the same `smtp-relay.brevo.com` relay Supabase already uses. The sender is `租多啦 Condola <no-reply@condola.app>`. A missing key logs and skips the send.
- `RESEND_API_KEY` — additional backup. Leave it unset unless `MAIL_PROVIDER` is `resend`. Cloudflare Email Sending is the default (`MAIL_PROVIDER=cloudflare`). It uses the `EMAIL` binding (`send_email`) and does not need a token. The sender is `"租多啦 Condola" <noreply@send.condola.app>`.
- `CONDOLA_SITE_URL` — public origin for the confirmation link when the request host is not already `staging.condola.app` or `app.condola.app`. Non-app hosts, including `condola.app` and `*.workers.dev`, use this value. Wrangler sets `https://staging.condola.app` on staging and `https://app.condola.app` on production. The mail link is `{origin}/signup/confirm`, which must stay in the Supabase redirect allow-list. Not a secret.

In production the session cookie `Domain` is `.condola.app`, so a sign-in on either hostname is sent to the other. Server Actions allow those two hosts as origins. Redirect targets that are absolute URLs are accepted only for `https://app.condola.app` and `https://condola.app`, and only as a path on this app.

Apply `supabase/migrations/*.sql` in filename order to the production database before the first deploy. Use the session connection (port 5432) for migrations. Do not run `npm run db:reset`. Do not apply `supabase/stub/supabase_stub.sql`.

```bash
npx wrangler@4.151.2 secret put DATABASE_URL --env production
npx wrangler@4.151.2 secret put SUPABASE_URL --env production
npx wrangler@4.151.2 secret put SUPABASE_ANON_KEY --env production
npx wrangler@4.151.2 secret put SUPABASE_SERVICE_ROLE_KEY --env production
npx wrangler@4.151.2 secret put ID_DOC_ENCRYPTION_KEY --env production
npx wrangler@4.151.2 secret put ID_DOC_HMAC_KEY --env production
npx wrangler@4.151.2 secret put ID_DOC_SIGNING_SECRET --env production
npx wrangler@4.151.2 secret put CRON_SECRET --env production
```

Build, then check the bundle, then deploy. `--env production` is required. Without it, Wrangler publishes the top-level name `condola`.

```bash
npm run cf:build
npx wrangler@4.151.2 deploy --env production --dry-run
npx wrangler@4.151.2 deploy --env production
```

Export `CLOUDFLARE_API_TOKEN` for the deploy. Export `CLOUDFLARE_ACCOUNT_ID` only when the token can see more than one account. Do not export `DATABASE_URL`, the Supabase keys, the `ID_DOC_*` keys, or `CRON_SECRET` in that shell. The Worker reads them from the secrets above. Cron `0 1 * * *` sends reminders at 09:00 Asia/Taipei. Cron `0 19 * * *` purges ID photos at 03:00 Asia/Taipei as `service_role`.
