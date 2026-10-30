# Condola state inventory (box scan 2026-10-27 04:30 PT, by Grok Bot executor)

> Update 2026-10-27 ~11:30 PT: Mode B uses the Codex desktop app + Claude desktop app (not CLIs); Origin canonical + private GitHub one-way mirror; Mac staging-only. See DESIGN.md and report.html. The inventory below is the 04:30 PT snapshot and was not re-scanned.

Two modes: (A) Grok Bot agents CEO/PE/QA/R&D on a Linux "box" orchestrating Codex/Claude/Gemini via `llm-route`; (B) Ron alone on his Mac mini with Codex CLI + Claude Code. Box and Mac share NOTHING unless it is in git (Cursor Origin) or another sync.

## Source control (most important finding)
- Hosted remote: Cursor Origin `ron-shih/condola-app` (private, https://origin.cursor.com/ron-shih/condola-app.git, default branch `main`). Origin has no issue tracker and reports no PR checks (ISSUES.md I-1).
- Origin `main` tip = 2bedb89 (2026-10-22 PR #18). Branches `cursor/*` are pushed by Cursor cloud agents.
- Box working repo = `/workspace/condola-i12/.git` (branch master, **NO remote configured**, git user `i12@box`), 48 commits starting "8a68cbe base 8162c67 (tree reconstructed)" on 10/25 22:05. ~17 worktrees: /workspace/condola-esign (esign-p1-noschema 1f87768), condola-idphoto90 (0bd921c), condola-brandv2 (65a676c), condola-errredact (7ea9624), condola-dbb1027 (996feeb), condola-i26 etc.
- **Production = 5d8b002 (Worker version 65f8d809… @100%) exists only in the box repo; not on Origin.** Origin main object 2bedb89 is not even in the box repo (history reconstructed from tarballs). => Mac cannot see current prod code, open lanes, or unshipped candidates.
- Many /workspace/condola-pr*/ and condola-prod-*/ dirs are tarball exports (COMMIT file, no .git).
- CI: `.depot/workflows/ci.yml` (Depot, postgres:16, npm ci, typecheck/lint/unit/rls) in repo but does not report to Origin; QA runs "box CI" (`e2e/results/lanes-1026/ci-lane.sh`, per-lane ci-<sha>.out).
- Separate GitHub repo `github.com/ronshih0130/condola-backup` (private): nightly encrypted Supabase backup workflow (age keys, R2), plus age-encrypted secret backups (keys/prod-iddoc-20261022.age). Private age keys are offline with Ron.

## Rules / principles / roadmap
- /workspace/ops/RULES.md (v1, 8 rules: Grok only orchestrates; all model calls via llm-route; Class A = Codex verdict, Class B = Codex draft + QA sign-off + CEO GO; status in e2e/results/<PR>/status.md; Rule 7 one unshipped PR per file; secrets only by path/env name; masked customer data OK). Box only, NOT in git.
- /workspace/ops/PRINCIPLES.md (14 principles: flag-OFF dark launch; rings internal→ea→ga each CEO GO, legal/paid features shown to Ron before GA; per-org override + global kill switch; flag registry with owner/expiry, delete 14d after GA stable, CI blocks expired flags; until 11/10 ship in order one at a time, next only after previous T+15 PASS; unknown cause = NO-GO + rollback, DB fix-forward; gate on client-visible errors not above baseline; prod tests written/run by external LLM; check latest verdict before reporting). Box only.
- /workspace/ops/ROADMAP.md (P1 four apps 管理方/房客/屋主/Vendor → design partners; P2 usage-based pricing + UX; P3 global TW→US→global→SEA (no hardcoding TW in copy/data/tz/currency); P4 user AI). Box only.
- /workspace/ops/deploy-checklist.md: 5 pre-prod items = (1) migration fingerprint prod vs repo via e2e/prodro.sh (read-only), any unexplained diff NO-GO; (2) restorable DB backup recorded; (3) key-table row counts before/after; (4) rollback id recorded; (5) T+0 and T+15 checks of key pages + Worker logs, anomaly → rollback. Box only. (These are the "5 conditions" for Class B.)
- In repo (reachable from Mac once pushed): README.md, HANDOFFS.md, docs/DEPLOY.md (prod = Worker `condola-prod`, wrangler env `production`, nothing in repo deploys prod; CI deploys staging only when STAGING_AUTODEPLOY=true), docs/STAGING.md, design/strings/*.json, src/i18n/copy-guard.test.ts (FORBIDDEN = 房東, 房客, 收款, 收租, 即將推出, 測試模式, 範例沙盒, 示範; `npm run copy:check`).
- Wording rules (team): 屋主 not 房東; never call tenants "verified"; never imply Condola collects rent (no 收款/收租/代收); Condola is not a registered company; product does not collect rent / manage property / guarantee rent.

## Specs / design
- /workspace/pm-saas/ (NOT a git repo): design/<feature>/ specs (e-sign, contractor-app, vendor-receipt, tenant-app, privacy-ai, plan-selector, brand-v2, repair, line-notify, payment-settlement, lease-renewal-moveout, qa, _app_decisions.md, WORKLOG.md), HANDOFFS.md, live_features.md, approved_strings_changes.md, term_swap_wuzhu.md, brand/, prototype/. Box only.

## Task queue / state
- /workspace/ops/compressed_plan.md + compressed_plan.status (timestamped plan/updates from PE/CEO, release order). Box only.
- /workspace/e2e/results/ISSUES.md (issue tracker, "Origin has no issue tool"). Box only.
- /workspace/e2e/results/<lane>/status.md (per-PR/lane progress log, PT timestamps, STOP POINT lines). Box only, 8.9 GB total results dir incl. evidence screenshots.
- Release status examples: e2e/results/esign/{status.md, classb-draft.md, prod-plan.md, qa-request.md, codex/*.prompt|.out}; e2e/results/db-batch-1027/{classb-draft.md, not-worse-*.md, copy-audit-*.md, prod/{deploy.sh, check.sh, check-T0.txt, check-T15.txt, tail-T0-summary.txt, restore-verify.sh, prod-run-996feeb.sh}}; e2e/results/i26/verdict.md (Class A verdict format: Final SHA, Branch, Base, Classification, OVERALL PASS/FAIL, Review scope, Files changed, Findings).
- Staging lock today: informal text convention "STAGING CLAIM APPROVED-BY Ron|PE + QA claim" written in status.md; prod lock = "Orchestrator must confirm no other production lane is active and hold the slot through T+15".
- Flag inventory: e2e/results/test-org-flags/flag-inventory.md (no central flag registry file found in repo).
- Nightly 19:00 efficiency reflection: /workspace/ops/reflections/*.html. Agents' role prompts/memory live inside the Grok Bot platform (not files).

## Release scripts
- Box-only: /workspace/e2e/prodro.sh (prod read-only SQL), stgro.sh, sql.sh, per-lane prod/deploy.sh + check.sh (wrangler versions upload --env production; wrangler versions deploy "$NEW@100%"; rollback = wrangler versions deploy "$OLD@100%"; /api/version x3 on both hosts), restore-verify.sh, condola-backup workflow (GitHub Actions run).
- In repo: scripts/cf-deploy-staging.sh, pack-staging-bundle.sh, db-migrate.sh, db-reset.sh, db-setup.sh, smoke.ts, check-function-privileges.sh, write-pr-migrations.mjs; package.json scripts typecheck, lint, test:unit, test:rls, test:worker, test:e2e, copy:check, build.

## Secrets
- /home/box/.secrets/ (dir, ~100 files: condola_prod.env, condola_staging.env, supabase_pat, supabase_prod_db_pw, cloudflare_pw, brevo_*, resend_*, condola-prod-iddoc/, QA account envs and browser state.json). /workspace/e2e/secrets/. Box only. Never in git.
- /workspace/secrets-backups.md: records encrypted backups (names only) in condola-backup repo.
- /workspace/llm-route/state/{claude,codex,agy-home} = subscription CLI logins for the box (Ron's accounts). Mac has its own logins.
- Rule: prompts only carry file paths / env var names; masked customer data.

## Router
- /workspace/llm-route (README.md): `llm-route <provider|task> "prompt" files...`, routing code/review/reason/write/plan→codex, zh→claude, summarize/longdoc/bulk→gemini; --tier strong = codex gpt-6-astra model_reasoning_effort=high (xhigh exists in codex CLI but not exposed); daily caps claude 60 / codex 400 / gemini 100; usage.log JSONL; codex runs `--sandbox read-only` in a temp dir (cannot write the worktree; PE executes Codex-written scripts verbatim).
- Quota now: Codex plan prolite weekly 30% used (resets Sun Nov 1); Claude week 11%; Gemini 100%.
- Recurring problem: Grok Bot and external LLM quotas both run out (e.g. 10/26 codex daily cap hit).

## Reachability from Mac today
| item | location | in git? | Mac can see? |
|---|---|---|---|
| prod code 5d8b002 + all open lanes | /workspace/condola-i12/.git | local only, no remote | NO |
| Origin main | origin.cursor.com/ron-shih/condola-app | yes | yes (stale since 10/22) |
| RULES/PRINCIPLES/ROADMAP/deploy-checklist | /workspace/ops | no | NO |
| specs | /workspace/pm-saas/design | no | NO |
| task queue / issues / status / verdicts | /workspace/ops, /workspace/e2e/results | no | NO |
| release scripts (deploy/check/prodro) | /workspace/e2e, results/*/prod | no | NO |
| CI workflow, test scripts, copy-guard | repo | yes (once pushed) | partially |
| secrets | /home/box/.secrets | no (must never be) | NO |
| backups/encrypted keys | github ronshih0130/condola-backup | yes | yes |
| role prompts | Grok Bot platform | no | NO |
