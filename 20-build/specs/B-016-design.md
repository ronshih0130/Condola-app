# B-016 delegated pure-contract slice

2026-11-06 PT. **PROPOSAL ONLY — NOT APPLY READY. Whole B-016 remains incomplete.**
Scope: gap-plan package 3 pure rules plus existing-report regression, and package 4 compatibility.
Claude owns the lock and git commits. This delegation changes local files/tests only.

## Slice proved

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
| A2 email-change controller | Application-level pending change/reconciliation, both verification orders, trusted login/recovery identity preservation, canonical readback, authorization and real-provider validation. Existing mocks do not establish controller behavior. |
| Durable profiles and A3 fee editing | Approved migration for organization-scoped identities/versions/references/snapshots, constraints/RLS, immutable rule history, audited writes, concurrency, backfill and rollback review. No migration in this slice. |
| A4 authorization | Company/email/fee save-path authorization remains unproved until controllers exist. Pure compatibility checks are not server authorization. |
| UI and runtime integration | Lease inheritance wiring, settings/editor flows, B-003 authorized adapter, report version selection and approved Q1 policy. No runtime callers added. |
| MF-03 | Company invoices and automatic owner-prepay drawdown remain explicitly deferred; no per-item confirmation workflow. |

Flags remain OFF in repository code. Activation still belongs to Ron. No user-facing copy changes,
new migrations, git commits/pushes, ownership operations or release actions were performed.

## Local verification

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
