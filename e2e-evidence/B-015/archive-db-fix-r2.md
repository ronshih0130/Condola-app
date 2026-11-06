# B-015 gaps 1–2 — fix round 2 local implementation report

Mode 2 delegation, 2026-11-06 PT. Claude remains architect, independent QA and sole git committer. All nine r1 findings have local implementation and regression coverage; this report is not an independent QA verdict or release approval.

Paths below are relative to the repository root. `SQL` denotes `supabase/migrations/20261107010000_b015_archive_db_invariants.sql`; `DB tests` denotes `src/server/b015-archive-db-invariants.integration.test.ts`; `boundary tests` denotes `src/server/b015-archive-boundaries.test.ts`.

| r1 finding | Change (file:line) | Regression evidence |
| --- | --- | --- |
| Unit reparent validates only destination | SQL:131 locks old/new properties in UUID order with NOWAIT, rejects archived source/own marker and all retained unit dependencies (including historical rows). No dependency migration. | DB tests:271 active→active whole-unit leased move rejects; source archive remains blocked and destination archive succeeds. DB tests:283 requires explicit source/unit restore and permits an empty valid move. |
| Property restore ignores archived owners | SQL:257 locks retained current owner contacts in UUID order; any owner/shared archived marker blocks restore. | DB tests:292 sequential property archive→owner archive→property restore; DB tests:300 deterministic restore/archive races in both orders. |
| Whole-unit lease admission uses stale mode | SQL:180 rechecks both target modes after retaining the actual unit lock. | DB tests:314 waits for a real lock edge while whole_unit→by_room is uncommitted; the lease rejects after the mode commits. |
| Raw maintenance active work unguarded | SQL:158,175,197 adds active INSERT/reopen/ancestry admission. Room-only references retain their resolved unit. SQL:78 is a narrow lock-only definer for maintenance staff/tenants, authorized by role or exact tenant lease ancestry before/after waits; existing ticket RLS remains intact. | DB tests:325 rejects insert/reopen for property/unit/room archives and preserves OFF. DB tests:336 tests both insert/archive orders; :405 room-only unit blocker; :410 reopen NOWAIT; :420 cross-org/incorrect-lease rejection and legitimate maintenance/tenant locks. Existing admission role and real tenant writer races pass. |
| NOWAIT surfaced as generic error | src/server/errors.ts:62,69 maps raw/wrapped 55P03 and 40P01 to errors.busy; src/server/record-archive.ts:145 returns busy. src/i18n/errors.ts:6 and src/i18n/record-archive.ts:3 reuse existing i_portal_timeout copy; src/components/record-archive.tsx:23 renders busy. | Boundary tests:55 invokes actual owner/property/space/lease/ticket/repair actions with failed IO, checking redirect/action responses, bilingual copy and exactly one attempt for each code. Boundary tests:81 verifies archiveCommand rollback→busy. |
| File COMMIT breaks runner ownership | SQL:1 removes all file-level transaction control and session settings. Runner owns DDL/history transaction. | DB tests:389 reapplies the entire migration inside a runner transaction, fails the appended history insertion, then verifies probe/DDL rollback and original function OIDs. |
| Owner UI and list title change OFF pages | src/app/m/owners/[id]/page.tsx:30,38 gates entry; src/app/m/archive/page.tsx:8 gates owner wording; src/server/record-archive.ts:28 uses the strict existing conjunction; src/i18n/record-archive.ts:3 defaults to legacy wording. | Boundary tests:30 renders real page functions and compares en/zh-TW OFF HTML byte-for-byte against frozen pre-owner fixtures, plus positive ON checks. DB tests:142,188 exercise malformed/global/org OFF controls through the actual UI flag reader. |
| Unsafe definer relation resolution | SQL:32 and every new function use search_path=pg_catalog,public,app,pg_temp; SQL:199 fully qualifies dependency relations (all other new definer relations are qualified too). | DB tests:182 validates all eight function ACLs/search paths; :381 creates a temporary leases shadow and proves the real dependency still blocks archive. |
| Missing upsert/opposing-batch coverage | SQL:11 documents per-row ordering and possible 40P01 for opposite batches; shared busy mapping handles both codes after whole-transaction rollback, without automatic retry. | DB tests:348 exercises INSERT ON CONFLICT for five guarded tables (insert/conflict branches); :358 deterministically deadlocks opposing two-parent INSERT and UPSERT batches and verifies exactly one full two-row winner, no partial loser. :225 and :410 cover 55P03. Boundary tests:55,81 cover caller outcomes. |

## Verified results

Fresh local DB: PostgreSQL 16.15, `127.0.0.1:55432/condola_b015impl`; Node v20.20.2, npm 10.8.2. Dropped/recreated the database, applied the supplied stub and every migration, then ran `npm run db:reset` with the authorized local environment. No remote database, external network, deployment, Git mutation or PR action was performed. `ops/flags.yaml` has zero diff; final source DB has zero record_archive-enabled organizations and zero enabled platform control rows. Synthetic opt-ins are isolated in disposable test clones.

| Check | Result | Log |
| --- | --- | --- |
| typecheck | PASS | `/tmp/b015-r2-typecheck-verified.log` |
| lint | PASS, 0 errors / 15 existing warnings | `/tmp/b015-r2-lint-verified.log` |
| copy:check | 6 passed / 0 failed / 0 skipped | `/tmp/b015-r2-copy-verified.log` |
| test:unit | 987 passed / 0 failed / 0 skipped (includes 6 new boundary tests) | `/tmp/b015-r2-unit-verified.log` |
| 12 selected integration suites | 195 passed / 0 failed / 0 skipped (includes 62 DB invariant tests) | `/tmp/b015-r2-integration-verified.log` |
| Fresh DB setup/reset | PASS | `/tmp/b015-r2-db-setup-verified.log`, `/tmp/b015-r2-db-reset-verified.log` |
| diff whitespace check | PASS | `git diff --check` |

Integration command (direct installed executable; no full test:rls):

```sh
DATABASE_URL=postgres://condola:condola@127.0.0.1:55432/condola_b015impl CONDOLA_RLS_DISPOSABLE=YES \
./node_modules/.bin/tsx --test --test-concurrency=1 \
 src/server/b015-archive-db-invariants.integration.test.ts \
 src/server/record-archive-admission.integration.test.ts \
 src/server/record-archive.integration.test.ts \
 src/server/record-archive-finance.integration.test.ts \
 src/server/b015-off-matrix.integration.test.ts \
 src/server/tenant-directory.integration.test.ts \
 src/server/tenant-directory-edit.integration.test.ts \
 src/server/lease-create.integration.test.ts \
 src/server/lease-create-archive.integration.test.ts \
 src/server/archived-lease-signed-pdf.integration.test.ts \
 src/server/tenant-lease-history.integration.test.ts \
 src/server/property-owner.integration.test.ts
```

## Preserved failures and limits

Initial failures remain in `/tmp/b015-r2-boundaries-first.log` (incorrect action test name), `/tmp/b015-r2-typecheck-first.log` (Locale types), `/tmp/b015-r2-lint-first.log` (test loader variable name), `/tmp/b015-r2-invariants-first.log` (test unit-label collision), and `/tmp/b015-r2-integration-final.log` (two real tenant-role regressions). All were corrected and rerun. The role failures led to the narrow authorized lock-only ticket helper; no RLS or broad table grants were weakened.

Rendered-page evidence is server HTML with request/IO boundaries mocked, not browser acceptance. Mutation-based checks were run only on disposable local DBs. Independent Claude QA remains pending. Full test:rls, build/browser/release gates, hosted catalog/apply, staging/production, publishing/committing and whole-feature/pilot acceptance were not performed. No requested implementation or local validation remains incomplete.
