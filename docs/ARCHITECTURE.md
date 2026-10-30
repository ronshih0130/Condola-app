# Architecture
Evidence baseline: production SHA `5d8b002`; policy decisions are dated 2026-10-27 PT.

## Runtime and request path
```text
Browser → Cloudflare Worker → OpenNext / Next.js pages, routes, actions
                                → src/server → pg/TCP → Supabase Postgres
                                → Supabase Auth / storage-related services
Cron → custom Worker → authenticated cron routes → reminder / ID purge services
```
Next.js 15.5.28, React 19.1.0; OpenNext Cloudflare adapter; `custom-worker.mjs`.
Workers use `nodejs_compat`, targeted placement `aws:ap-northeast-1`, `.open-next/assets`.
Pages read session cookies and stay dynamic; middleware only forwards `x-pathname`.
Do not switch to edge runtime. No Node filesystem cache or filesystem writes.
`pg` uses TCP; Hyperdrive is a documented fallback if direct runtime connectivity fails.

## App and API areas
| Area | Routes/purpose evidenced |
| --- | --- |
| 管理方 | `/m`: portfolio, leases, rent records, bank, statements, team, audit, expenses, reports, tickets |
| 屋主 | `/o`, `/o/statements`, `/o/approvals` |
| 租客 | `/t`, `/t/pay`, `/t/lease`, `/t/repair`, `/t/messages`, `/t/id` |
| Vendor | `/v/[token]` |
| Walkthrough | `/walk`; TODO(owner): document access and behavior |
| Public/auth | `/login`, `/signup/*`, `/forgot`, `/reset/*`, `/auth/*`, `/consent/*`, `/accept/[token]`, `/join` |
| Public information | `/pricing`, `/terms`, `/privacy`, `/refund`, `/licenses` |

API groups: `/api/auth`, `/api/cron`, `/api/demo`, `/api/env`, `/api/export`, `/api/import`,
`/api/flows/[action]`, `/api/id-documents`, `/api/pdf`, `/api/tickets/photos`,
`/api/vendor-jobs`, `/api/reset-flash`, `/api/version`.
ID routes include finalize/photo; photo APIs include sign/confirm; PDF routes cover leases/statements.
These are route inventory facts, not proof of active feature flags.

## Server and shared layers
`src/server/actions.ts`, `queries.ts`, `domain.ts`, `db.ts` anchor application/data work.
Specialized modules cover auth, permissions, org scope, billing, repairs, vendors, mail, ID documents and PDFs.
`src/lib` contains shared PDF, ID/image, spreadsheet, portal and tenant-lease helpers.
TODO(owner): document exact dependency boundaries from implementation.

## Database, tenancy and authorization
Supabase Postgres; **62 migration files** in the supplied production tree.
Naming: timestamp-prefixed SQL, e.g. `20261018120000_schema.sql`; apply in filename order.
The initial schema is documented as 61 tables; TODO(owner): establish current table count.
Never edit the initial migration in place; add compatible migrations.
`scripts/db-migrate.sh` records files in `condola_ops.schema_migrations`.
Runtime uses transaction pooler port 6543; migration tooling uses session port 5432.
Business queries set `request.jwt.claim.sub` and `SET LOCAL ROLE authenticated` inside transactions.
RLS is the org boundary; request handlers have no hardcoded organization.
Authorized privileged operations use `service_role`; app checks must precede them.
`src/server/perms.ts` defines staff permissions; denied manager URLs redirect to `/m/noperm`.
RLS/integration suites include org-scope RPC, function-org guard, helper execution and portal access.
`scripts/check-function-privileges.sh` checks execute privileges; RPC exposure has `rpc-exposure.test.ts`.
TODO(owner): identify the RPC allowlist definition, allowed entries and enforcement path.
I-17 tracks the likely broad app/scripts database role; least privilege is not proven complete.

## Auth and sensitive storage
`condola_session` is checked against `auth_sessions`; optional 2FA can be required per org.
Supabase Auth supports signup confirmation and admin password/reset operations.
Production/staging reject demo authentication flags; demo LINE login is not real LINE integration.
ID handling names: `ID_DOC_ENCRYPTION_KEY`, `ID_DOC_HMAC_KEY`, `ID_DOC_SIGNING_SECRET`.
Related modules: `id-docs.ts`, `id-crypto.ts`, `id-upload-guard.ts`, `id-watermark-image.ts`.
Documented behavior encrypts originals, signs photo access and serves watermarked copies with private/no-store caching.
README's general file-reference description predates/contrasts with ID-storage behavior.
TODO(owner): inventory bucket names and distinguish ordinary files, repair photos and ID storage.
ID purge removes originals/watermarked copies; formed leases use lease-end-based 90-day retention.
TODO(owner): reconcile the in-flight `id-photo-90d` lane with deployed retention behavior.
Never attach ID-document photos to external-model tasks.

## Cron, i18n and flags
Reminder cron runs at **18:00 PT (PDT) / 17:00 PT (PST)** on the preceding local date relative to its scheduled UTC date.
ID purge runs at **12:00 PT (PDT) / 11:00 PT (PST)**.
Routes: `/api/cron/reminders`, `/api/cron/purge-id-documents`; header `x-cron-secret`, variable `CRON_SECRET`.
Copy uses `src/i18n/{zh-TW,en}.json`, `makeT(locale)` and vendored `design/strings/`.
Flags follow internal→ea→ga, org overrides and global off policy.
TODO(owner): locate centralized registry, expiry checks and deployed flag values.

## Environments, CI and release
Prod: `condola-prod`, `app.condola.app`, workers.dev off; staging: `condola-staging`, workers.dev on.
`condola.app` belongs to the separate condola-site Worker.
Local: Node 20+, PostgreSQL 16; Supabase stub is local-only; never reset hosted databases.
Depot CI: install → typecheck/lint/copy/unit → local schema/seed → function privileges → RLS → Playwright.
Staging deployment requires passing checks, main push, `STAGING_AUTODEPLOY=true` and deploy credentials.
Workflow order is build → staging migrations → Worker upload; STAGING's introductory list differs.
Production is manual: release gate, backup/fingerprint/counts/rollback ID, build, dry-run, deploy, T+0/T+15.
Rollback selects a recorded Worker version; DB changes use fix-forward.
Mode B is staging-only except Ron's restricted incident/rollback override; no Mac DB migrations.

Sources: `tree.txt`; `repo_package.json`; `repo_README.md`; `repo_wrangler.jsonc`; `repo_docs_DEPLOY.md`; `repo_docs_STAGING.md`; `repo_.depot_workflows_ci.yml`; `deploy-checklist.md`; `RULES.md`; `PRINCIPLES.md`; `decisions.md` Q5/Q8; `issues-headings.txt`.
