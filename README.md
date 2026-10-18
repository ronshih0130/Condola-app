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

Open http://127.0.0.1:43123. The header switches language (繁中 / EN), persona, and manager / tenant LINE / owner portal. **重置示範** restores the seed. Demo mode is on when `DEMO_MODE=true`.

```bash
npm run test:e2e
```

Playwright covers the three try-out tasks in zh-TW and English, plus the phone-width manager shell, the rent-only LINE notice, empty forms, and the lease-signed checklist.

## Where the design lives

Swap these without hunting through pages:

| What | Path |
| --- | --- |
| Tokens | `src/styles/tokens.css` — CSS variables (`--bg`, `--pri`, `--top`, type). `src/app/globals.css` imports them and holds the layout classes. |
| Components | `src/components/` — chrome, wizards, dialogs, locale provider. |
| Strings | `src/i18n/zh-TW.json` and `src/i18n/en.json`. Design keys stay `s_*`. Keys with amounts or names are `i_*` and use `{placeholders}`. `src/i18n/index.ts` is `makeT(locale)`. |

User-facing copy goes through those dictionaries. Do not hardcode labels in pages.

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
- An owner statement whose fee and expenses exceed confirmed rent shows 房東應補繳 / Owner owes for the shortfall. It does not show a negative payout. A zero fee is NT$0.
- Files are references (`storage_path` like `demo/{uuid}.csv`). Bytes are not uploaded to Supabase Storage.
- LINE deliveries are inserted as `skipped` / `demo_line`. E-invoice status stays `not_applicable`.
- Demo reset wipes org data with `session_replication_role = replica` and reseeds. It keeps currencies, jurisdictions, platform settings, and lease templates.

## Deploy sketch (not run from this repo)

1. Create a Supabase project. Apply **only** the migration, not `supabase_stub.sql`.
2. Use the session or transaction pooler in `DATABASE_URL`. `SET LOCAL` is transaction-scoped and does not stick on a session-mode-incompatible transaction pooler checkout. The database role must be allowed to `SET ROLE authenticated` and `SET ROLE service_role`.
3. Set `DEMO_MODE=false`. Reset deletes the database contents.
4. Seed inserts `auth.users`. Hosted Auth has extra token columns that usually default to empty strings; if a column is `NOT NULL` without a default, give the seed a value before running it.
5. Deploy the Next.js app (Vercel or any Node host) with `DATABASE_URL` and `DEMO_MODE`. One currency per property. No FX conversion.

This repository does not deploy and does not create a hosted project.
