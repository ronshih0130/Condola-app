# Blocked and pending register

**Codex skips blocked items (or the blocked part of an item) and moves on immediately. Never wait for a resolution.** Re-check this file at the start of each loop.

| Entry | Item / dependent scope | Type | Evidence / failed approaches | Decision needed / options / recommendation | Owner | Created PT | Retry count / next eligible PT | Resolution / approval source |
|---|---|---|---|---|---|---|---|---|
| BLK-001 | B-001 ESIGN_ENABLED activation (RON); build/verify continues; only activation blocked | RON | p0-build-queue.md flag schedule; e2e/results/p0-build/esign/codex/verdict.md | A) Enable in test org after §11.1 G1/G2 closed + QA sign + CEO GO (recommended); deadline 2026-11-04 18:00 PT, else paper fallback T-02/M-02 for 11/9. B) Keep OFF; ship paper fallback only. | Ron | 2026-10-29 16:25 PT | n/a | Resolved: Ron chose option A (2026-10-29 16:47 PT, CEO chat); activation follows the listed gates |
| BLK-002 | B-002 MOVE_OUT + ID_PURGE (RON); build/verify continues; only activation blocked | RON | Activation prerequisites: Ron nod for MOVE_OUT GA; QA-signed ID_PURGE dry-run count + Ron approval of box backup purge | A) MOVE_OUT test org ~11/03, then GA on Ron nod; ID_PURGE dry-run count QA-signed, then enable after Ron approves box backup purge (recommended). B) MOVE_OUT only; ID_PURGE stays dry-run. | Ron | 2026-10-29 16:25 PT | n/a | Resolved: Ron chose option A (2026-10-29 16:47 PT, CEO chat); activation follows the listed gates |
| BLK-003 | B-003 PAYEE_DETAILS (RON); build/verify continues; only activation blocked | RON | Current build displays last-5 only; full display requires P1 full access audit + QA cross-tenant test | A) Show tenants full receiving bank account (bank, branch, account name, full account number) on /t/pay for own lease only, with audited reads, after P1 full access audit + QA cross-tenant test (recommended by CEO 2026-10-29 16:25 PT). B) Keep last-5 only display. | Ron | 2026-10-29 16:25 PT | n/a | Resolved: Ron chose option A (2026-10-29 16:47 PT, CEO chat); activation follows the listed gates |

Types: `RON`, `CEO`, `EXTERNAL_PENDING`, `DEPENDENCY`, `OWNERSHIP`, `QA`.

Record exact affected scope; continue other eligible work. External temporary retries must be hours apart, maximum two deferred retries. Two failures on the same problem require a changed approach.

Never place secret values, invite/session tokens, raw webhook bodies or customer identifiers here. Use protected paths and sanitized evidence.

## Bootstrap source-recovery dependency

B-001–B-004 verification/integration is pending recovery of hub-cited lane commits (028ab9a, 389ff74, dcc104d; related move-out/purge and paper-version migrations/evidence). Current Origin baseline lacks them. Owner: Ron/Mode A source maintainer. Supply sanitized lane/recovery refs or code archive; no production credentials. Independent B-005 trial work proceeds. TRAIN remains absent; no production release attempted.
