---
name: condola-rd
description: "Explicit Condola rd role workflow from ops/roles/rd.md."
---

<!-- Generated from ops/roles/rd.md; source-sha256: 7932225a2db9ce4ee81be03129e0dab73deec8f16d17998f0a53c311f7b080dc; do not edit; edit ops/roles. -->
<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# R&D
Research request: $ARGUMENTS
Role source: this file; start with ops/roles/start.md; AGENTS.md governs.
Invoke Codex $condola-rd or Claude /condola-rd; fallback: "follow .claude/skills/rd/SKILL.md".
Read AGENTS.md, canonical ops policy, HANDOFF, board and latest relevant verdicts.
Use docs/README.md and docs/prd/<feature>.md; DECISIONS.md is the ADR log; keep docs short.
Confirm repo ownership before work; checkpoint writes go through the owning session; renew manually.
Mode A: Grok orchestrates research/model calls through llm-route.
Mode B: Ron is CEO; Codex desktop implements; Claude desktop Code tab provides independent QA/zh copy.
Run scripts in macOS Terminal or an app's terminal tool; model CLIs are not required.
Research actual constraints, implementation and failure evidence; memory is not authority.
Use primary sources; record URLs, publication/access dates, uncertainty and applicability.
Never invent facts; mark unknowns TODO and identify what resolves them.
Produce options/tradeoffs, recommendation, non-goals, implementation specification and testable acceptance criteria.
Include authorization/RLS, migration/catalog effects, compatibility, rollback/fix-forward, copy, observability and evidence.
Reserve lane/files before implementation; enforce Rule 7 and e-sign/id-photo ordering.
Research does not authorize implementation, prod changes, data access or release.
Classify using canonical policy; preserve Class A fresh independent Codex verdict and Class B Codex draft requirements.
Class B plans cover fingerprint, restore-verified backup, before/after counts, rollback ID and T+0/T+15.
Plan independent QA and exact-SHA/slot CEO GO; never fabricate approval.
Mode B release planning is staging-only; ordinary prod waits for Mode A Class B.
Only Ron's P0-fix/rollback emergency exception may use prod in B; plan locks, recorded rollback, model checks and post-hoc Class B review.
No Mac DB migrations or stored prod keys; emergency Worker token is Ron-created, Worker-deploy-only, ≤24h and revoked.
Preserve e-sign G0–G5, catalog manifests, lock sampling, preview smoke and frozen hashes; invent no migration ledger.
Plan flags OFF, owner/expiry, kill/org overrides, separate ring approvals and removal within 14 days after stable GA.
Through 2026-11-10 PT, releases are sequential; next requires prior T+15 PASS.
Copy belongs in src/i18n; 租客/房客 approved; ban 房東 (use 屋主), verified-tenant claims and registered-company claims.
Ban 收款/收租/代收/入帳/已收 and 保證; no property-management claims.
Until PE ships the guard update at src/i18n/copy-guard.test.ts line 9, introduce no 房客 in src/ copy.
Guard work needs file reservation and false-positive review; never treat terminology approval as a shipped code change.
Never hardcode Taiwan data/timezone/currency; use numeric-offset PT in operational records.
Mac secrets use scripts/secrets-run.sh staging -- <cmd>; reference names/paths only, never print values.
Write feature PRDs in docs/prd/<feature>.md, linking existing design sources; avoid duplicate policy/spec copies.
Store sanitized evidence/manifests canonically; private R2 holds large artifacts.
B runs scripts/session-log.sh at start/end; record app/model/session, failed calls, outcomes, evidence and quota; unknown metrics stay unknown.
Publish operational updates on main with Model:, Role:, Session: trailers.
Origin is canonical; only lock-holder scripts/mirror-github.sh updates GitHub; no direct GitHub pushes or inbound sync.
Freeze/publish waits for all PE lanes shipped with T+15 PASS or CEO parking with recovery refs; follow checklists/freeze-and-publish.md.
End with recommendation, acceptance criteria, TODOs/blockers, owner and exact next command; use ops/roles/handoff.md.
