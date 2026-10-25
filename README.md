# 租多啦 Condola

Software for landlords and licensed property firms. Taiwan is the lead market; a US firm can use the same screens in USD. Condola records leases, meter splits, payments, and owner statements. Money moves from the tenant to the landlord or the firm. The product does not collect rent, manage property on someone's behalf, or guarantee rent.

LINE, e-invoices, and bank payouts are marked demos. Nothing is sent to LINE and nothing moves money.

## Run locally

Requirements: Node 20+, PostgreSQL 16 with `postgresql-contrib` (`btree_gist`, `citext`).

```bash
cp .env.example .env.local
bash scripts/db-setup.sh
npm install
npm run db:reset
npm run dev
```

Open http://127.0.0.1:43123 and sign in. Seeded passwords are `Demo1234` (demo only). The header switches language (繁中 / EN). An Admin sees **重置示範**, which restores the seed. `POST /api/demo/reset` returns 404 unless `DEMO_MODE=true` and the caller is an Admin.

| Role | Email |
| --- | --- |
| Admin | `yating.lin@songxin.demo` |
| Manager (LINE-linked, for the demo LINE button) | `zhiming.huang@songxin.demo` |
| Accountant | `meiling.zhou@songxin.demo` |
| Maintenance | `dawei.wu@songxin.demo` |
| Tenant | `yawen.zhang@tenant.demo` |
| Owner | `jianhong.chen@owner.demo` |

```bash
npm run typecheck
npm run test:unit
npm run test:rls
npm run test:e2e
```

Playwright covers the three try-out tasks in zh-TW and English, plus the phone-width manager shell, the rent-only LINE notice, empty forms, and the lease-signed checklist. It signs in through `/login`.

## Where the design lives

Swap these without hunting through pages:

| What | Path |
| --- | --- |
| Tokens | `src/app/tokens.css` (`--cd-*`, Window Glow). `src/app/globals.css` imports it and maps those values onto the layout classes, Tailwind, and shadcn names (`--primary`, `--ring`). `src/brand/tokens.json` is the same palette for email and PDF templates. |
| Components | `src/components/` — chrome, wizards, dialogs, locale provider. |
| Strings | `src/i18n/zh-TW.json` and `src/i18n/en.json`. Design keys stay `s_*`. Keys with amounts or names are `i_*` and use `{placeholders}`. `src/i18n/index.ts` is `makeT(locale)`. The prototype catalogs are vendored at `design/strings/zh-TW.json` and `design/strings/en.json`. |

User-facing copy goes through those dictionaries. Do not hardcode labels in pages.

When Design sends a fresh `strings/zh-TW.json` and `strings/en.json` (sandbox, subscription, and ID keys are landing in that catalog), re-sync from the directory that contains both files:

```bash
npm run strings:sync -- /path/to/prototype/strings
```

That copies the two files into `design/strings/` and rewrites every shared key in `src/i18n`. Keys that exist only in the prototype stay in the vendored catalogs until the app uses them. Then run `npm run test:unit`. Shared keys must match the vendored files, including `{placeholder}` names.

## Data model

`supabase/migrations/20261018120000_schema.sql` is the schema (61 tables, RLS, ledger, jurisdiction rules). Do not edit it in place; add a new migration if the model changes.

`supabase/stub/supabase_stub.sql` creates `auth.users` and `auth.uid()` for **plain Postgres only**. Do not apply the stub on hosted Supabase.

The app connects with `DATABASE_URL`. Business queries run in a transaction that sets `request.jwt.claim.sub` and `SET LOCAL ROLE authenticated`, so RLS applies. Signing, portal-user provisioning, demo notices, and try-out flags run as `service_role` after the caller is authorized in the app. `organizations` updates are admin-only under RLS, which is why the try-out flag is written as `service_role`.

Schema notes for this demo:

- Money is integer minor units (exponent 2). TWD displays with 0 decimals, so NT$12,000 is `1200000`.
- Electricity above the Taipower average (`electricity.per_kwh_cap`, leases from 2024-07-15) needs a non-blank override reason. The property wizard's cap step is a client preview. The saved check is the lease allocation run.
- A move-in invoice (rent + deposit + utility) is issued only when both signatures are signed. The try-out "lease signed" flag is set only then.
- The LINE rent-due card uses `leases.rent_amount_minor`. Deposit stays on its own line.
- Shared meters use `meters.serial_number` (電號). An empty number shows an add-meter prompt. The field itself starts blank.
- Lease template language defaults to `organizations.default_locale` (zh-TW for the Taiwan firm), not the bilingual template.
- Manager list tables use `table.t.rf` and `data-label`. They become cards when the `.main` content column is 800px or narrower (`@container`), including a narrowed desktop window. Ledger, statement documents, and split previews stay tables.
- An owner statement whose period net is negative shows 本期淨額為負 / Negative net this period beside the signed amount. The net chip and the formula use that same net, including payouts, and opening plus that net equals the closing balance. A zero fee is NT$0.
- Buildings, rooms, and whole units are edited by Admin and Manager. 屋主 belong to one firm and can own several properties. `listing_terms` stores the sample CSV's lease columns so a file can be seeded; those screens do not create tenants.
- Files are references (`storage_path` like `demo/{uuid}.csv`). Bytes are not uploaded to Supabase Storage.
- LINE deliveries are inserted as `skipped` / `demo_line`. E-invoice status stays `not_applicable`.
- Demo reset wipes org data with `session_replication_role = replica` and reseeds. It keeps currencies, jurisdictions, platform settings, and lease templates.

## Sign-in and roles

Sessions are a `condola_session` cookie checked against `auth_sessions`. Queries run as that user (`request.jwt.claim.sub` + `SET LOCAL ROLE authenticated`), so RLS is the org boundary. There is no hard-coded organization in request handlers.

The permission table is `PERMS` in `src/server/perms.ts` (18 rows, the same keys as the prototype). Nav items the role cannot open are omitted. A direct URL without the permission redirects to `/m/noperm`. Tickets is an exception: every staff role can open the list; creating and updating tickets stay on `tickets.update` (Admin, Manager, Maintenance). Those controls are disabled, with 「需要以下角色：…」, and the server checks the same table. Other actions the role can see but not perform stay on screen the same way.

2FA is optional for every role, including Admin. An Admin can require it for the firm (`require_2fa` in organization settings, off by default). With `DEMO_MODE=true` outside production, the authenticator step also accepts `123456`, matching the prototype, and the process logs a warning. `NODE_ENV=production` or `CONDOLA_ENV=production`, `staging`, or `staging-real` ignores `DEMO_MODE` and `LINE_LOGIN_ENABLED`, and refuses to start if either is still set, so the authenticator bypass, `POST /api/demo/reset`, and the demo LINE sign-in cannot run there. `next build` does not refuse (it only ignores the flags) so a demo `.env.local` can still produce a bundle. LINE Login does not call LINE. Outside production, when the flag is on (or unset while demo mode is on) it signs in the member with `profiles.line_linked` (the seeded Manager), with no password and no 2FA.

Tenant ID photos are encrypted with `ID_DOC_ENCRYPTION_KEY` (raw AES-256-GCM key), the ID number is keyed with `ID_DOC_HMAC_KEY` (raw HMAC-SHA256 key), and photo links are signed with `ID_DOC_SIGNING_SECRET` (raw HMAC-SHA256 key). Each value is exactly 32 bytes: 64 hex characters, or standard base64 that decodes to 32 bytes (44 characters with `=`). A passphrase is not accepted and is not hashed. `ID_DOC_ENCRYPTION_KEY` is required even in demo mode. A missing or empty value refuses startup and refuses encrypt or decrypt. `ID_DOC_HMAC_KEY` and `ID_DOC_SIGNING_SECRET` may be unset in demo mode and then use local demo material; a value that is set must still be 32 bytes. Outside demo mode all three are required. Generate one with `openssl rand -hex 32`. Photos on a formed lease are deleted 90 days after the lease end (`terminated_on`, otherwise `end_date`). That date is stored as `identity_documents.delete_after` and moves when the end date changes. An open-ended formed lease has not ended, so it is not deleted on the upload clock. A document with no formed lease (none, draft, unsigned, cancelled, or voided) is deleted 90 days after the upload date. There is no retention setting the firm can edit. A daily Cloudflare cron (03:00 Asia/Taipei, `0 19 * * *` UTC) runs `purge_due_identity_documents` as `service_role` and deletes both storage objects for every slot: the encrypted original and the watermarked copy. The same route can be called on demand: `POST /api/cron/purge-id-documents` with header `x-cron-secret`. Staging uses `CRON_SECRET`. Demo mode also accepts `demo-cron`. A missing or wrong secret is a 404. When a lease is terminated or cancelled with no end date, that date is set to the termination date, or to the Taipei calendar day of the change, so this job can pick the document up. Staging and production require `CRON_SECRET`. Admins see the read-only line 「依合約，租約結束後 90 天自動刪除」; other roles do not.

## Staging on Cloudflare

The app is prepared for [OpenNext Cloudflare](https://opennext.js.org/cloudflare). `npm run cf:build` writes `.open-next/` (gitignored). The staging Worker, Tokyo Supabase project, secret names, and Depot gate are in [docs/STAGING.md](docs/STAGING.md).

`.depot/workflows/ci.yml` deploys the Wrangler env `staging` only after the `check` job passes, and only on a push to `main` when the repository variable `STAGING_AUTODEPLOY` is exactly `true` and the `CLOUDFLARE_API_TOKEN` secret is set. An unset variable leaves deploys off. The `production` env in `wrangler.jsonc` is manual. CI never deploys it. See [docs/DEPLOY.md](docs/DEPLOY.md).

Next.js notes for Workers:

- Pages are `force-dynamic` because the session cookie is read on each request. OpenNext supports that. Do not switch these routes to static rendering.
- `src/middleware.ts` only forwards `x-pathname`. It does not call the database.
- The server uses `pg` over TCP. Workers need the `nodejs_compat` flag in `wrangler.jsonc`. If a direct Postgres connection fails at runtime, attach a Cloudflare Hyperdrive config to the same `DATABASE_URL` and point the Worker at the Hyperdrive connection string. Do not switch the app to the edge runtime.
- `next/image` is not used. Adding it later needs `images.unoptimized` or a custom loader; the Cloudflare adapter does not run the default image optimizer.
- There is no Node filesystem cache and no `fs` writes. Demo reset and seed stay operator commands, not Worker routes, when `DEMO_MODE` is false.

This repository does not create the hosted Supabase project or the Cloudflare account. Production is never deployed from CI.
