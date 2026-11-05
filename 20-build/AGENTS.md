# Codex autonomous build prompt

Read `/workspace/ops/handoff/AGENTS.md` first. This pack supplements that operating contract; it does not replace repository ownership, Origin, `ops-lock`, modes A/B, QA independence or handoff rules.

Mission: execute the complete `20-build/BUILD-ORDER.md` queue (**v2, 2026-11-05**, table row order; 設計夥伴啟動條件（Ron 2026-11-05 01:59 PT，BUILD-ORDER v2）：Wave A 判定 ＋ Wave B 硬閘 V-12＋V-13 ＋ B-001–B-005 ＋ 三端 LINE 全部 B-033–B-039（含 push B-037–B-039）). Preserve full `/t`, `/v`, `/o` LINE scope. Do not cut work to claim 11/9.

## Non-negotiable boundaries

- No production DB access, including read-only credentials.
- No production deployment, migration, scheduler operation or flag activation.
- **The Mac gets no production keys. No transient emergency-token exception for this pack.**
- Secrets by protected path only; never print values, copy env contents into evidence, commit credentials or expose tokens in URLs/logs.
- No privacy, terms, consent or ID-notice text edits.
- No external messages: Email, LINE, Slack or other messaging. Use mocks/local capture.
- No blind force-push, ownership takeover or production rollback.
- Do not overwrite the existing root operating contract when copying this pack.

## Session start

Read canonical RULES, PRINCIPLES, ROADMAP, TRAIN, deploy checklist, GATE-B, HANDOFF, current board/flags, this queue, QA standard, blockers and latest verdicts. On Mac use the current checked-in canonical mirrors; missing policy or scripts are blockers, not permission to invent them.

Fetch Origin and inspect ownership read-only. `origin` is canonical; GitHub is a mirror. Acquire mode-appropriate repo ownership through `scripts/claim.sh`; inspect claim status before mutations and renew at checkpoints. Never merge `ops-lock` into main.

If another executor owns the repository, remain dormant for mutations. Record/wait according to the operating contract. “Never stop” below does not override locks, an explicit pause or safety boundaries.

Use mode A’s llm-route workflow or mode B’s desktop-app workflow as recorded. Do not self-declare a mode change. Independent QA must not review its own implementation conversation.

## Continuous loop

1. Read `BUILD-ORDER.md` (**v2**, Ron 2026-11-05 01:59 PT; execute in table row order, including PROP-* L1 foundation rows; do not reorder yourself) and `BLOCKED.md`.
2. Select the lowest-numbered unfinished, unblocked item with satisfied dependencies. Blocked items (BLOCKED.md) are skipped immediately; never wait on them. B-007 (CAP-M-07) is not frozen; take it in queue order.
3. Inspect current code and latest evidence. Reuse completed work; do not rebuild stale inventory.
4. Reserve touched paths on the board. Follow RULES 7: one unshipped PR per file. Combine related overlapping work into the owning lane or wait; preserve recovery refs.
5. Create/use a named branch from the current authorized Origin baseline, never an obsolete hard-coded historical SHA.
6. Implement the spec with default-OFF features and additive migrations. Preserve organization/time/source metadata.
7. Run `QA-STANDARD.md`; use isolated local/staging flag tests and mocked external providers.
8. Acquire staging ownership before deployment. Require clean build and preflight PASS; use only the staging bundle and approved wrapper.
9. Write `status.md`, `verdict.md`, acceptance evidence and Class B draft. Arrange independent review through the recorded workflow without sending external messages yourself.
10. Push the authorized branch/checkpoint to Origin. Only the lock holder runs the documented GitHub mirror tooling; never push directly to GitHub.
11. Update queue status with exact SHA/evidence. A build may finish while production activation remains blocked.
12. Select the next eligible item. Recheck earlier pending items at checkpoints.

Production handoff goes to Grok Bot side through repository evidence, TRAIN and GATE-B. Codex does not merge/promote a production release under this pack.

## Stuck-work policy

Follow PRINCIPLES 29/29a:

- After two failures on the same problem, change approach. Never make a third identical attempt.
- Temporary external failures become `pending`, with next retry at least several hours later and no more than two deferred retries. Continue independent work meanwhile.
- If still failing, use another valid method or record a limitation/blocker. Missing evidence never becomes fabricated PASS.
- More than one hour without progress requires a decision entry for CEO/Ron in `BLOCKED.md`, including alternatives and a recommended action.

Anything needing Ron—legal position, pricing/provider choice, accounts/keys, external receipt/device checks, production activation—goes into `BLOCKED.md`. Mark only the dependent scope blocked and skip to another item. Never end productive work merely because one item needs Ron.

If no items are eligible, checkpoint, write the next-action summary and wait for input or a scheduled retry without busy looping. Never bypass ownership, perform prohibited work or invent approval to keep moving.

## Status and shutdown

Use PT timestamps with offsets and the contract’s STOP POINT format. Record item, branch/SHA, mode, session, commands, outcomes, evidence and quota state; secret paths only.

On pause/stop: start no new mutations, drain/cancel safe background work, checkpoint on a named branch, write handoff/next command, reconcile staging jobs and release claims through the contract. Do not steal or silently abandon locks.
