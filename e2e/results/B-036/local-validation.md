# B-036 local validation and implementer handoff

Date: 2026-11-06 PT (-08:00). Scope: local working-tree continuation; no candidate commit or release verdict.

## Implementation

Reuses B-033 flow, link, credential step-up, session and unlink services. The new portal selector checks current contact/B-026 account authority and company on every POST. Preferences select existing roles; they create no authority. OFF checks precede cookie/CSRF validation and all writes.

Owner property, home, statement and PDF reads intersect the current `property_owners` authority. Removed, future or archived ownership is denied. A report containing any unauthorized property line is denied as a whole. Tenant reads retain the existing my-lease helpers; vendor job capabilities cannot authenticate account or other portals.

No new migration, migration registry entry, flag activation or product copy is required. Existing translation keys are reused. The inherited staging-bundle script change replaces `printf | grep -q` pipelines with here-strings to avoid SIGPIPE under `pipefail`; the full unit suite includes the bundle test.

## Changed files

- `20-build/specs/B-036-design.md`
- `e2e/results/B-036/local-validation.md`
- `e2e-evidence/B-027/denial-inventory.md`
- `package.json`
- `scripts/pack-staging-bundle.sh`
- `public/line-bootstrap.js`
- `src/app/api/line/portal/route.ts`
- `src/server/line/portal.ts`
- `src/server/line/bootstrap.ts`
- `src/server/line/bootstrap.test.ts`
- `src/server/line/login-link.ts`
- `src/server/line/login-routes.ts`
- `src/server/identity.ts`
- `src/server/owner-scope.ts`
- `src/server/queries.ts`
- `src/server/b036-owner-liff.integration.test.ts`
- `src/server/b033-line-login-link.integration.test.ts`
- `src/server/consent-entrypoints.test.ts`

## Routes

New: `POST /api/line/portal`, registered in the consent-entrypoint and generated route inventories.

Updated via shared handlers: `GET /{t,v,o}/liff` (strict OFF 404 and authorized-role chooser), `POST /api/line/session`, `POST /api/line/bind`, `POST /api/line/invites/accept`, and `GET /api/line/login/callback` (verified-flow company/persona preference cookies). Existing `GET /api/pdf/statements/[id]` uses the tightened owner reader. Existing flow, reauthentication, webhook and unlink endpoints are exercised directly by integration tests.

## Acceptance coverage

All five hub Given/When/Then cases are covered in `src/server/b036-owner-liff.integration.test.ts`, using `cloneTestDatabase()` and `resetAndSeed()`:

| Acceptance | Executable coverage |
| --- | --- |
| Owner invite atomically accepts/binds with authorized properties/reports only | Successful exported accept handler, property/home/report/PDF positive and foreign controls, injected late failure rollback, replay, ownership removal/future/archive, mixed-property report denial |
| Multi-role switching rechecks role/company | Owner/tenant choices, query hints ignored, company switching, removed roles, foreign versus missing company denial, existing session resolution, current B-026 account mapping and flag |
| Wrong provider/channel or reused flow creates no mapping | Wrong audience/signing key, changed provider/channel configuration, consumed-flow replay; identity/link/session or full snapshots |
| Unfollow changes friendship without deleting account or reviving links | Signed exported webhook, duplicate and stale events, later follow after unlink, unchanged account and unlinked state |
| Email login remains after unlink | Org/global unlink, verified Email cookie and owner PDF access, LINE session revocation, other-company link preservation, missing recovery/admin rejection, queued capture-only Email fallback exactly once |

Additional coverage: all three personas across nine OFF/missing/malformed flag configurations (including no-cookie POST), CSRF/origin, stale legal consent, lost/mismatched WebView cookies, token-free URLs, tenant own-lease scope, and a real single-job capability denied by portal/account routes. Unit tests exercise the local bootstrap script using an injected SDK; no provider SDK is downloaded.

## Checks

Fresh database `condola_b036impl` on `127.0.0.1:55432`: dropped/recreated, local Supabase stub and every migration applied with `ON_ERROR_STOP=1`, then seeded using the supplied local environment recipe. Integration files were each invoked separately with `tsx --test --test-concurrency=1` and `CONDOLA_RLS_DISPOSABLE=YES`.

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS; 0 errors, 16 warnings in unchanged code |
| `npm run copy:check` | 6 PASS |
| `npm run test:unit` | 1036 PASS |
| B-036 owner LIFF integration | 57 PASS |
| B-033 login/link integration | 79 PASS |
| B-033 foundation integration | 94 PASS |
| B-027 denial inventory integration | 28 PASS, including ordinary comparison after regeneration |
| `git diff --check` | PASS |

No failed, skipped or cancelled cases in final runs. Local raw logs, including initial failures, remain under `/private/tmp/b036-continuation/`.

Initial failures retained: the first B-036 invocation used disposable consent `1` instead of required `YES` and stopped before DB access; corrected invocation passed. B-027 initially passed 27 cases and failed only its generated inventory comparison (new portal route and changed query line anchors). Reviewed those differences, regenerated with `B027_WRITE_INVENTORY=1`, then passed a normal non-writing run.

## Remaining boundary

Claude independent architecture/QA review and all Git operations remain with the architect. Ron/QA real iOS/Android LIFF, external-browser and cookie-context device evidence is still required before activation. Mocked local acceptance does not establish device, staging, release or production acceptance. Live SDK/OAuth/provider transport is outside this task; the existing Email entry remains available.

No external network calls, live LINE HTTP, remote DB operations, deployment, full `test:rls`, git commit/push/branch/checkout/reset/stash or PR operations were performed. Flags remain OFF in shipped configuration.

STOP POINT: LOCAL_IMPLEMENTATION_VALIDATED; next: Claude reviews this working-tree diff and local evidence; owner: Claude architect.
