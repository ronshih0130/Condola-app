# B-016 delegated pure-contract slice

2026-11-06 PT. **PROPOSAL ONLY — NOT APPLY READY. Whole B-016 remains incomplete.**
Scope: gap-plan package 2 disconnected email verification coordinator, package 3 pure rules plus existing-report regression, and package 4 compatibility.
Claude owns the lock and git commits. This delegation changes local files/tests only.

## Packages 3–4 slice proved

- Explicit half-open profile versions, ambiguity rejection and immutable lease inheritance with
  references; all five unresolved Q1 fields stay null without policy defaults.
- Explicit bigint fee snapshots survive later source edits, including values beyond Number precision.
- Existing `generateStatement` preserves January fee snapshot, totals and lines after a rule edit,
  February issuance and January replay. This uses existing schema and runtime code.
- B-003-shaped payee scope checks, strict OFF nondisclosure/no extension side effects, deposit/refund
  separation from owner prepay, and deferred MF-03 behavior, in disconnected pure/injected modules.

The exact clause-to-test mapping, storage proposal and limitations are in
[owner-billing-profile-contract.md](../../e2e-evidence/B-016/owner-billing-profile-contract.md).
Both new pure test files are registered in `test:unit`; the report regression is appended to `test:rls`.

## Remaining work

| Area | Remaining acceptance work |
| --- | --- |
| A1 regional company editor | Regional definitions, supported identifier/address editor, authorized audited saves, approved durable extensions and UI. Existing proposal is not apply-ready acceptance. |
| A2 email-change controller | Package 2 now exercises disconnected verification coordination with injected mocks. Durable pending state, initiation/reconciliation, real authorization/storage adapters, route integration and real-provider validation remain pending. |
| Durable profiles and A3 fee editing | Approved migration for organization-scoped identities/versions/references/snapshots, constraints/RLS, immutable rule history, audited writes, concurrency, backfill and rollback review. No migration in this slice. |
| A4 authorization | Company/email/fee save-path authorization remains unproved until controllers exist. Pure compatibility checks are not server authorization. |
| UI and runtime integration | Lease inheritance wiring, settings/editor flows, B-003 authorized adapter, report version selection and approved Q1 policy. No runtime callers added. |
| MF-03 | Company invoices and automatic owner-prepay drawdown remain explicitly deferred; no per-item confirmation workflow. |

Flags remain OFF in repository code. Activation still belongs to Ron. No user-facing copy changes,
new migrations, git commits/pushes, ownership operations or release actions were performed.

## Packages 3–4 local verification (prior slice)

Fresh local `condola_b016` database, existing stub + 114 existing migrations + `npm run db:reset`: PASS.
Node 20.20.2 and npm 10.8.2 match the pinned toolchain.

| Check | Result |
| --- | --- |
| New pure tests | PASS 10/10 |
| B-016 report + existing statement preview integration | PASS 10/10, no skips |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, 0 errors / 15 existing warnings; no new-file warnings |
| `npm run copy:check` | PASS 6/6 |
| `npm run test:unit` | Rerun PASS 991/991, no skips; initial failure retained below |
| Native independent source review | No blocking findings; same-model read-only review |

Raw command logs are in `/tmp/b016-local-verification/`. Expected serialization-conflict diagnostics
in existing concurrency tests remain visible. Full RLS, browser/staging/release gates and independent
Claude Class B sign-off are not supplied by this slice.

The first full unit run passed 990/991, with the unchanged staging-bundle test failing at
`scripts/pack-staging-bundle.sh:85` (`printf: write error: Broken pipe`). The original failure remains
in `unit.log`. The same staging test passed 1/1 in isolation, then the full suite passed 991/991;
see `staging-bundle-isolated.log` and `unit-rerun.log`. No staging code or test was changed or waived.

STOP POINT: LOCAL_SLICE_VERIFIED_CLAUDE_REVIEW_PENDING; next: `git status --short`; owner: Claude@ron-mac.

### Orchestrator review (Claude, 2026-11-06)

Claude changed `b016-fee-report.integration.test.ts` to run on an isolated, freshly seeded clone (`cloneTestDatabase` + `resetAndSeed`): the delegated version mutated the shared disposable DB in place (restored in `finally`) and failed when a previously run suite such as `statement-preview` (which itself mutates its DB and is not repeatable without a reset) had changed the seed. Re-verified: the B-016 test passes twice back-to-back; with `statement-preview` on a fresh reset 10/10; `test:unit` 991/991; typecheck/lint/copy/cf:build pass.


## Package 2 — disconnected email verification coordinator (2026-11-06 PT)

`src/server/staff-email-flow.ts` coordinates the existing mock adapter's verification step using
injected authority, pending-state, canonical-readback and atomic identity-commit ports. It has no
route callers, default transport, credentials, persistence implementation or UI. Initiation remains
in the existing mock adapter; this package does not create a durable pending request or resend it.
The admission flag is an injected test contract, not an operational feature flag or activation.

Done-means, mapped to `src/server/staff-email-flow.test.ts` (registered in `test:unit`):

- `partial verification preserves trusted identity in both mailbox orders`: login, recovery and
  profile mirrors remain old, pending is unchanged and identity-commit calls stay zero after the
  first proof. The second proof commits only after canonical readback; consumed pending cannot replay.
- `ambiguous/expired verification never commits or automatically retries`: stalled/failed transport,
  malformed input/provider proof, mismatched provider user and expired pending cannot replace identity.
- `final_candidate requires independent canonical readback`: old/mismatched/unconfirmed/malformed or
  unavailable canonical identity blocks commit. Canonical `{ userId, email, confirmed, version }`
  comes from a trusted injected store, never the verification response; `confirmed` must be boolean
  true and `version` a nonempty opaque version/etag that changes on every identity/confirmation
  change, without reuse even when the prior values are restored.
- `admission precedes provider work and all persistence; only explicit boolean true enables`:
  wrong actor/org/session, revoked/expired session, nonstaff/inactive membership, sandbox and
  OFF/absent/malformed/string-true flags cause zero provider, pending-load, canonical-read or commit calls.
  The separate authority-read port is necessarily called to determine admission.
- Late expiry, revoked authority or disabled flag blocks commit; foreign pending state is rejected;
  version conflict returns stale, uncertain commit returns unknown, and neither retries automatically.
- An import guard scans runtime source for direct imports, re-exports and dynamic/require literals;
  the coordinator remains disconnected from runtime entrypoints.

**Limits:** These are local mock contracts, not real provider proof or whole A2/B-016 acceptance.
Durable pending-state needs a migration decision covering scope, versions, expiry, consumption,
concurrency, retention and reconciliation after uncertain outcomes. No migration is proposed/applied
here. A future storage implementation must atomically recheck current authority/session/pending
expiry, compare the pending version and old mirrors, and compare-and-swap all canonical snapshot
fields (`userId`, exact `email`, `confirmed`, `version`) before updating local mirrors and consuming
pending exactly once. The coordinator copies the canonical scalars before the final awaited admission;
a separate canonical preflight read does not satisfy this atomic commit condition. The mocks
cannot prove database atomicity or provider/login/recovery behavior. No automatic retries or background
reconciliation are installed. Flags stay OFF; no runtime wiring, real transport or user-facing copy.

Package 2 local verification before QA r1 (Node 20.20.2 / npm 10.8.2; historical results):

| Check | Result |
| --- | --- |
| New coordinator tests, including import guard | PASS 7/7 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, 0 errors / 15 warnings in unchanged files |
| `npm run copy:check` | PASS 6/6 |
| `npm run test:unit` | PASS 998/998, no failures/skips/cancellations |
| Independent Claude review | Pending orchestrator review; no sign-off claimed |

Raw local logs: `/tmp/b016-package2-verification/{focused,typecheck,lint,copy,unit}.log`.
No DB, browser, staging or release verification ran for package 2.

STOP POINT: PACKAGE_2_LOCAL_VERIFIED_CLAUDE_REVIEW_PENDING; next: `git diff --check`; owner: Claude@ron-mac.

### Package 2 independent QA r1 FAIL → local fixes (2026-11-06 PT)

Original findings remain in `/tmp/codex-qa-B-016e.md`; this is a fix record, not a QA sign-off.

- **BLOCKER, stale canonical proof:** `commitIdentity` now requires `expectedCanonical` containing
  the captured identity, confirmation and version. Regression changes each field during the fourth
  awaited admission, including mutation of the original readback object; the commit returns `stale`,
  writes zero mirrors and preserves pending. Version-only changes also reject restored-value/ABA races.
- **LOW, incomplete atomic mock:** the commit mock rechecks current actor/org/session, membership,
  role/environment/flag, session and pending expiry, pending version/old mirrors, and all canonical
  CAS fields in one synchronous check/write section. Deterministic barriers pause commit before
  that section; revocation, flag disablement, session/pending expiry and canonical changes all yield
  `stale`, zero mirror writes, no pending consumption and no retry.
- **LOW, snapshot exceptions:** scope and proof snapshots now occur inside `try`. Throwing getters
  on either input return `unknown` with zero calls to every port, including the clock.

Fix-round verification (Node 20.20.2 / npm 10.8.2):

| Check | Result |
| --- | --- |
| Coordinator tests | PASS 10/10, including final-admission and commit-boundary races |
| Coordinator + isolated staging-bundle test | PASS 11/11 (`isolated-final.log`) |
| `npm run typecheck` | PASS (`typecheck-final.log`) |
| `npm run lint` | PASS, 0 errors / 15 existing warnings (`lint-final.log`) |
| `npm run copy:check` | PASS 6/6 (`copy-final.log`) |
| `npm run test:unit` | FAIL twice: 1000/1001, zero skips/cancellations (`unit.log`, `unit-final.log`) |
| Independent QA of fixes | Pending orchestrator review; no sign-off claimed |

Both full unit runs failed only the unchanged staging-bundle test at
`scripts/pack-staging-bundle.sh:85` (`printf: write error: Broken pipe`). The same staging test passed
in isolation with all coordinator tests. The original failures remain unwaived; no staging code/test
was changed and no full-suite PASS is claimed for this round.

Raw logs: `/tmp/b016-package2-fix-r1/`. Initial focused-test startup hit sandbox `tsx` IPC `EPERM` in
`focused.log`; the permitted rerun is retained separately in `focused-retry.log`.
Independent QA of these fixes remains pending with the orchestrator. No migrations, runtime wiring,
copy changes, ownership operations or git mutations are part of this fix round.

STOP POINT: PACKAGE_2_QA_R1_FIXED_LOCAL_UNIT_FAILURE_RETAINED; next: `git diff --check`; owner: Claude@ron-mac.

### Package 2 QA (orchestrator, 2026-11-06)

Codex QA r1 FAIL (canonical proof could go stale before commit; mock lacked atomic rechecks; snapshots outside `try`) → fixed (canonical identity/version bound to an atomic CAS commit contract; race regressions; exception containment) → **r2 PASS**. Claude re-ran: `test:unit` **1001/1001** (the `staging-bundle` broken-pipe failure seen in the delegated sandbox did not reproduce), typecheck/lint/cf:build pass.
