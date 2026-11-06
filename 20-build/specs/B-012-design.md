# B-012 L2 design — comparison evidence

## 2026-11-06 local package 1 slice (PT, UTC-08:00)

Scope: package 1 of `/tmp/codex-evidence-B-012.md`, excluding the browser spec, under Claude's delegated local-edit ownership. No product implementation or migration changes are needed by this slice.

### What this proves

- Unit and database tests assert exact current/proposed dates, rent, frequency, payment day and deposit. The fixed comparison uses 2030 → 2031, 10000 → 12345 rent minor units, monthly → quarterly, day 1 → 15 and 20000 → 25000 deposit minor units, at currency scale 2. All six differences are true; identical terms produce six false flags; changing each field alone produces only its corresponding flag.
- Each required field independently rejects omission, empty string and whitespace in both dated and explicit open-ended modes. Only an explicitly supplied empty end date is valid for open-ended mode. Database tests require `invalid` and exact unchanged rows after every rejected request.
- The OFF matrix covers absent/false/string-true global controls, malformed global values/allowlists, missing membership, and absent/false/string-true/null/object/array org flags. Each case requires a null view, unavailable direct server call and authenticated action, no renewal entry, and the real renewal page's Next.js 404 signal. A successful authenticated action with both controls enabled is the positive control.
- The legacy lease page's `leaseDetail` output is byte-identical JSON to its flag-absent baseline on fixed synthetic lease data. This is server-data compatibility, not a browser/HTML baseline comparison.
- Full row snapshots cover every `public` and `app` table, including controls and audit/history rows; only `auth_sessions` is excluded for normal authentication-touch bookkeeping. Assertions detect updates/deletes as well as inserted rows. The checks prove zero domain changes across comparisons and OFF requests.
- Every test restores the original global control row and complete org flags. Separate restoration tests exercise both an absent row and a pre-existing OFF row with nested data, description and a microsecond timestamp, on success and simulated failure. PostgreSQL JSON text avoids JS timestamp precision loss.

### Flags and execution boundary

`lease_renewal` stays OFF in operational defaults. Tests enable both controls only inside a disposable localhost database clone, restore controls after each test, and drop the clone. No hosted environment, migration file, ownership record, git commit or push is touched. Existing migration files are applied only to the authorized local test database for verification.

The two modified test files were already registered: unit via `test:unit`; integration via `test:rls` → `test:rls:b021-base`. No new test file or package registration is required.

### Remaining work

- Package 1 browser coverage: individual rendered comparison rows, screenshots and existing-route HTML/browser baseline. Browser execution is explicitly excluded from this slice.
- Package 2 was outside the package 1 slice. Its local durable submission/link and server views are implemented in the packages 2/3 section below; UI rendering and release acceptance remain separate.
- Package 3 was outside the package 1 slice. Its local append-only history, attributed responses, correction concurrency/isolation, unknown dates and historical termination are implemented in the packages 2/3 section below.
- Independent Claude QA and orchestrator commit remain outside this local implementation pass; these checks are not release or whole-B-012 acceptance.

### Local verification

Target: localhost port 55432, `condola_b_012`; Node 20.20.2 / npm 10.8.2. Stub + all existing migrations and `npm run db:reset` passed. Typecheck, lint (0 errors; 15 warnings in untouched files), copy check and function-privilege gate passed. Focused unit/integration suites include all their pre-existing tests. No product defect found.

Claude re-ran after the r1 positive-control fix (2026-11-06 04:3x PT): `test:unit` 983/983 pass and `renewal-comparison.integration.test.ts` 7/7 pass (`/tmp/b012-unit.log`, `/tmp/b012-integration.log`); Codex QA r2 PASS.

Earlier logs: `/tmp/b012-db-setup.log`, `/tmp/b012-tests.log`, `/tmp/b012-typecheck.log`, `/tmp/b012-lint.log`, `/tmp/b012-copy.log`, `/tmp/b012-function-privileges.log`.

## 2026-11-06 local packages 2 and 3 implementation

Scope: delegated working-tree edits only. The hub specification and any reserve addenda remain untouched. The new migration is applied only to the explicitly disposable localhost database; no remote calls, git writes, deployment, or operational flag activation.

### Durable replacement and gateways

- `20261107040000_b012_durable_replacement.sql` adds private `app.b012_replacements`, `app.b012_notice_versions`, and `app.b012_response_versions`. Existing rows are not backfilled or rewritten. Missing `lease_renewal` gets a boolean-false/empty-allowlist default; existing controls are preserved.
- `src/server/lease-lifecycle.ts` exposes `submitLeaseReplacement`, `leaseLifecycleView`, `recordLeaseNotice`, and `respondLeaseNotice`. All pin `requireOrgScope`; mutations repeat current session, organization, actor/party and strict flag authorization inside their SQL gateway. The four SQL gateways grant EXECUTE only to `authenticated`, matching `tx`; internal helpers have no API-role execute grants. Every private table has RLS and no PUBLIC/anon/authenticated/service_role table privileges.
- Submission completes the durable link atomically, creates an unsigned `pending_signature` successor with copied lease parties, and freezes the predecessor. Completion here means the replacement submission/link is committed, not that anyone has signed or that the successor is active. No signature, document, invoice, balance, deposit credit, notification, or other agreement is inferred or copied.
- Request UUID uniqueness is organization-wide. The database computes SHA-256 over canonical JSONB terms, predecessor and actual actor. Exact retries return the existing successor without writes/audit duplication; changed payloads or another request for the same predecessor return conflict. Concurrent conflicts roll back the entire new-lease creation.
- Money uses the existing BigInt minor-unit parser, PostgreSQL bigint and decimal strings in views/digests. Existing deposit-policy triggers still enforce the frequency-adjusted cap; this gateway does not introduce an override or bypass.
- Submission checks a known predecessor end and a strictly later start; it never guesses the end of an open-ended predecessor. Proposed end may explicitly remain NULL. The authoritative inclusive overlap query runs after locks, covers whole-unit/room conflicts, and treats NULL end as unbounded. Preview overlap remains advisory and unchanged.
- Linked views project only lease terms/status/link metadata and history for the requested lease. Each neighboring lease is authorized separately. Tenant authorization requires the current tenant's own party binding; no access follows merely from knowing a predecessor/successor ID. Old/new server views expose `readOnly` and `previousLeaseId`; rendering these new views into product pages is not part of this package.

### Lock order and immutability

1. Global `lease_renewal` control SHARE, selected organization SHARE, actor session SHARE, live organization membership SHARE.
2. Discover the predecessor target, then acquire the existing `condola:record-archive:<org>:<kind>:<id>` transaction advisory SHARE keys in property → unit → room order, before physical lease/ancestor locks. Archive commands take the target key exclusively. Lock the predecessor UPDATE and reject any target/path change since discovery.
3. Exact request replay remains available for historical archived targets. For fresh submissions, take property SHARE, containing unit UPDATE, then target room UPDATE when present; reread active ancestry and parent identities under those locks. Recheck overlaps and current rental mode before inserting successor/parties and immutable replacement row. Existing overlap responses retain precedence over a mode mismatch. No conflicting lease is locked after acquiring the unit. One predecessor lock serializes simultaneous submissions; target UPDATE locks serialize distinct predecessors and conflict with ordinary creation's target SHARE locks.

Notice/response writers use the same controls/actor prefix and then the subject lease UPDATE; they do not lock units or alter lease terms. Party edits serialize against their lease(s), in UUID order when rebinding two leases. New predecessor-freeze triggers reject all UPDATE/DELETE of a replaced lease and mutations of its party bindings. The successor backlink and private histories cannot be rewritten/deleted/truncated. These protections remain active after the rollout flag is switched OFF; they preserve already-recorded evidence. Demo reset uses its existing replica-role cleanup and the explicit private-table wipe list.

### Notice and response semantics

- Notice records support renewal intent, non-renewal notice and historical early-termination notice. The actual actor, named party, immutable kind/source, occurrence date, intended effective date and server recording timestamp remain distinct.
- Corrections append a new version only when `expectedVersion` matches. The originating actor/party, organization, lease, kind and source cannot be reassigned by correction. Different party statements require their own records.
- Tenant, owner and management have independent response streams. Each response references an exact notice version and has its own expected response version. Correcting a notice neither changes nor upgrades prior responses to agreement with the new version. A stale notice or response version is rejected.
- Unknown dates are stored as SQL NULL and returned as JSON null. Historical termination records never update `leases`, invoices or ledger tables, even when the event/effective date is in the past.
- Owner eligibility uses the existing exclusive end boundary: `effective_to IS NULL OR effective_to > current_date`. An ownership ending today is expired for lifecycle reads, notice creation/correction and responses, including direct authenticated gateway calls.
- Successful server writes call masked `recordAudit` in the same transaction, switching to the existing service role only for the audit INSERT and then restoring authenticated. Audits contain identifiers/version only, not free-text notice bodies, dates, amounts or source documents. Preview/view calls are read-only and do not audit or notify.

### Validation and remaining boundaries

The migration is registered in the migration classifier and lease migration list; the integration file is appended to `test:rls` without running that entire chain. Seed cleanup explicitly includes all three private tables.

The focused integration suite covers exact/conflicting and simultaneous replay, two actual connections waiting on the predecessor lock, authoritative stale-preview overlap rejection, room/whole-unit boundaries, frozen predecessors/parties/backlinks, linked tenant/staff views, cross-org/session denial, append-only versions, independent responses, stale/concurrent corrections, NULL dates, historical termination with full unchanged-domain snapshots, large integer money, invalid terms/deposit policy, the 18-case OFF matrix, privilege catalogs and reset of nonempty histories.

Final local verification results are recorded below after execution. Package 1 browser screenshots/HTML baseline, new lifecycle UI rendering, independent Claude QA, architect commit, remote migration/staging and release acceptance remain outside this implementation pass. No whole-B-012 or release acceptance is claimed.

Prior implementation verification (before fix round 2): fresh `condola_b012impl` at `127.0.0.1:55432`, stub + every migration + `db:reset` PASS; new integration 17/17, existing renewal comparison 7/7, existing lease-create 4/4 (focused total 28/28); unit 983/983; copy check 6/6; typecheck PASS; lint 0 errors / 15 existing warnings. Logs remain under `/private/tmp/b012d-*`; this earlier passing suite did not cover the four subsequent independent QA findings.

## 2026-11-06 Mode 2 fix round 2

All four reported findings are addressed in the existing uncommitted migration and focused integration file:

- Exclusive owner expiry: tomorrow is a positive control; today and yesterday deny the real lifecycle view, notice create/correction and response wrappers plus direct authenticated SQL gateways. Full snapshots require zero domain/audit/user writes.
- Archive admission: property/unit/room fixtures reject archived ancestry with no writes. Six forced-wait races use the actual `archiveCommand` in both orders. Archive first holds its exclusive admission key while waiting on a physical row; submission must wait, then reject after archive commits. Replacement first holds shared admission through commit; archive waits, then rejects because of the new pending lease. Historical exact replay still performs no writes after archive.
- Creation serialization: four forced-wait races call actual `createLease` for whole-unit and room targets, with each side winning once. A contact-row barrier pauses ordinary creation after target admission; the observer verifies replacement waiting on that creator. The reverse order verifies ordinary creation waiting on replacement's unit lock. Four more races use different predecessors sharing a whole unit or room in both orders. Every race asserts the loser result and unchanged full snapshots after the winner, covering parties, signatures, invoices, audit, private history and auth users; no partial loser writes are accepted.
- Financial history: the historical-termination lease has an explicitly linked invoice, invoice line, ledger transaction and two balanced ledger entries. Tests assert the records exist, invoice total/link are correct, and PostgreSQL JSON text remains byte-identical immediately after both the notice and its correction, alongside the original full-domain snapshot comparison.

The existing flag-OFF early returns, server wrappers, legacy paths and product text are unchanged. All new admission queries run after the original enabled-controls check. Existing OFF-matrix tests remain green. This round does not change operational flags or any shared creation/archive implementation.

Validation: fresh `condola_b012impl` on `127.0.0.1:55432` rebuilt from the stub and every migration, followed by `db:reset`; no diagnostic function overrides. Typecheck PASS; lint 0 errors / 15 existing warnings; unit 983/983; copy 6/6. Each integration file ran separately with `--test-concurrency=1`: B-012 durable replacement 35/35, renewal comparison 7/7, lease-create 4/4, lease-create-archive 9/9 (55/55 total, zero failures/skips/cancellations). Final source-database readback: global renewal disabled, empty allowlist, zero enabled organizations and zero other connections. `git diff --check` passes.

Logs: `/private/tmp/b012-fix2-db.log`, `/private/tmp/b012-fix2-typecheck.log`, `/private/tmp/b012-fix2-lint.log`, `/private/tmp/b012-fix2-unit.log`, `/private/tmp/b012-fix2-copy.log`, `/private/tmp/b012-fix2-integration.log`, `/private/tmp/b012-fix2-renewal.log`, `/private/tmp/b012-fix2-lease-create.log`, `/private/tmp/b012-fix2-lease-create-archive.log`. Only the migration, integration file and this design document were edited in this round; prior uncommitted work is preserved. No full `test:rls`, browser, remote, deployment or git-write operation ran. Independent Claude QA and architect commit remain pending; no whole-feature or release acceptance is claimed.
