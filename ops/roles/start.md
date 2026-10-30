<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# Resume — start every session in either mode
Session context: $ARGUMENTS
Repository records and live evidence are authoritative; unknown facts remain TODO or BLOCKED.
Invoke Codex $condola-start or Claude /condola-start; fallback: "follow .claude/skills/start/SKILL.md".
Determine mode, role, lane, coordinator and independent reviewer; record app/model used.
Canonical origin: https://origin.cursor.com/ron-shih/condola-app.git; main holds operational state.
Read-only discovery precedes ownership; no edits, dispatch or shared-service mutations.
Fetch Origin main, lane/recovery branches and ops-lock; stop on network failure.
Run scripts/claim.sh status; missing/SUSPECT/unreachable claims are not automatically available.
Coordinator keeps one unique CONDOLA_SESSION_ID UUID for the ownership period.
Acquire with scripts/claim.sh acquire repo <A|B> <who>; renew only a verified same-session claim.
If another session owns repo, remain dormant; never break/release its claim to proceed.
Independent QA uses the coordinator's claim and a distinct logged review-session ID.
Read AGENTS.md, CLAUDE.md when applicable and ops/{RULES,PRINCIPLES,ROADMAP,deploy-checklist}.md.
Read docs/README.md, docs/prd/<feature>.md, HANDOFF, board, lane status, approvals and verdicts including T+0/T+15.
Inspect git log --all since last handoff and explicit recorded commit ranges.
Inspect worktrees, dirty/divergent branches, unpublished commits and recovery refs; preserve before reconciliation.
Run scripts/install-prompts.sh --check; repair generated skills from ops/roles only after ownership.
A routes external-model work through llm-route; B uses Codex desktop implementation and Claude desktop Code tab independent QA/zh copy; Ron is CEO.
Scripts run in macOS Terminal or app terminal tools; model CLIs are not required.
B starts/ends logs with scripts/session-log.sh; retain ops/log/<date>/<session>.jsonl and commit trailers.
Verify live prod SHA/version, flags, artifacts, rollback, monitoring and quotas through authorized read-only access.
Mac uses scripts/secrets-run.sh staging -- <cmd>; verify bundle ID/date/expiry without printing values.
No stored prod/ID-doc/backup keys on Mac; ordinary B releases are staging-only.
Ordinary prod waits for Mode A Class B; Ron's P0-fix/rollback emergency needs locks, rollback version, release gate/wrapper, model T+0/T+15 and post-hoc review.
Emergency token is Ron-created, Worker-deploy-only, ≤24h and revoked; no Mac DB migrations.
Verify prod Worker condola-prod/environment production; recorded versions need evidence.
Reconcile broken resource claims and outstanding deploy/DB operations before work.
Claims unrenewed six hours are SUSPECT; PROD_LOCK never expires; renew manually, with no heartbeat daemon.
Report exactly these 10 state-summary lines, using unknown or BLOCKED where evidence is missing:
1. Mode / app/model / coordinator / executor / role / ownership and review session IDs.
2. Fetch time and repo/staging/prod claim holders, generations, freshness and fencing concerns.
3. main, candidate, baseline, lane branches and last-handoff checkpoint differences.
4. Dirty/divergent/unpublished work and preservation/reconciliation status.
5. Lane scope, PRD, claimed files, dependencies and Rule 7 conflicts.
6. Gates, classification, independent reviewer, verdicts and evidence gaps.
7. Prod SHA/version, rollback, monitoring, T+0/T+15 and emergency post-hoc review status.
8. Flags, org overrides, kill readiness, expiry and approved rings.
9. Quota/reset, artifacts, staging bundle ID/date, mirror SHA/PT time, blockers and release order.
10. Exact next command, owner and required conditions.
Use offset-bearing PT timestamps; after claiming publish HANDOFF acceptance/board reconciliation with Model:, Role:, Session: trailers.
Only lock holder runs scripts/mirror-github.sh after Origin pushes and at handoff; no direct GitHub pushes or GitHub→Origin sync.
Freeze/publish waits for all PE lanes shipped with T+15 PASS or CEO-parked recovery refs; follow checklists/freeze-and-publish.md.
Through 2026-11-10 PT, next release waits for prior T+15 PASS; preserve Class A independent Codex and Class B draft/QA/GO requirements.
Resume only the reconciled next step; subordinate reviewers return evidence to the coordinator.
