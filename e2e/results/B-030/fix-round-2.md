# B-030 fix round 2 — local evidence

2026-11-06T13:32:16-08:00 PT. Delegated implementer only; Claude owns architecture, independent QA and all git commits. The incoming independent review was FAIL. This record reports corrections and local validation, not independent approval.

## Finding → change → regression

| Finding | Change | Regression |
| --- | --- | --- |
| ON read → OFF admission loses B-029 recording | `src/server/usage-events.ts:135` consumes the explicit OFF result from `supabase/migrations/20261107070000_b030_usage_subscription_state.sql:226`; only OFF falls back, invalid source stays empty | `src/server/usage-events.test.ts:74` asserts OFF query order/invalid-source separation; `src/server/b030-usage-subscription.integration.test.ts:300` toggles global/org flags on another connection between read and admission, verifies B-029 event and zero private writes |
| Assignment generation errors abort business writes | Migration `:187` isolates telemetry with an exception subtransaction, capped lock timeout, fixed diagnostic/SQLSTATE and audit-based generation; `:250` reconciles missed generations | Integration `:329` injects a generation trigger error, verifies create/reassignment/dispatch commit and A→B→A recovery/retry dedupe (both all-failed tracking and successful B tracking followed by a failed return to A); `:372` holds a conflicting admission lock, verifies committed business rows and timeout restoration |
| Timezone-less and millisecond-rounded periods | `src/server/usage-subscriptions.ts:17` uses strict `usagePeriodInstant` at `src/server/b030-subscription-rules.ts:75`; validates explicit offsets/calendar dates and exact bigint microseconds | Rules test `:73` covers positive/negative offsets, DST fold/spring boundary, unsupported precision; integration `:283` checks one-microsecond half-open periods, equal/reversed instants, late-arrival refresh and exact provenance |
| Incorrect add-only manifest classification | `scripts/write-pr-migrations.mjs:333` sets false and describes constraints, revokes/EXECUTE grants and assignment trigger | `scripts/write-pr-migrations.test.mjs:33` checks the generated manifest row/rationale |

## Verification

Fresh disposable PostgreSQL 16.15 at loopback port 55432, database `condola_b030impl`: dropped/recreated only that authorized local DB, applied stub and all migrations, sourced the supplied local fixture environment without printing values, ran `npm run db:reset`. After the final SQL recovery-edge adjustment, the base was recreated again and every integration file rerun **separately**, sequentially, with `--test-concurrency=1`; each suite uses its own disposable clone.

| Check | Result |
| --- | --- |
| Fresh migration/reset recipe | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, 0 errors / 15 existing warnings outside round-2 edits |
| `npm run copy:check` | 6/6 PASS |
| `npm run test:unit` | 994/994 PASS (981 main + 13 usage/rules), 0 skipped |
| Focused usage/rules/manifest | 15/15 PASS (overlaps full unit run) |
| B-030 usage subscription integration | 17/17 PASS |
| B-029 usage events integration | 5/5 PASS |
| PROP-07 usage source IDs integration | 5/5 PASS |
| `git diff --check` | PASS |

Expected fault-injection diagnostic: `usage_event failed` with code `23514` and fixed `database error` text. No raw injected database exception detail is emitted by the telemetry logger. No test failure was waived. The final SQL-only recovery adjustment also reran focused manifest/usage/rules, typecheck and lint; the full unit run covers the unchanged unit-tested application logic. An optional process inventory using `ps` was denied by the local sandbox; completion is based on command exit codes/test summaries, not a global process-drain claim.

## Recovery boundary and handoff

The existing business audit is durable across telemetry failures. Generation reconciliation restores future dedupe on the next admitted dispatch after repair, including A→B→A without B dispatch. With no prior private state, first admission retains the B-029 history baseline. No historical event replay or mutation is performed: outage-period usage can remain a measurement gap. Details are in [the design](../../../20-build/specs/B-030-design.md).

All requested implementation/validation work is complete. Independent Claude re-review remains pending. Full `test:rls` was intentionally not run. No git commit/push/branch/checkout/reset/stash, PR, external network call, remote database action or deployment was performed. Existing unrelated work remains in the working tree; the unapplied B-030 migration was edited in place. Application flags remain default OFF.

STOP POINT: FIX_ROUND_2_LOCAL_PASS; next: Claude independent review of working-tree diff and this evidence; owner: Claude.

## Local logs

| Check | Log | SHA-256 |
| --- | --- | --- |
| Fresh local DB, all migrations, reset | `/private/tmp/b030-r2-database.log` | `4870b2bd37e3721fb0ac04a9255765bd76c3745224eaf6a48b1f729a8c7b0041` |
| Typecheck | `/private/tmp/b030-r2-typecheck.log` | `31811f73c689302da9dec45337d7bc263c8275836ec3a4b12582a14f9632977e` |
| Lint | `/private/tmp/b030-r2-lint.log` | `5078252a304b240132248a3e22701410ef77538dc574b1b89bf4c4ad77e2ab53` |
| Copy | `/private/tmp/b030-r2-copy.log` | `e01d1a85f8fb766e5ccca3a92e8fb518e2729e159c07b718268a839502be75ec` |
| Unit | `/private/tmp/b030-r2-unit.log` | `149e810e31e950ff6ed8383d1e00dec41904f724d61f0f0ca4c29e687d556329` |
| Focused unit/manifest | `/private/tmp/b030-r2-focused.log` | `ccf78a83405c0f12be1637622ca2b35d030d7932fc5c37facdffe1035c3919ad` |
| B-030 integration | `/private/tmp/b030-r2-integration.log` | `41fe2ad906e268108f010425788eb27dfae1e6ac634d3a576b86c5d6775e29f1` |
| B-029 integration | `/private/tmp/b030-r2-b029.log` | `90ce8f72e7cd4312294443b006906ebc33615c805d16c2d67f718bdd2fe57231` |
| PROP-07 integration | `/private/tmp/b030-r2-prop07.log` | `43ca3250d6eb838f495813be23cb9a5304a8dc10c54d5f56562948132a659f36` |
