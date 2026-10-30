# QA plan
Per-feature acceptance belongs in `docs/prd/<feature>.md`, numbered and mapped to tests.
Shared release checks supplement that acceptance; they do not establish feature completeness.

## Gate
`gate.sh` is named in Q4/Q5 but its implementation is not attached or listed in the production scripts tree.
TODO(owner): document its exact steps, options, exit criteria and evidence locations from source.
The evidenced Depot gate performs:
1. `npm ci`; install PDF raster tools.
2. Typecheck, lint, copy guard and unit tests.
3. Apply local Supabase stub and every migration; reset local seed.
4. Check function execute privileges.
5. Run RLS/integration tests.
6. Install Chromium and run Playwright.

Never apply the stub or run seed/reset against hosted staging or production.
Staging deployment follows passing checks only when explicitly enabled.

## Review and release
Class A: Codex produces verdict; QA reads the conclusion.
Class B: Codex drafts; QA signs off; CEO gives GO.
TODO(owner): define classification and independent QA assignments.
Before prod: compare migration fingerprints, verify a restorable backup, record row counts and rollback ID.
Any unexplained migration difference or skip-missing notice is NO-GO.
T+0 and T+15: check key pages and Worker logs; compare row counts and client-visible error baseline.
External models write/execute production probes and produce verdicts; directing bots make decisions.
Pre-existing noise gets an issue and must not rise above baseline during release.
Unexplained anomalies require rollback; database changes use fix-forward.
Until 2026-11-10 PT, wait for each release's T+15 PASS before the next.

## Regression checklist
- Signup/consent, login recovery, team and portal invites: `signup-consent`, `consent-*`, `forgot-flash`, `team-invite*`, `portal-invite`.
- Portfolio/import and existing-tenant lease creation: `portfolio`, `import`, `existing-tenant`, `leases`.
- 繳租回報, utilities and LINE-safe copy: `tenant-pay`, `utility-posting`, `line-copy`, `live-no-line`.
- Expenses, reports and document rendering: `expenses`, `reports`, `pdf`.
- Repair and Vendor flows: `repairs`, `vendor-repair`.
- ID upload/layout/purge: `idv`, `idv-layout`, `id-purge`.
- Audit, sandbox, search/paging and mobile cards: `audit`, `sandbox`, `search`, `paging`, `cards`.
- Try-out, pricing, missing pages and form submission: `tryout`, `pricing`, `not-found`, `form-enter`.
Names above refer to `e2e/<name>.spec.ts`; test presence does not imply current PASS.
Track known failures in `ISSUES` rather than silently accepting them.

## Accounts and evidence
TODO(owner): name staging/prod QA account environment variables; no QA-account variable names were supplied.
Do not copy seeded passwords or real account credentials into docs.
Status/verdicts use `/workspace/e2e/results/<PR>/`; summary evidence belongs in git.
TODO(owner): confirm bulk-evidence R2 bucket/path and upload policy; the cleanup plan contents were not supplied.
Retention and deletion follow `/workspace/ops/handoff/evidence-cleanup-plan.md`; Q7 authorizes a plan, not execution.
TODO(owner): populate retention periods and approved deletion scope from that plan.
Never include ID-document photos in model-task evidence.

Sources: `decisions.md` Q4/Q5/Q7/Q9; `repo_.depot_workflows_ci.yml`; `deploy-checklist.md`; `RULES.md`; `PRINCIPLES.md`; `tree.txt`; `issues-headings.txt`.
