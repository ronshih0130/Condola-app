# B-015 — reproducible OFF behavior (gap 3)

This slice adds local integration evidence for the existing archive and tenant-directory implementation. It does not complete all of [B-015](B-015.md), change application behavior, add a migration, or authorize activation. Claude owns the repository lock, commits and independent QA; Codex's delegated scope is this test, the `test:rls` entry and this document.

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

Only a disposable test clone temporarily enables controls for positive fixtures, then restores exact rows and flags. No runtime defaults, registry flags, production/staging controls or migration files are changed. The test is appended to `npm run test:rls` with concurrency 1.

## Remaining gaps 1–2

1. **Owner-only archive marker:** `ArchiveKind` still supports property/unit/room only. Owners share `contacts.archived_at` with other contact roles; this is not a distinct owner archive contract. Add a separately reviewed owner marker and owner-specific command/read behavior, with evidence that tenant/vendor roles, identity and history are preserved. This needs a reviewed migration and independent acceptance.
2. **Database-level archive invariants:** participating application writers use ancestry locking and dependency checks, but this slice does not establish enforcement for old/raw writers bypassing those helpers. Marker protection, database gateways/admission and owner assignment/archive concurrency need a reviewed migration, concurrency tests and authorized target validation/application. Existing proposals in [`archive-db-handoff-draft.md`](../../e2e-evidence/B-015/archive-db-handoff-draft.md) are not executable closure or apply-ready evidence.

These gaps remain open. Local tests do not establish full release-gate, browser, staging, pilot or whole-feature acceptance.

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

Re-ran on `condola_b015`: typecheck ✓, lint 0 errors ✓, copy:check ✓, `test:unit` 981/981 ✓, `b015-off-matrix.integration.test.ts` 25/25 ✓, `cf:build` ✓. Codex QA r1 **PASS** with one LOW (both controls flipped together, so a gate reading the wrong feature's flag would still pass). Addressed by Claude (Mode 1): two asymmetric cases — each feature fully ON while the other's organization opt-in is false — prove each command reads its own **organization opt-in** (ON feature writes; OFF feature disabled with unchanged business rows). Global settings stay identical in these cases, so per-feature global-key isolation is not separately proven (QA LOW; follow-up: reciprocal global-OFF cases with both opt-ins true). Matrix now 27/27.
