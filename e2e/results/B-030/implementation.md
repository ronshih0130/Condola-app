# B-030 implementation evidence

Historical round-1 evidence below. Subsequent independent QA returned FAIL; the round-2 corrections and current local validation are recorded in [fix-round-2.md](fix-round-2.md). Independent re-review remains pending.

2026-11-06T13:12:05-08:00 PT. Mode 2 delegated implementation in this checkout. Claude owns architecture, independent review and all git operations. No commit, push, PR, remote database, deployment, provider SDK or external network operation performed by this implementation. Provider fixtures and secrets are generated locally/in memory.

## Result

Local implementation checks PASS; independent Claude QA and CEO acceptance pending. `usage_subscriptions` remains default OFF. No prices, commercial tiers, provider choice, approved restriction rules, limit values or grace duration supplied. Existing B-029 OFF behavior retained. No historical event rewriting/backfill.

- Source-reconcilable `[from,to)` period totals, exact bigint strings, event IDs/counts and sandbox exclusion.
- Immutable unpriced plan versions; nullable limits/grace, no fabricated charge.
- Mock-only subscription states; exact-body HMAC-SHA256 with five-minute signing window, strict payload validation, dedupe, ordering and transition checks.
- Private tables, RLS, explicit role-only EXECUTE, pinned definer search paths and own-org admin/accountant reads.
- Persisted vendor assignment generation fixes dispatch A → assign B without dispatch → dispatch A; same-vendor retry remains deduped. Reenable tests cover existing intents and dispatches during OFF.
- Grace expiry/restricted/canceled state never blocks authorized retained-data reads. Operation restriction evaluation remains inert.

## Verification

Fresh local `condola_b030impl` on loopback port 55432, supplied stub + every migration in order + `npm run db:reset`. Integration suites clone this base independently. B-030 additionally calls `resetAndSeed()` before every test. No full `test:rls` run.

| Command/check | Result |
| --- | --- |
| Fresh migration/reset recipe | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, 0 errors / 15 pre-existing warnings outside changed code |
| `npm run copy:check` | 6/6 PASS |
| `npm run test:unit` | 992/992 PASS (981 main + 11 usage/rules), 0 skipped |
| `tsx --test --test-concurrency=1 src/server/b030-usage-subscription.integration.test.ts` | 13/13 PASS |
| `tsx --test --test-concurrency=1 src/server/b029-usage-events.integration.test.ts` | 5/5 PASS |
| `tsx --test --test-concurrency=1 src/server/prop07-usage-source-ids.integration.test.ts` | 5/5 PASS |
| `tsx --test --test-concurrency=1 src/server/usage-events.test.ts` | 4/4 PASS |
| `git diff --check` | PASS |

Earlier failures retained in local logs: incorrect `memberships` fixture table (fixed to `org_members`); local webhook missing consent entrypoint classification (classified as machine HMAC fixture, no human session); TypeScript env parameter mismatch (fixed to readonly string/undefined record). No failing check waived.

## Gateways

| Gateway | EXECUTE role |
| --- | --- |
| `app.b030_usage_summary(uuid,timestamptz,timestamptz)` | authenticated; pinned current admin/accountant only |
| `app.b030_plan_presentation(uuid)` | authenticated; pinned current admin/accountant only |
| `app.b030_apply_mock_event(uuid,text,bigint,text,timestamptz,text,integer,text)` | service_role; trusted local fixture handler |
| `app.b030_vendor_dispatch_source(uuid,uuid)` | service_role; trusted B-029 recorder |

Internal `b030_enabled`, `b030_admit_write`, `b030_require_reader`, `b030_track_assignment` grant no API-role EXECUTE. HTTP `POST /api/mock-subscription` additionally requires loopback host/database, explicit local mock switch and environment HMAC secret. Duplicate HTTP receipt returns 409 with no state change.

## Deferred / handoff

- Ron: prices/plan tiers; payment provider/keys; restriction rules; limit and grace values. Design contains these decisions; Claude must reflect them in canonical hub BLOCKED (outside delegated working tree).
- No retroactive recovery of unrecorded assignment changes while B-030 was OFF; no usage billing approved. Already-recorded dispatch histories are reconciled when reenabling.
- Immutable global plan configuration survives demo reseed; org-bound subscriptions, provider receipts and vendor assignment pointers are wiped before public demo parents.
- Independent Claude review, UI/browser acceptance, hosted verification, release gates and all git operations remain outside this implementation.

STOP POINT: LOCAL_IMPLEMENTATION_CHECKS_PASS; next: Claude review `20-build/specs/B-030-design.md` and working-tree diff; owner: Claude.

## Local log provenance

Raw test logs remain in local temporary storage; hashes bind these results without copying verbose logs into Git.

| Check | Local log | SHA-256 |
| --- | --- | --- |
| Fresh database/stub/all migrations/reset | `/private/tmp/b030-db-setup-final.log` | `4870b2bd37e3721fb0ac04a9255765bd76c3745224eaf6a48b1f729a8c7b0041` |
| Typecheck | `/private/tmp/b030-typecheck-verified.log` | `31811f73c689302da9dec45337d7bc263c8275836ec3a4b12582a14f9632977e` |
| Lint | `/private/tmp/b030-lint-final.log` | `5078252a304b240132248a3e22701410ef77538dc574b1b89bf4c4ad77e2ab53` |
| Copy | `/private/tmp/b030-copy-final.log` | `f0883abafe916891d8bb4c9e827f98bd63d3a3c44e073d024ae89be4c33a5a63` |
| Unit | `/private/tmp/b030-unit-verified.log` | `496c37b087ca1cd00eb0fe12f1f567539c889fc14998bb252ae5b059b5d90c74` |
| B-030 integration | `/private/tmp/b030-integration-final.log` | `6aa09fcecbf907e10595f316e578a092158967f1f8559e42812068447e023876` |
| B-029 integration | `/private/tmp/b030-b029-final.log` | `1f52e7b1fe03316733ea9761dbbfa8afba336668ad6f8192de3b8b5827363c7c` |
| PROP-07 usage integration | `/private/tmp/b030-prop07-final.log` | `6412552a210cf7cb43317633d9fb1fef86770fefbd67c3e328b6ddf7ecb98ad6` |
| B-029 usage unit standalone | `/private/tmp/b030-usage-unit-final.log` | `f0e689fe6908762029afee1392c514b72c32bfb11d016a8a74673acb6b0b3bc6` |
