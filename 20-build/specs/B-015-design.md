# B-015 — archive invariants and reproducible OFF behavior

The original gap-3 slice below established OFF behavior. The subsequent delegated gaps-1–2 implementation adds owner-only archive metadata, a service-only gateway and flag-gated database invariants. Claude owns architecture, commits and independent QA; Codex edits this working tree and validates only on disposable local databases. This is local implementation evidence, not whole-feature or release acceptance.

## Slice proved

[`b015-off-matrix.integration.test.ts`](../../src/server/b015-off-matrix.integration.test.ts) uses the existing isolated clone/seed, archive ancestry, contact snapshot, lease-form and ended-history fixture contracts. It runs 23 OFF combinations for **both** `record_archive` and `tenant_directory_edit`:

| Global setting | Organization opt-in |
| --- | --- |
| Row absent; JSON false; object with `enabled: false`; malformed JSON null, string `enabled`, or non-array allowlist; empty allowlist | Key absent, boolean false, boolean true |
| Valid enabled object with the organization allowlisted | Key absent, boolean false |

Each case submits valid, fresh-version property/unit/room archive **and restore** requests and a valid name/email/phone edit. Archive returns `disabled`; editing records `rejected_disabled`. Complete business-row snapshots and the mutation-audit count remain identical. The edit rejection receipt is intentional command metadata, not a contact mutation or mutation audit.

The same case also proves:

- An actual foreign-organization tenant contact is rejected with `errors.notFound`, without business-row or mutation-audit changes. The same available room then accepts a local existing tenant and links the original contact and portal user, without changing or duplicating contacts/users.
- Authorized ended-lease list/detail remain readable through archived property/unit/room ancestry. With the independent PDF platform control OFF, metadata exposes no PDF list and the byte reader returns `null`, even with its environment and organization opt-ins enabled.
- Requests preserve every complete platform-setting row and every organization's whole flag object. A `finally` restoration round-trip compares those snapshots, including row absence, descriptions, JSON values and timestamp microseconds. A separate injected-failure test proves cleanup when a control row was originally absent.

An ON positive control first executes archive/restore for each target type, a contact edit and an exact stored-PDF byte read after archiving. This establishes that OFF assertions exercise otherwise-valid requests against real records, not invalid input or missing fixtures.

Snapshots cover full rows in properties, units, rooms, contacts, leases, lease parties/signatures, invoices, payments, identity documents, files, signed PDFs, profiles and auth users. Lease creation is an intentional success with its own assertion window; it is not included in the unchanged-business assertion for disabled requests.

## Flags

`record_archive` and `tenant_directory_edit` remain `default: false` in [`ops/flags.yaml`](../../ops/flags.yaml). Their global settings and organization opt-ins must both authorize a write. History reads and existing-tenant reuse remain available independently. Signed-PDF reads additionally require `TENANT_SIGNED_PDF_ENABLED`, JSON-true platform `tenant_signed_pdf` and organization opt-in.

The original gap-3 tests enable controls only in a disposable test clone, then restore exact rows and flags. The gaps-1–2 additive migration does not change runtime defaults, registry flags or production/staging controls. Both B-015 test files are registered in `npm run test:rls` with concurrency 1.

## Remaining gaps 1–2 — local implementation; independent QA pending

1. **Owner-only archive marker:** `ArchiveKind` includes `owner`, backed by nullable `contacts.owner_archived_at`, `owner_archived_by`, and `owner_archive_reason`. Archive/restore changes those fields only. The ON owner directory and assignment pickers hide archived owners; tenant/vendor roles, shared `contacts.archived_at`, identity, property ownership history, statements and files remain intact. Financial/history lists deliberately retain owners. Current assignments to active properties block owner archive.
2. **Database-level archive invariants:** [`20261107010000_b015_archive_db_invariants.sql`](../../supabase/migrations/20261107010000_b015_archive_db_invariants.sql) seals marker changes by actual API roles and guards raw lease activation/creation/moves, new owner assignment, unit/room insertion/reparenting, and active maintenance ticket insertion/reopening/moves. Unit reparenting rejects retained dependencies and archived source ancestry. Room reparenting locks both source/destination properties first, then both units in UUID order with NOWAIT, validates the locked ancestry, and rejects a directly or inherited-archived source until explicitly restored. Property restore locks current owners and rejects owner-archived assignments. Lease admission rechecks both target modes after its tuple-lock wait. The restricted gateway checks current session/org authority, locked version, active dependencies and restore ancestry. Every new enforcement path is gated by the strict record_archive platform/allowlist/org conjunction. OFF preserves prior raw behavior and performs no new gateway writes. Trusted service/definer authority remains unchanged.

Physical locks use **property → unit → room → contact**; raw UPDATE parent locks use NOWAIT to avoid a child-before-parent wait inversion. Deterministic two-connection tests prove both orderings of owner assignment/archive and lease creation/unit archive. The gateway requires READ COMMITTED so dependency checks see committed children after waiting. The exact enforcing objects, corrected scope of the former proposal, trust boundary and local validation are in [`archive-db-handoff-draft.md`](../../e2e-evidence/B-015/archive-db-handoff-draft.md), now an implemented handoff note.

The delegated API-role implementation and local regression evidence are in place; the fix-round-2 report records the nine reviewed findings and their checks. Independent QA, hosted catalog validation/application, browser, full release gate, staging and pilot/whole-feature acceptance remain separate pending states. API-role maintenance ticket writes are included. Existing trusted dispatch/signing/utility definers retain their authority and application admission. Opposing multi-parent raw INSERT/UPSERT batches may produce 40P01. Only positively enabled archive admission tags 40P01/NOWAIT 55P03 with the fixed `b015_archive_enabled_contention` detail; the transaction boundary maps that tag to localized busy after rollback without retry or another flag query. Untagged contention retains the exact legacy global mapping (`errors.generic`, including the lease-action `errors.leaseFailed` fallback), even if the flag is ON. The explicit archive command returns busy only after its existing flag check positively enables the operation. Migration transaction control belongs entirely to the runner.

## Local reproduction and validation

Use the authorized local environment file, explicitly select the dedicated `condola_b015` database on `127.0.0.1:55432`, and set `CONDOLA_RLS_DISPOSABLE=YES`. On a fresh database apply `supabase/stub/supabase_stub.sql`, then all existing migrations through `scripts/db-migrate.sh`. Check that `.env.local` cannot override the selected database before running `npm run db:reset`.

```sh
npm run db:reset
npm run typecheck
npm run lint
npx tsx --test --test-concurrency=1 src/server/b015-off-matrix.integration.test.ts src/server/record-archive.integration.test.ts src/server/tenant-directory-edit.integration.test.ts
```

Delegated local validation on 2026-11-06: fresh database creation, stub + all checked-in migrations and `npm run db:reset` passed; `npm run typecheck` passed; `npm run lint` passed with 0 errors and 15 warnings in unchanged files. The exact three-file command above passed **59/59 tests, 0 failures, 0 skips** (25 new tests: one positive control, 23 OFF cases and one failure-cleanup case). Logs: `/tmp/b015-db-setup.log`, `/tmp/b015-db-reset.log`, `/tmp/b015-typecheck.log`, `/tmp/b015-lint.log`, `/tmp/b015-integration.log`.

No full `test:rls` or release gate is claimed by this slice. Claude's independent QA and commit remain pending; no git commit/push/branch/checkout or claim-script operation was performed by the delegated editor.

### Orchestrator verification (Claude, 2026-11-06)

Re-ran on `condola_b015`: typecheck ✓, lint 0 errors ✓, copy:check ✓, `test:unit` 981/981 ✓, `b015-off-matrix.integration.test.ts` 25/25 ✓, `cf:build` ✓. Codex QA r1 **PASS** with one LOW (both controls flipped together, so a gate reading the wrong feature's flag would still pass). Addressed by Claude (Mode 1): two asymmetric cases — each feature fully ON while the other's organization opt-in is false — prove each command reads its own **organization opt-in** (ON feature writes; OFF feature disabled with unchanged business rows). A follow-up adds the reciprocal global-layer cases (both organization opt-ins true, the other feature's global row `enabled:false`), so each command is proven to read its own global key as well (QA LOW closed). Matrix now 29/29.

Fix-round-2 validation: [per-finding changes, regressions and final counts](../../e2e-evidence/B-015/archive-db-fix-r2.md).

## Fix round 3 — local correction; Claude QA pending

- `src/server/errors.ts` is restored byte-for-byte to HEAD. The separate archive error adapter consumes only the enabled DB guard's fixed contention tag; no OFF error text, caller query sequence, or retry behavior changes. Real action-module tests use the actual transaction/rollback mapper and assert OFF redirects, lease fallbacks, ON busy, and the exact query sequence for both SQLSTATEs. Explicit command tests cover before-enable failures, disabled requests and enabled contention.
- Raw room reparenting now validates both ancestor paths under retained canonical NOWAIT locks. Regression cases cover property/unit inherited archives, the room's own marker, explicit restore, legacy OFF moves, and concurrent source property/unit archive. Unrelated untagged contention remains generic under both flag values; real INSERT/UPSERT deadlocks retain the enabled-only tag and whole-transaction rollback assertions.
- Populated archive-list owner links render `x.name`. EN/zh-TW rendering tests assert nonempty visible/accessibility names and preserve space labels; frozen OFF page HTML remains identical.

The migration was edited in place and applied only to a fresh disposable local database at `127.0.0.1:55432/condola_b015impl` for these tests. No hosted application, git mutation, external network call or deployment is part of this round. Per-finding locations, final counts, commands and the preserved initial SQL parser failure are recorded in [the round-3 evidence](../../e2e-evidence/B-015/archive-db-fix-r3.md).
