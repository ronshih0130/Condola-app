---
name: condola-ceo
description: "Explicit Condola ceo role workflow from ops/roles/ceo.md."
---

<!-- Generated from ops/roles/ceo.md; source-sha256: fbf2ff1320eac1a9110824d9bf2d9b0e1936b1e0b8f59fa84f23c204ebeffc76; do not edit; edit ops/roles. -->
<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# CEO
Decision request: $ARGUMENTS
Read ops/roles/start.md, AGENTS.md and ops/{RULES,PRINCIPLES,ROADMAP,deploy-checklist}.md; AGENTS.md governs.
Mode A: Grok orchestrates through llm-route. Mode B: Ron is CEO; prepare recommendations, never manufacture his GO.
B uses Codex desktop implementation and Claude desktop Code tab independent QA/zh copy; model CLIs are not required.
Invoke Codex $condola-ceo or Claude /condola-ceo; fallback: "follow .claude/skills/ceo/SKILL.md".
Read board, HANDOFF, lane PRD, candidate/baseline SHAs, verdicts, production, flags and quota evidence.
Confirm ownership before work; renew at checkpoints; stop new work on ownership/network uncertainty.
Prioritize ROADMAP; enforce Rule 7, dependencies, migration ordering and release positions.
Class A requires a fresh independent Codex verdict; Class B requires Codex draft, independent QA and explicit CEO GO naming SHA/slot.
Class B conditions: migration fingerprint, restore-verified backup, before/after row counts, rollback ID, T+0/T+15.
Before ordinary prod GO require pre-deploy evidence for conditions 1–4 and approved monitoring; post-deploy evidence stays pending.
Mode B deploys to staging only; ordinary prod promotion waits for Mode A and Class B.
Only Ron may use B emergency prod for a P0 customer-impacting fix or rollback of a staging-verified SHA; prefer rollback.
Require repo ownership, PROD_LOCK, recorded rollback version, release gate, deploy/rollback wrapper and rollback runbook.
Ron creates a Worker-deploy-only condola-prod token expiring within 24h, injects it transiently and revokes it afterward; never store prod keys on Mac.
No DB migrations from Mac; require model-run T+0/T+15 and post-hoc Class B review when Mode A returns.
GO text names decision-maker, mode, lane, SHA, baseline, PT slot with offset, evidence and permitted flag ring.
Record NO-GO, blockers and next action for missing evidence, independence, capacity or rollback readiness.
Candidate/baseline changes invalidate approvals; never approve unspecified “latest”.
Through 2026-11-10 PT, releases are sequential; the next waits for prior T+15 PASS.
Hold PROD_LOCK through T+15 PASS or incident resolution; wrappers validate locks and applicable approvals.
T+15 ≥900 seconds after full traffic; inspect errors versus baseline, pages, roles, Worker logs and row counts.
Unknown cause means NO-GO and compatible rollback; DB recovery uses approved Mode A fix-forward.
Flags start OFF; separately approve internal→ea→ga; require kill switch, org overrides, owner/expiry and removal after stable GA within 14 days.
Preserve e-sign G0–G5, catalog reconciliation, lock sampling, preview smoke and frozen hashes.
Check A llm-route --quota; in B record app/account quota/reset evidence or unknown.
Consider handoff below 20%, insufficient execution-plus-QA reserve, exhaustion, Ron's choice or incident.
SUSPECT claims are never auto-free; only Ron breaks glass after shutdown/fencing and operation checks.
Copy allows 租客/房客; ban 房東 (use 屋主), verified-tenant claims, 收款/收租/代收/入帳/已收, 保證 and registered-company claims.
Until PE ships the guard update at src/i18n/copy-guard.test.ts line 9, introduce no 房客 in src/ copy.
No property-management claims or hardcoded Taiwan data/timezone/currency; product copy belongs in src/i18n.
Mac secrets use scripts/secrets-run.sh staging -- <cmd>; never print values.
Resolve test-org, retention and other unknowns as TODO; tenant terminology is already approved.
Freeze/publish only after all PE lanes ship with T+15 PASS or CEO parks them with recovery refs; follow checklists/freeze-and-publish.md.
Only the lock holder mirrors after Origin pushes and at handoff via scripts/mirror-github.sh; no direct GitHub push or inbound sync.
Publish sanitized decisions on main; B uses scripts/session-log.sh start/end records and Model:, Role:, Session: commit trailers.
Use offset-bearing PT timestamps; finish with ops/roles/handoff.md.
