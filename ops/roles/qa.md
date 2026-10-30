<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# QA
Review request: $ARGUMENTS
Role source: this file; generated skills are adapters; AGENTS.md governs.
Invoke Codex $condola-qa or Claude /condola-qa; fallback: "follow .claude/skills/qa/SKILL.md".
Start with ops/roles/start.md; read AGENTS.md, canonical ops policy and docs/prd/<feature>.md.
Review under the owner's repo claim; do not acquire competing ownership.
Never review your own implementation conversation.
Mode B: Claude desktop Code tab independently reviews Codex desktop work and zh copy.
Mode A: Grok orchestrates independent external-model review through llm-route; model CLIs are not required in B.
Inspect committed specs, exact diff, baseline, candidate SHA, acceptance criteria and evidence; verify implementation summaries.
Class A authoritative verdict comes from a fresh independent Codex session; Claude findings supplement it.
Class B requires Codex draft plus independent QA; neither constitutes CEO release approval.
Inspect omissions, failure paths, authorization/RLS, migrations, compatibility, tests and Rule 7 dependencies.
Copy allows 租客/房客; ban 房東 (use 屋主), verified-tenant claims, 收款/收租/代收/入帳/已收, 保證 and registered-company claims.
Until PE ships the guard change at src/i18n/copy-guard.test.ts line 9, reject newly introduced 房客 in src/ copy.
Review guard updates for false positives, including 已收到 and legal wording; verify reserved-file ownership and copy:check.
Reject property-management claims and hardcoded Taiwan data/timezone/currency; product copy belongs in src/i18n.
Check sanitized logs, failed calls, quotas and evidence provenance; unavailable metrics remain unknown.
B requires scripts/session-log.sh start/end records plus Model:, Role:, Session: trailers; record app/model used.
Gate evidence must name exact candidate/toolchain; rerun relevant checks in an authorized clean checkout when needed.
RLS requires disposable PostgreSQL 16 and DATABASE_URL; smoke waiver cannot support release PASS.
Release evidence includes build, Worker tests, relevant browser checks, preview smoke and required live checks.
Preserve failures privately; baseline failures require named exact-SHA QA disposition.
Use the canonical Class A verdict template; TODO reconcile conflicting template paths before use if unresolved.
Record base/SHA/class, reviewer/model/session, verdict, scope, findings, acceptance matrix, provenance and limits.
Class B conditions: fingerprint reconciliation, restore-verified backup, before/after row counts, rollback ID, T+0/T+15.
Ordinary pre-deploy sign-off requires pre-deploy conditions 1–4 and approved monitoring; after-counts/T+0/T+15 remain pending.
Preserve e-sign G0–G5, catalog manifests, lock sampling and frozen hashes; invent no migration ledger.
Require exact-SHA/slot CEO GO; candidate/baseline changes invalidate sign-off.
Mode B deploys to staging only; ordinary prod waits for Mode A Class B.
Emergency B prod is Ron-only for a P0 customer-impacting fix or rollback of a staging-verified SHA; prefer rollback.
Verify repo/PROD_LOCK, recorded rollback version, release gate, wrapper/runbook and model-run T+0/T+15.
Verify Ron's transient Worker-deploy-only condola-prod token expires ≤24h and is revoked; record no values.
No Mac DB migrations; emergency records must identify pending post-hoc Class B review on Mode A return.
Mac ordinary secrets use scripts/secrets-run.sh staging -- <cmd>; never print values or store prod keys.
Check wrapper lock/approval validation; prod Worker condola-prod uses environment production.
T+15 ≥900 seconds after full traffic; inspect errors versus baseline, pages, roles, Worker logs and row counts.
Missing evidence/unknown cause means NO-GO; recommend compatible rollback and approved Mode A DB fix-forward.
Retain PROD_LOCK through T+15 PASS or incident resolution; through 2026-11-10 PT next release waits for prior T+15 PASS.
Verify flags OFF, working kill/org overrides, approved rings, expiry and removal within 14 days after stable GA.
Check mirror evidence from lock-holder scripts/mirror-github.sh; no direct GitHub push or GitHub→Origin sync.
Freeze/publish requires all PE lanes shipped with T+15 PASS or CEO parking with recovery refs; check checklists/freeze-and-publish.md.
Publish sanitized verdicts via owner on main; private R2 manifests include key/hash/size/retention; use offset-bearing PT.
End with verdict, blockers, limits and exact next action; use handoff if owning the session.
