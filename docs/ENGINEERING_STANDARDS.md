# Engineering standards
## Code and local checks
Use the repository's TypeScript, ESLint and Next.js configuration.
`npm run typecheck` runs `tsc --noEmit`; `npm run lint` runs ESLint.
TODO(owner): document formatting, naming and import conventions from configuration.
Use Node 20 for CI and PostgreSQL 16; TODO(owner): pin the Mac toolchain version.
User-facing labels belong in dictionaries, not page literals.
Keep cookie-dependent pages dynamic and preserve Workers compatibility.

## Verification
Depot's shared gate runs typecheck, lint, copy guard, unit, schema/seed, function privileges, RLS and E2E.
| Change area | Existing verification surface |
| --- | --- |
| Pure business rules/helpers | `npm run test:unit` |
| Database, org boundaries, roles | `npm run test:rls`, `npm run test:fn-priv` |
| User flow/UI | `npm run test:e2e`, feature acceptance |
| Copy/catalogs | `npm run copy:check`, strings tests; unit tests after `strings:sync` |
| Worker ID behavior | `npm run test:worker` |
| Licenses/distributed artifacts | `licenses:check`, `licenses:vendor`, `licenses:verify-bundle` |

TODO(owner): formalize which additional checks each change type requires; the table lists evidenced tools.
Validate the final release SHA once after necessary rebases; retain meaningful feature acceptance evidence.
Do not treat a route, test filename or migration filename as proof of a shipped capability.

## Rule 7 and review
Only one unshipped PR may modify a file at a time.
Combine overlapping changes or wait for the earlier PR to reach prod before branching from main.
Rebase and CI reruns go to Codex under RULES; full verification targets the final release SHA.
Class A: Codex produces `verdict.md`; QA reads the conclusion.
Class B: Codex drafts; QA signs off; CEO approves.
Prod probes are written and executed by an external model; the directing bot reads verdicts and decides.
TODO(owner): define independent-reviewer assignment and precise Class A/B classification criteria.
Before reporting to Ron, read the latest status and verdict.

## Security and data
Read secrets from files/environment; prompts and docs contain paths or variable names only.
Never commit credentials or include plaintext in group/DM messages.
Examples of names: `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ID_DOC_*`, `CRON_SECRET`.
PE rotates credentials immediately on suspected exposure.
Use least privilege and enforce authorization in the server/database, not only navigation.
Only necessary customer fields may go to external LLMs; mask ID numbers and bank accounts.
Never attach ID-document photos, including any `id-photo` bucket file, to model tasks.
Privacy disclosure must cover third-party AI processing.
I-17 and I-27 show that database least-privilege/role checks need continued review.
Performance: TODO(owner): define budgets, representative workloads and regression checks.

## Flags and database changes
Large features dark-launch; low-risk fixes may ship enabled.
Promotion is internal→ea→ga with CEO GO at each step; legal/paid GA also goes to Ron.
Support org overrides and global off; register owner and expiry.
Delete release flags and old code after 14 stable GA days; review permanent kill switches quarterly.
Expired flags must be blocked by CI; TODO(owner): identify the implementation/check.
Add migrations; keep them compatible with the currently serving Worker.
Compare production and scratch migration fingerprints; unexplained differences or skip-missing notices fail release.
Record restore-verified backup, row counts and rollback ID; probe T+0/T+15.
Unknown release anomalies mean NO-GO and Worker rollback; database recovery uses fix-forward.
Until 2026-11-10 PT, release sequentially and wait for T+15 PASS before the next release.

## Copy, i18n and session records
Use 屋主; 租客 and 房客 are both allowed. Avoid verification, money-handling and guaranteed-outcome claims.
Q6 changes are instructions for PE, not evidence the copy guard has been updated.
Preserve zh-TW/en placeholders; avoid market, currency or timezone assumptions for P3.
New feature designs reserve usage metering for P2.
Mode B commits carry `Model:`, `Role:`, `Session:` trailers.
Mode B session records go to `ops/log/<date>/<session>.jsonl`; desktop token usage is unknown.
TODO(owner): verify session-log tooling and define trailer values.
LGPL use follows PRINCIPLES: unmodified package, independent loading and notices.

Sources: `RULES.md`; `PRINCIPLES.md`; `deploy-checklist.md`; `repo_package.json`; `repo_.depot_workflows_ci.yml`; `repo_README.md`; `ROADMAP.md`; `decisions.md` Q4/Q6; `issues-headings.txt`.
