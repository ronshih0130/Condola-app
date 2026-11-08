# B-016 owner billing profile contract

**PROPOSAL ONLY — NOT APPLY READY.** Local delegated packages 3 (pure rules) and 4,
2026-11-06 PT. Claude holds repository ownership and remains the sole git committer.
This document describes disconnected TypeScript contracts, not durable storage or a release.

## Contract

- A profile is scoped by organization, owner contact and profile ID. Each version has an explicit
  version ID and date-only `[effectiveFrom, effectiveTo)` interval; null end means unbounded.
  Selection never guesses a start date or picks a winner among overlapping versions. Any overlap
  or duplicate version ID in the scoped timeline rejects; gaps return unavailable.
- Lease inheritance records profile/version IDs plus a detached, recursively frozen issuance
  snapshot. Its references are collector account, fee rule, fee rule version and optional reserved
  prepay drawdown rule. Deposit holder and Q1 values are captured as facts. There is no copied
  editable profile, per-lease settings editor, assignment write or automatic refresh of old snapshots.
- Q1 `start`, `period`, `proration`, `basis`, and `timing` must all be explicit null. Missing/non-null
  fields reject. Validation and JSON serialization preserve null; legacy `flat` defaults do not enter
  this contract. Future Q1 choices require an approved contract revision.
- The fee-snapshot helper accepts an explicit synthetic percentage rule, version, basis in bigint
  minor units, bigint basis points and explicit `half_up` rounding. Multiplication, division and
  rounding use BigInt throughout; JSON uses decimal strings. This narrow calculation is testable
  without selecting a real fee basis, timing, period, currency or rate policy. Values 1000/1500 bp are
  fixtures, not proposed defaults. Existing statement arithmetic is unchanged.
- B-003 compatibility accepts only same-organization, visible, unarchived account metadata with
  either no property restriction or a matching property. It returns account/org IDs only. Gate OFF
  returns no reference and does not even read account metadata. Future callers must obtain metadata
  through authorized B-003 access; this pure predicate is not an authorization boundary or assignment API.
- The injected extension wrapper enters new work only for literal boolean true. Absent, false and
  string `"true"` return the exact legacy result, without invoking extension writes/providers. It is
  deliberately disconnected and does not implement a live feature flag or save controller.
- Deposit refund is deposit minus explicit deduction, rejecting deductions above the deposit.
  Owner prepay is returned unchanged, and prepay drawdown is zero. No executor or confirmation
  capability exists for company invoices or owner prepay: both remain deferred to PROP-MF-03.

## Proposed durable design — not implemented

An approved future migration should add organization-scoped profile identities and immutable version
records alongside existing agreements/rules, plus immutable lease inheritance references/snapshots.
It must enforce same-org composite references, effective-period non-overlap and version uniqueness in
the database, retain all five Q1 columns nullable without defaults, and prevent updates/deletes of
issued snapshots. Fee rule versions need their own immutable history rather than a mutable rule ID
alone. Legacy reports and agreements must remain readable without backfill-derived policy guesses.

Before SQL can be apply-ready: settle profile/property precedence and currency semantics; decide
approved Q1 options; design RLS, authorized/audited writes, locking and concurrency behavior,
collector revalidation, archive handling, upgrade/backfill/rollback behavior, and database constraints;
obtain independent review and application approval. No SQL or migration is supplied by this slice.
Any later proposal SQL belongs under `e2e-evidence/B-016/*.sql.txt`, not `supabase/migrations`.

## Clause evidence

| Slice | Executable evidence | What remains |
| --- | --- | --- |
| A3 boundaries; MF1/MF2; US-R1/US-A1 | `src/server/owner-billing-profile-rules.test.ts`: adjacent boundaries, gaps, organization/owner/profile scope, overlap and duplicate rejection, immutable inheritance | Durable versions, lease creation integration, authorization/audit |
| MF4; US-A2 | Same file: five null fields survive validation/JSON; missing/non-null values reject | Approved Q1 decisions and editor |
| A3 issued fee history | Same file: 1000/1500 fees, source edit isolation, values beyond 2^53; `src/server/b016-fee-report.integration.test.ts`: real January issue, rule edit, February issue, January replay | Runtime version resolver and audited fee edits |
| MF3; US-R2 | `src/server/b016-compatibility.test.ts`: same-org/property eligibility, foreign/wrong-property/archive/visibility rejection, OFF nondisclosure | Authorized B-003 profile adapter and lease assignment wiring |
| US-R3; MF5 | Same file: refund/prepay independence and excessive-deduction rejection, MF-03 deferred | MF-03 remains separate and unavailable |
| US-R4 | Same file: absent/false/string-true zero extension writes/provider calls; no runtime imports | Actual future flag registration and Ron activation decision |

The real report test modifies the existing fee rule after January issuance, checks February uses
the changed rate, and compares January's complete fee snapshot, all seven totals, and all line rows
both before and after January replay. It restores source payment/rule/flag values and invoice links,
then removes its statement fixtures. This establishes legacy snapshot retention, not a versioned
profile resolver in `generateStatement`.

## Verification

Local logs: `/tmp/b016-local-verification/`. Dedicated database: `127.0.0.1:55432/condola_b016`.
Created fresh; applied the existing stub plus all 114 existing migrations in filename order;
`npm run db:reset` passed. No new migration was created. Node 20.20.2 / npm 10.8.2.

- Focused pure tests: 10/10 PASS.
- Report regression plus `statement-preview.integration.test.ts`: 10/10 PASS, no skips.
  Two expected SQLSTATE 40001 diagnostic lines came from existing concurrency tests, which passed.
- Typecheck: PASS. Lint: PASS, zero errors / 15 existing warnings; none in new files.
  Copy guard: PASS 6/6. Full unit rerun: PASS 991/991, no skips.
- Initial full unit run: 990/991 PASS, one FAIL in unchanged `staging-bundle.test.ts`,
  `scripts/pack-staging-bundle.sh:85` reporting `printf: write error: Broken pipe`.
  Preserved in `unit.log`; isolated unchanged staging test then passed 1/1
  (`staging-bundle-isolated.log`), followed by the full passing rerun (`unit-rerun.log`).
  No staging script/test was changed or failure waived.
- Native independent read-only source review: no blocking findings; no tests run by reviewer.
  This is a same-model review and does not replace Claude Class B sign-off.

No full RLS suite, release gate, browser, staging, production, migration acceptance or whole-B-016
acceptance is claimed. Runtime callers, flag declarations, user-facing copy and existing migrations
are unchanged. Test registration alone does not mean the full `test:rls` suite was executed.
