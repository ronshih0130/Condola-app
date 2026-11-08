# B-034 — local implementation evidence

2026-11-06 PT. Mode 2 implementer; Claude is architect, independent reviewer and sole committer.
Design was written before implementation: [B-034 design](../../../20-build/specs/B-034-design.md).

## Validation

Fresh `condola_b034impl` on `127.0.0.1:55432`: Supabase stub, every migration, then `db:reset`.
Each integration file ran as a separate process with `--test-concurrency=1`, cloned its local database
and cleaned up its clone. Node 20.20.2 / npm 10.8.2. Node processes loaded a local-only socket/HTTP
guard; LINE proofs were local HS256 tokens and notification transports were captured locally.

| Check | Result |
| --- | --- |
| typecheck | PASS |
| lint | PASS; 0 errors, 16 existing warnings |
| copy:check | 6/6 PASS |
| test:unit | 1035/1035 PASS |
| b034-tenant-liff.integration | 41/41 PASS |
| b033-line-login-link.integration | 79/79 PASS |
| b033-line-foundation.integration | 94/94 PASS |
| b027-denial-inventory.integration | 28/28 PASS; regeneration unnecessary |
| git diff --check | PASS |

All final test runs have zero failures and zero skips. Exact local log paths, sizes and SHA-256
hashes are in [manifest.json](manifest.json). Initial failures remain in `/private/tmp/b034-integration-initial.log`
and `b034-integration-r2.log`: fixtures initially assumed the seeded tenant lacked second-company
leases, inserted a duplicate contact, and expected 401/404 instead of the existing vendor 403 denial.
Those fixtures were corrected to select truly foreign records and reuse the existing second-company
contact. The initial typecheck found a duplicate import and an assertion-induced never[] narrowing;
both were corrected. No assertion was weakened to admit data access or business partial effects.

Continuation verification: inspected the preserved working-tree diff and implementation against the
hub specification and acceptance mapping; no additional implementation fixes were needed. Recreated
`condola_b034impl` from the stub and all migrations, seeded it, and reran every check above. All commands
exited 0 with the same pass counts. Integration files ran separately and sequentially, each with
`--test-concurrency=1`. Current logs use `/private/tmp/b034-cont-*.log`; the manifest records their
hashes and the exact implementation/design file hashes for Claude's review. Earlier logs remain intact.
Base database readback found all four platform LINE gates false and zero organizations with any of
those gates enabled. This is local validation of uncommitted files, not independent QA or release approval.

## Acceptance

- A1: Verified invite binding and LINE login issue/reuse the existing secure Condola cookie; actual
  authenticated `app.my_tenant_leases()` reads contain only the user's leases. Replay is denied.
- A2: Current-account and provider-identity conflicts leave invitation/contact/account/link/session/
  consent/audit business state unchanged. Durable admission counters remain B-033's existing behavior.
- A3: Org unlink followed by actual captured dispatch produces zero LINE calls and one deduplicated
  queued Email; the other company's link and login continue to work.
- A4: Global unlink revokes all LINE provenance sessions across organizations, preserves the confirmed
  Email/password and password session, permits real password sign-in, and redirects queued work to Email.
  Missing step-up, MFA and recovery evidence fail closed.
- A5: Lost/mismatched/expired/consumed browser contexts cannot recover private flow scope or replay it.
  Route-backed browser mocks cover accepted/rejected session cookies, consent confirmation, account
  binding and SDK-free unlink. Authentication readback prevents navigation when the session cookie fails.
- Boundaries: three-persona strict OFF matrix with zero-write snapshots; foreign/missing equality;
  current owner property_owners authority and multi-role/company rechecks; a real existing vendor job
  capability cannot become a session, LINE binding, staff authority or account-history credential.

## Routes and compatibility

No new routes. Updated public `/t/liff`, `/v/liff`, `/o/liff` bootstrap behavior; tenant-only settings
and invite entry controls in `/t` and `/accept/[token]`. Reuse POST `/api/line/flows`, `/session`, `/reauth`,
`/bind`, `/invites/accept`, GET `/api/line/links`, DELETE `/api/line/links/[id]` and `/api/line/identity`.
Owned link responses now include persona and identityId for explicit scoped settings selection.
Per the task's strict OFF requirement, all three bootstrap handlers now return 404 while retaining
an Email link, replacing B-033's prior 200 exception; its three regression assertions were updated.
No migration was needed; no migration or consent-entrypoint registry additions were needed.
The new integration file is registered in `test:rls`, but the full command was not run.

## Remaining / not claimed

Claude independent QA and commit are pending. Host-provided LIFF adapter/live configuration, real
LINE login and Ron/QA iOS/Android WebView acceptance remain prerequisites before activation.
Browser evidence here uses mocked adapters against exported handlers, not physical devices or
rendered visual acceptance. OAuth live exchange remains B-033's unavailable default transport.
No remote DB, deployment, external network request, git mutation, PR or flag activation occurred.
Fresh base DB readback confirms line_platform and all three portal settings remain disabled.

## Files changed

- `package.json`
- `src/app/accept/[token]/page.tsx`
- `src/app/t/layout.tsx`
- `src/server/b033-line-login-link.integration.test.ts`
- `src/server/line/bootstrap.test.ts`
- `src/server/line/bootstrap.ts`
- `src/server/line/login-link.ts`
- `20-build/specs/B-034-design.md`
- `public/line-bootstrap.css`
- `public/line-bootstrap.js`
- `src/components/line-invite-entry.tsx`
- `src/i18n/line-tenant.ts`
- `src/server/b034-tenant-liff.integration.test.ts`
- `src/server/line/tenant-entry.ts`
- `e2e/results/B-034/validation.md`
- `e2e/results/B-034/manifest.json`
