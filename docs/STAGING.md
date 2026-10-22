# Staging

Staging is a Cloudflare Worker built with `@opennextjs/cloudflare` and a Supabase Postgres database in **Tokyo** (`ap-northeast-1`). The production Worker is a separate Wrangler env and is never deployed by CI. See [DEPLOY.md](DEPLOY.md).

Nothing in this repository contains a database URL, a Supabase key, or a Cloudflare token. The names below are the only thing that is committed.

## What CI deploys

`.depot/workflows/ci.yml` job `deploy-staging`:

1. Runs only after the `check` job (typecheck, lint, unit, RLS, and end-to-end tests) succeeds.
2. Runs only on a **push to `main`**. Pull requests and other branches skip it.
3. Runs only when the Depot repository variable `STAGING_AUTODEPLOY` is exactly `true`. If the variable is missing, empty, or any other value, the job is skipped. **The default is off.** Create it as `false` and leave it there until a human turns it on.
4. Requires the Depot secret `CLOUDFLARE_API_TOKEN`. When the variable is `true` and the secret is missing, the job fails before it builds or deploys.
5. Applies `supabase/migrations/*.sql` to the staging database, then builds with `npm run cf:build`, then runs `scripts/cf-deploy-staging.sh`.

That script calls `opennextjs-cloudflare deploy --env staging` and exits if `CLOUDFLARE_ENV` is anything else. It takes no arguments. There is no production command.

`CLOUDFLARE_ACCOUNT_ID` is an optional Depot repository variable. Set it when the API token can see more than one account. Leave it unset otherwise. It is not a secret.

## Supabase (Tokyo)

Create a **new** Supabase project in region Northeast Asia (Tokyo), `ap-northeast-1`. Do not reuse production.

Do not apply `supabase/stub/supabase_stub.sql`. Hosted Supabase already provides `auth.users`, `auth.uid()`, and the `authenticated` / `service_role` roles. Do not run `npm run db:reset` against staging. That script seeds the local demo.

Two connection strings, two stores, same secret name `DATABASE_URL`:

| Store | Port | Host shape | Used for |
| --- | --- | --- | --- |
| Depot CI secret `DATABASE_URL` | **5432** (session) | `aws-0-ap-northeast-1.pooler.supabase.com` | `scripts/db-migrate.sh` only |
| Worker secret `DATABASE_URL` | **6543** (transaction) | `aws-0-ap-northeast-1.pooler.supabase.com` | the staging Worker at runtime |

User is `postgres.<project-ref>`. Database name is `postgres`. Require SSL. Do not commit either string.

The session port is for migrations because Depot runners are IPv4 and the direct host `db.<project-ref>.supabase.co` is IPv6-only unless the project has the IPv4 add-on. `scripts/db-migrate.sh` refuses port `6543`. The transaction port is for the Worker because `SET LOCAL ROLE` does not survive a session-mode checkout. The database role must be allowed to `SET ROLE authenticated` and `SET ROLE service_role`.

The Worker uses targeted placement in `aws:ap-northeast-1` so it runs near that database.

Migrations are recorded in `condola_ops.schema_migrations`. The script does not read `.env.local`. A second run skips files already recorded. Migrations run after the OpenNext build and before the Worker upload, so a broken build does not change the database. Keep each new migration compatible with the Worker that is still serving.

## Worker config

Wrangler env name: `staging`. Deployed script name: `condola-staging` (the top-level name `condola` plus the env). `workers.dev` is on, so the URL is `condola-staging.<account-subdomain>.workers.dev` until a hostname is attached. Do not add a route in git until that hostname exists.

`compatibility_flags` includes `nodejs_compat` (required for `pg`).

Plain vars (not secrets):

| Name | Value |
| --- | --- |
| `CONDOLA_ENV` | `staging` |
| `CONDOLA_SITE_URL` | `https://staging.condola.app` |
| `DEMO_MODE` | `false` |
| `LINE_LOGIN_ENABLED` | `false` |
| `MAIL_PROVIDER` | `cloudflare` |

`CONDOLA_ENV=staging` is a locked environment: demo mode and the demo LINE sign-in stay off, and the process refuses to start if either flag is `true`. The same lock applies to `production` and the older name `staging-real`.

Required secret **names** on the staging Worker. Set them with Wrangler. Do not put values in `wrangler.jsonc`, `.env`, or the workflow file.

- `DATABASE_URL` — transaction pooler, port 6543, Tokyo, as above
- `SUPABASE_URL` — `https://<project-ref>.supabase.co`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — password updates and password-reset links call the Auth admin API when this is set with `SUPABASE_URL`
- `ID_DOC_ENCRYPTION_KEY` — raw AES-256-GCM key, exactly 32 bytes
- `ID_DOC_HMAC_KEY` — raw HMAC-SHA256 key for the ID number, exactly 32 bytes
- `ID_DOC_SIGNING_SECRET` — raw HMAC-SHA256 key for photo tokens, exactly 32 bytes
- `CRON_SECRET` — shared secret for the reminder cron. `0 1 * * *` (09:00 Asia/Taipei) sends it as `x-cron-secret` to `/api/cron/reminders`. `0 19 * * *` (03:00 Asia/Taipei) purges ID photos in the Worker as `service_role`. The manual route `POST /api/cron/purge-id-documents` accepts the same header on preview and staging and returns 404 in production. Cron Triggers are on the Workers Free plan. `openssl rand -hex 32` prints a valid value.

Each ID key is 64 hex characters, or standard base64 that decodes to 32 bytes (44 characters including `=`). A passphrase is rejected. `openssl rand -hex 32` prints a valid value. Do not reuse one key for all three.

Optional Worker secrets. Deploy does not require them.

- `BREVO_API_KEY` — used only when `MAIL_PROVIDER` is `brevo`. That is the fallback if Cloudflare Email Sending blocks reminders. The Worker posts to Brevo's SMTP API (`https://api.brevo.com/v3/smtp/email`) as `租多啦 Condola <no-reply@condola.app>`, the same sender Supabase already uses on `smtp-relay.brevo.com`. A missing key logs and skips the send.
- `RESEND_API_KEY` — used only when `MAIL_PROVIDER` is `resend`. The default provider is Cloudflare Email Sending (`MAIL_PROVIDER=cloudflare`), which needs no API token. The sender is `"租多啦 Condola" <noreply@send.condola.app>`. The staging and production envs bind `send_email` as `EMAIL`.

Do not set `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Those would be inlined into the client bundle. The server reads the secret names above.

```bash
npx wrangler secret put DATABASE_URL --env staging
npx wrangler secret put SUPABASE_URL --env staging
npx wrangler secret put SUPABASE_ANON_KEY --env staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler secret put ID_DOC_ENCRYPTION_KEY --env staging
npx wrangler secret put ID_DOC_HMAC_KEY --env staging
npx wrangler secret put ID_DOC_SIGNING_SECRET --env staging
npx wrangler secret put CRON_SECRET --env staging
```

Each command prompts for the value. Wrangler refuses to deploy the staging env until all eight names exist on that Worker. Deploy does not print the values, and it does not delete a secret you do not mention.

Local preview of the staging env reads `.dev.vars.staging` (gitignored). Do not commit that file.

## Turning auto-deploy on

In Depot CI, for this repository:

1. Add the variable `STAGING_AUTODEPLOY` with value `false`.
2. Add the secret `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit). Do not reuse a token that can deploy unrelated production Workers if you can avoid it.
3. Add the secret `DATABASE_URL` with the **session** connection string (port 5432) for the Tokyo project. This is not the Worker pooler string.
4. When the eight Worker secrets above are already stored on `condola-staging`, set `STAGING_AUTODEPLOY` to `true`.

The next push to `main` deploys staging after tests pass. Set the variable back to `false` to stop. Deleting the variable also stops it.

A push to `main` while the variable is `false` still runs tests. It does not deploy.

## Commands an operator runs by hand

These are not run by this change. Build locally with:

```bash
npm run cf:build
```

Apply migrations only when `DATABASE_URL` is the staging session connection:

```bash
npm run db:migrate
```

Deploy staging only when `CLOUDFLARE_API_TOKEN` is set in the environment:

```bash
npm run cf:deploy:staging
```

Do not run `npx wrangler deploy` without `--env staging`. That publishes the top-level Worker name `condola`, which is not the staging env and is not production. CI does not run that command.

## What staging does not do

- It does not deploy production.
- It does not apply `supabase/stub/supabase_stub.sql`.
- It does not seed demo firms, `Demo1234`, or the authenticator bypass `123456`.
- It does not enable `DEMO_MODE` or `LINE_LOGIN_ENABLED`.
- It does not call LINE, issue e-invoices, or move money.
