---
name: condola-pe
description: "Explicit Condola pe role workflow from ops/roles/pe.md."
---

<!-- Generated from ops/roles/pe.md; source-sha256: ff4d33bc3fb755a026e61fae911195d13fc9e752eca34594cdd050712cfcb701; do not edit; edit ops/roles. -->
<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# PE
Task/context: $ARGUMENTS
Role source: this file; edit sources, then run scripts/install-prompts.sh; AGENTS.md governs.
Invoke Codex $condola-pe or Claude /condola-pe; fallback: "follow .claude/skills/pe/SKILL.md".
Start with ops/roles/start.md; no implementation before confirmed repository ownership.
Read AGENTS.md, canonical ops policy, docs/README.md and docs/prd/<feature>.md; keep docs short.
Mode A: Grok orchestrates implementation/review through llm-route.
Mode B: Ron is CEO; Codex desktop implements; Claude desktop Code tab independently reviews and supplies zh copy.
Run scripts in macOS Terminal or the app's terminal tool; model CLIs are not required.
Reserve lane/files in ops/board.md under Rule 7; respect dependencies and e-sign/id-photo migration ordering.
Implement approved scope only; preserve unrelated work/history/recovery refs; unknown facts remain TODO.
Renew manually at checkpoints and verify claim before mutations; stop on ownership/network uncertainty.
No heartbeat daemon; claims unrenewed for six hours are SUSPECT, never automatically free.
Product copy belongs in src/i18n; 租客 and 房客 are approved; use 屋主 instead of 房東.
Ban verified-tenant claims, 收款/收租/代收/入帳/已收, 保證, registered-company and property-management claims.
Until the guard change ships, introduce no 房客 in src/ copy; src/i18n/copy-guard.test.ts line 9 still bans it.
Reserve that file before removing 房客 and adding missing terms; check false positives and use narrower patterns/allowlists where needed.
Run copy:check; never hardcode Taiwan data/timezone/currency; operational timestamps include offset and PT.
Mac uses only scripts/secrets-run.sh staging -- <cmd>; never print values, write plaintext into the repo or copy prod/ID-doc/backup keys.
Commit candidate; run scripts/gate.sh <exact-SHA> from a clean pinned checkout.
RLS needs disposable PostgreSQL 16, DATABASE_URL and CONDOLA_RLS_DISPOSABLE=YES; smoke waivers are not release evidence.
Release gate: scripts/gate.sh --release <SHA>, including build, Worker and relevant browser checks; preserve failures/limits.
Class A requires a fresh independent Codex verdict; Claude B QA supplements that required verdict.
Class B requires Codex draft, independent QA and CEO GO naming exact SHA/slot.
Five conditions: migration/catalog fingerprint, restore-verified backup, before/after row counts, rollback ID and T+0/T+15.
Before ordinary prod deploy verify pre-deploy conditions 1–4 and approved monitoring; post-deploy evidence stays pending.
Preserve e-sign G0–G5, catalog manifests, lock sampling, preview smoke and frozen hashes; invent no migration ledger.
Candidate/baseline changes invalidate approvals; never self-approve.
Acquire staging/prod claims only under repo ownership; record prod lane/SHA/baseline/rollback/phase.
Mode B deploys to staging only; ordinary prod waits for Mode A Class B.
Only Ron may perform emergency B prod for a P0 customer-impacting fix or rollback of a staging-verified SHA; prefer rollback.
Require PROD_LOCK, recorded rollback version, release gate, deploy/rollback wrapper, rollback runbook and model-run T+0/T+15.
Ron creates/injects a transient condola-prod Worker-deploy-only token, expiry ≤24h, then revokes it; never store prod keys on Mac.
No Mac DB migrations; record emergency actions for post-hoc Class B review on Mode A return.
Prod Worker condola-prod/environment production uses approved wrappers; retain PROD_LOCK through T+15 PASS or incident resolution.
Through 2026-11-10 PT, release sequentially after prior T+15 PASS; T+15 ≥900 seconds after full traffic.
Flags start OFF with kill switch, org overrides, owner/expiry and separately approved internal→ea→ga rings.
Publish sanitized evidence/status under e2e/results/<lane>/; private R2 manifests include key/hash/size/retention.
B runs scripts/session-log.sh at start/end; log app/model/session, outcomes, failed calls, evidence and quota; unknown metrics stay unknown.
Commit Model:, Role:, Session: trailers; operational updates on main preserve candidate identity.
Only lock holder mirrors via scripts/mirror-github.sh after Origin pushes and at handoff; no direct GitHub push or inbound sync.
Freeze/publish waits for all PE lanes shipped with T+15 PASS or CEO-parked recovery refs; follow checklists/freeze-and-publish.md.
Record exact next command at checkpoints; finish using ops/roles/handoff.md.
