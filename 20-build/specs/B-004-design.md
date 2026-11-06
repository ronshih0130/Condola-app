# B-004 — JIT L2 設計稿：紙本租約版本、租客下載與稽核（驗證＋CAP-P-28 紙本路徑）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-004.md` incl. **PROP-US-v03-01** (paper path reads the same two ID switches as e-sign; upload ≠ establishment; non-blocking by default). Stacked on the B-001 CAP-P-28 slice (PR #39, `fc94d83`), which already routes the staff signed-PDF upload gate (`uploadSignedLeasePdf` in `src/server/domain.ts`) through `identityRequiredForSigning`.

## Evidence reconciliation (existing work, no rebuild)

| Acceptance | Existing evidence |
|---|---|
| Replacement without reason rejected; with reason the old version stays immutable | `paper-lease-versions.integration.test.ts` (reason codes, immutable history; migrations 151400/151500, `20261031100222/223`) |
| Own-lease download returns private/no-store/nosniff **attachment** and one audit event | `tenant-signed-pdf-route.integration.test.ts`, `staff-signed-pdf-route.integration.test.ts` (B-004 adds the `Content-Disposition: attachment` assertion to both), `tenant-signed-pdf-download-audit.integration.test.ts` |
| Another org / flag OFF exposes nothing | cross-org: route tests; **flag OFF: B-004 adds tenant-route cases with the org flag OFF and the global setting OFF (404, no PDF bytes, no download audit)**; upload-side: `archived-lease-signed-pdf.integration.test.ts` |

Gaps found by cross-review were in the *evidence* (attachment header, flag-OFF file requests), now asserted; no product code change.

## New in this slice (PROP-US-v03-01 paper path)

`src/server/b004-paper-id-switch.integration.test.ts`: rollout OFF keeps the ID hard gate (`errors.idDocRequired`, no write) for ended and draft leases; ON with defaults and with every non-blocking combination (true×false, false×false, false×true invalid) the signed paper lease is stored **and a draft lease is established (active / fully_signed)** while ID collection runs in parallel; true×true blocks with no write. Global setting and org state are snapshotted and restored exactly. No manual-approval step; PRINCIPLES 9/11/17 unchanged; no copy changed.

## Done means

Same as the table above plus: an admin can store a signed paper lease for a tenant who has not uploaded ID when the rollout flag is ON with default switches, and cannot when both switches are ON. Flag OFF unchanged.

## Cross-review (Codex QA)

r1 FAIL (5: cleanup restore, incomplete matrix, establishment uncovered, attachment unasserted, flag-OFF file requests unexercised) → all fixed. r2: 3 closed; remaining exact `"Not found"` body assertion and ended-lease status assertion applied after r2 (not re-reviewed; 2-round cap).
