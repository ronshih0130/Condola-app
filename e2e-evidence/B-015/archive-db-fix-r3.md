# B-015 fix round 3 — delegated local implementation

2026-11-06. Claude remains architect, sole git committer and independent QA owner. This report describes the uncommitted working tree and disposable local validation only.

## Findings → changes → regressions

| Finding | Change | Regression evidence |
| --- | --- | --- |
| Global contention mapping changed OFF callers | `src/server/errors.ts` restored byte-for-byte to HEAD. `record-archive-errors.ts:13` maps only 55P03/40P01 carrying the enabled DB admission tag; `db.ts:241` applies that adapter after rollback. SQL admission emits the tag only inside the positively enabled block (`20261107010000_b015_archive_db_invariants.sql:209`). `record-archive.ts:114` tracks positive enablement before returning command busy. | `b015-archive-boundaries.test.ts:56`: actual action module + actual transaction/rollback mapper asserts all eight redirect callers, property result, both lease fallbacks, both SQLSTATEs and exact query sequence. `:94` covers before-enable/disabled/enabled command outcomes. DB tests `:318` retain generic untagged contention under both flags, `:305` prove ON raw-writer busy, and `:392` prove actual INSERT/UPSERT 40P01 tags plus whole-transaction rollback. |
| Room reparenting could escape inherited archive | SQL `:155` discovers both source/destination paths, locks all distinct properties then units in UUID order with NOWAIT, and rechecks ancestry under those locks. Source property/unit or room archive rejects the move until restore. | `b015-archive-db-invariants.integration.test.ts:292`: property/unit/room archive escape rejected, original parent unchanged, explicit restore permits move and OFF retains legacy move. `:305`: two-connection source property/unit archive races return 55P03/busy before commit and reject after commit. |
| Archived owner links had no name | `src/app/m/archive/page.tsx:8` uses `x.name` for owner link text; non-owner labels stay unchanged. | `b015-archive-boundaries.test.ts:111`: populated EN/zh-TW owner list renders a nonempty anchor name and correct archived status; room labels retained. Frozen OFF owner/archive HTML fixtures still pass byte-for-byte. |

The tag is intentionally narrower than a new caller-level flag lookup: only the DB guard that actually ran after positive enablement can emit it. Untagged errors retain legacy behavior even when the flag is ON. This adds no OFF query, exposes no raw database detail, and performs no automatic retry. The DB retains the original SQLSTATE for raw clients.

## Fresh local setup and checks

Recreated `condola_b015impl` on `127.0.0.1:55432`, applied the stub and every migration in filename order, then ran `npm run db:reset` using the authorized local environment file. Verified `.env.local` is absent so it cannot override the selected local database. Node 20.20.2 / npm 10.8.2. Logs: `/tmp/b015-r3-db-setup-final.log`, `/tmp/b015-r3-db-reset.log`.

| Check | Result | Log |
| --- | --- | --- |
| `npm run typecheck` | PASS | `/tmp/b015-r3-typecheck.log` |
| `npm run lint` | PASS: 0 errors, 15 existing warnings | `/tmp/b015-r3-lint.log` |
| `npm run copy:check` | 6/6, no failure/skip | `/tmp/b015-r3-copy.log` |
| `npm run test:unit` | 995/995, no failure/skip | `/tmp/b015-r3-unit.log` |
| Targeted boundary suite (included in unit total) | 14/14 | `/tmp/b015-r3-boundaries.log` |
| `git diff --check` | PASS | Read-only check |
| `errors.ts` byte comparison with `git show HEAD:src/server/errors.ts` | identical | Read-only comparison |

Each integration file was launched in its own process, sequentially, using the installed executable:

```sh
DATABASE_URL=postgres://condola:condola@127.0.0.1:55432/condola_b015impl \
CONDOLA_RLS_DISPOSABLE=YES \
./node_modules/.bin/tsx --test --test-concurrency=1 src/server/<one-file>.integration.test.ts
```

| Integration file | Passed | Log |
| --- | ---: | --- |
| `b015-archive-db-invariants.integration.test.ts` | 69 | `/tmp/b015-r3-invariants.log` |
| `record-archive-admission.integration.test.ts` | 31 | `/tmp/b015-r3-record-archive-admission.log` |
| `record-archive.integration.test.ts` | 6 | `/tmp/b015-r3-record-archive.log` |
| `record-archive-finance.integration.test.ts` | 10 | `/tmp/b015-r3-record-archive-finance.log` |
| `b015-off-matrix.integration.test.ts` | 29 | `/tmp/b015-r3-b015-off-matrix.log` |
| `tenant-directory.integration.test.ts` | 6 | `/tmp/b015-r3-tenant-directory.log` |
| `tenant-directory-edit.integration.test.ts` | 28 | `/tmp/b015-r3-tenant-directory-edit.log` |
| `lease-create.integration.test.ts` | 4 | `/tmp/b015-r3-lease-create.log` |
| `lease-create-archive.integration.test.ts` | 9 | `/tmp/b015-r3-lease-create-archive.log` |
| `archived-lease-signed-pdf.integration.test.ts` | 3 | `/tmp/b015-r3-archived-lease-signed-pdf.log` |
| `tenant-lease-history.integration.test.ts` | 6 | `/tmp/b015-r3-tenant-lease-history.log` |
| `property-owner.integration.test.ts` | 1 | `/tmp/b015-r3-property-owner.log` |

Total: **202/202 integration tests**, 0 failed, 0 skipped, 0 cancelled. All 12 files were executed separately; full `test:rls` was not run.

## Preserved failure and outstanding scope

The initial fresh setup failed parsing the new PL/pgSQL `IS DISTINCT FROM CASE` expression. The CASE was parenthesized, then the database was dropped/recreated and the entire stub/migration/reset recipe passed. Initial failure retained in `/tmp/b015-r3-db-setup.log`; no failing migration or test was waived.

All requested local fixes and checks are complete. Independent Claude QA/commit remains pending. Browser acceptance, build/release gates, hosted migration/catalog validation, staging/production, and whole-feature/pilot acceptance were not performed or claimed. No git commit/push/branch/checkout/reset/stash, PR, external network call, remote DB access, deploy or shared flag activation occurred. Existing uncommitted work was preserved.
