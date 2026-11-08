# B-017 policy slice evidence

Evidence checkpoint: 2026-11-06T04:31:27-08:00. Base: `d374bb695d0e97fad72d00449d6a57450a61a9b1`. Local implementation by Codex; authoritative delegation names Claude@ron-mac as ops-lock holder and sole git committer. No claim script, git mutation, migration, DB operation, deployment or flag activation was run by this delegate.

Scope: packages 1–2 only. [Design and remaining blockers](../../20-build/specs/B-017-design.md). The historical inactive SQL packages remain unchanged and do not establish applied enforcement.

## Executable coverage

| Area | Evidence |
| --- | --- |
| Native/OFF compatibility | 90 literal matrix cases: four native roles plus null × 18 recognized permissions, pinned to `d374bb6`; exact key/role catalog; navigation destinations and home/denial routes |
| Native audit and photo rendering | Native-Admin audit navigation boundary; non-Admin/null audit-reader empty results; Accountant public/internal photo DTO rendering leaks no filename, ID, URL or action; Admin positive rendering control |
| Supported catalog and grants | Each of 17 keys accepted and evaluated for every native base; omitted keys denied; `data.export`, unknown/malformed/duplicate inputs reject without filtering; Admin grants Manager bank reconciliation; restricted Admin cannot grant absent authority |
| Mandatory policy floors | Accountant ticket text allowed/photo denied; non-Admin `team.manage`/`settings.edit` cannot grant company audit or role governance |
| Unavailable authority | Missing assignment/role, draft/retired/foreign/mismatched role, poisoned grants, unsupported org/role capability versions return unavailable, never native fallback |
| Strict management gate | Both booleans require literal true; missing/malformed gates/allowlists are OFF; OFF denies governance/grants while existing enforced assignment semantics persist |
| Disconnection | AST import scan across production src; no runtime imports of the preparation modules; existing runtime sources unchanged |

The photo assertion is about rendering an existing DTO, not removal of sensitive fields from all server responses. The evaluator consumes modeled trusted snapshots; it does not authenticate, persist, synchronize revisions, enforce RLS or prove deployment behavior.

## Local checks

Toolchain: Node `v20.20.2`, npm `10.8.2` (matches `.nvmrc`). These are local working-tree checks, not a clean committed release gate.

- Focused B-017 tests: initial run 128 PASS, 0 FAIL, 0 SKIP; `/tmp/b017-policy-focused.log`.
- `npm run typecheck`: final exit 0. First run found a test fixture field mismatch (`currency` instead of required `leaseId`); corrected locally. Initial failure retained at `/tmp/b017-typecheck-initial-failure.log`; final run `/tmp/b017-typecheck.log`.
- `npm run lint`: exit 0, 15 existing warnings outside changed files, 0 errors; `/tmp/b017-lint.log`.
- `npm run copy:check`: exit 0, 6 PASS, 0 FAIL/SKIP; `/tmp/b017-copy-check.log`.
- `npm run test:unit`: exit 0, 1,109 PASS, 0 FAIL/SKIP (1,094 top-level tests including 128 new B-017 tests); `/tmp/b017-test-unit.log`.
- `git diff --check`: exit 0. Read-only comparison confirms `perms.ts`, `audit-read.ts` and `repair-photos.tsx` are byte-identical to the pinned baseline. Only the two new test modules, disconnected policy module, package test registration and these two documents are changed.

Logs are local temporary evidence, not committed artifacts or release-gate evidence. No `custom_roles` registry entry was needed; flags and runtime callers remain unchanged.

Verified code SHA-256 bindings for independent review:

| File | SHA-256 |
| --- | --- |
| `package.json` | `6643b61194583655f251a3b8ea383bdcb5a8643ada0ec24e459afcf48d67b493` |
| `src/server/b017-legacy-compat.test.ts` | `7e53817db98ec6173c06f84c46d11ac9435889aa7250e57455f224f1d1baa95b` |
| `src/server/b017-custom-role-policy.ts` | `9828fb27df2f4553cd5b9b7f076d9587e2be6b3a64caed4e95cf3dc70376923e` |
| `src/server/b017-custom-role-policy.test.ts` | `8e6f19612e286479fb4d53a4811ceccfdd7d37a01d9eead65c21276f1f3ffe5b` |

## Acceptance boundary

Packages 3–4 remain blocked on complete durable governance/assignment and authoritative API/privacy enforcement, both requiring migrations and target proof. Independent Claude QA is pending with the orchestrator; this implementation is not its own sign-off. Build, browser, RLS, staging and whole-B-017 acceptance were not run or asserted.

STOP POINT: LOCAL_POLICY_SLICE_PASS_WHOLE_B017_INCOMPLETE; next: `git diff -- package.json` plus independent inspection of the five new files listed by `git ls-files --others --exclude-standard`; owner: Claude@ron-mac for review/commit/handoff.
