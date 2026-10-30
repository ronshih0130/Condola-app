# Independent native integration review — 4e43104

Candidate: `4e43104f45c3acf0dae76e40c7b577bd7ffb8ea6`.
Reviewer: independent native Codex reviewer, separate from the implementation agents and root test executor. This is not a Claude review or Class B sign-off.

**Scoped native source/integration verdict: PASS. Whole-feature and staging/release verdict: NO-GO.** No unresolved blocking source finding remains in the specifically reviewed integration deltas below. This statement is not a whole-application security audit, proof of every concurrency interleaving, or acceptance of all 39 queue items.

## Scope and exact binding

Prior native reviews covered the limited notification-center foundation, its four-portal entry wiring, guarded reset integration, registration, and subsequent consent/picker corrections. On this review pass, Git tree objects at the exact candidate were rechecked against those reviewed blobs. The later `b904429` checkpoint changes documentation/evidence only; it does not replace the candidate named above. Uncommitted mirror-log changes are outside this review.

| Reviewed source | Candidate Git blob |
| --- | --- |
| `supabase/migrations/20261031100215_b028_center_foundation.sql` | `33ba2a512832629ed6f0ef21b302ea580f65a301` |
| `src/server/notification-center.ts` | `099de6f02bb9c281dc680e0b3190d3724d576aaa` |
| `src/components/notification-center.tsx` | `ea8b47f4237dd1ad94f3cd876b6ac95a20472c8c` |
| `src/components/notification-center-entry.tsx` | `5e84d32fe910d2152d49addf5cd6d392ef6a965c` |
| `src/app/m/notifications/page.tsx` | `e4d62d17ac388aacb9bcbaa1fda4a8fc2f02adb1` |
| `src/app/t/notifications/page.tsx` | `63f9632c1da7bc6f23186d81eb79e54b0f607e47` |
| `src/app/o/notifications/page.tsx` | `ad9640cb2440728c7139d356742b1c88abcabc68` |
| `src/app/v/[token]/notifications/page.tsx` | `1833c9ffed3119fe97e883759b7e947cfc5f62f2` |
| `src/app/m/page.tsx` | `f0304d6821eb23422d030db26d6896af0596a10d` |
| `src/app/t/page.tsx` | `697f94a751067ceec8341b3b4796acde98671665` |
| `src/app/o/page.tsx` | `b0764ec1e927879f289a5c6c47c9e507316d3f80` |
| `src/app/v/[token]/page.tsx` | `54c120476b92254276e2130d1d57f977b643b17d` |
| `src/server/notification-center-actions.ts` | `1530fa962d3216c5ad4e830690252b25cda9f2c1` |
| `src/server/consent-entrypoints.test.ts` | `e19927cc7992ae01372074afdb5cd2fd9ab80883` |
| `e2e/b028-center-local.spec.ts` | `f6551ce3de0077cd3f043d39b3bb32251e35b03f` |
| `src/server/seed.ts` | `e86e791df70280ecd608b4ccf8ed94bfc8cba883` |
| `src/server/notification-center-seed.integration.test.ts` | `4a5ccc43d954b33c74b6031f5c64d79b7d221ffc` |

The reviewed boundaries are strict default-OFF global/org admission; current session/persona and exact vendor-job authorization; immutable recipient identity with current entitlement rechecks; separate read state; bounded opaque pagination; wall-clock expiry after waits and at deferred mark completion; and child-first, owner-controlled demo reset behind shared admission. Human pages run consent first, human mutation uses action-mode consent, and only the exact established vendor-token entry points have the narrow token classification. Navigation uses the destination's authorization; vendor links do not prefetch bearer URLs. The browser fixture uses the real tenant picker and clears human cookies before the anonymous vendor flow.

Registration review covered the ordered migration inventory/classifier, explicit test registration, default-OFF flag registry and isolated browser configuration. These reviews do not authorize changing frozen migrations, enabling real providers, broadening application database privileges, or making historical events acquire new recipients.

## Execution evidence and attribution

This reviewer did not rerun the gate, database suites, browser, builds or Worker. Root-executed results are recorded in [the exact gate summary](gate-4e43104f45c3acf0dae76e40c7b577bd7ffb8ea6.md) and [the local verification manifest](core89-local-verification.json):

- Pinned local gate: 572 unit tests passed; RLS 260 total, 259 passed and one explicitly Ron-approved historical-commit skip. No new failure waiver.
- Next build, Cloudflare staging build, deployment preflight and local Worker smoke: reported PASS, Worker 1/1.
- Fresh 89 versus supported 71+18 upgrade: 11 logical catalog categories equal, synthetic counts preserved; isolated function-privilege scan passed.
- Actual four-portal home-to-center/read/mark navigation at 390/1280, including tenant selection and anonymous exact vendor job: reported PASS. Events in this scenario are owner-created synthetic fixtures, not evidence of real producer coverage.
- Full default 52-spec browser batch was still running when this record was written. No overall browser PASS is asserted here. Earlier B010/handover browser results retain their own source-bound scope.

The failed `707348a` consent gate and tenant-picker browser attempt remain preserved in [the correction record](core89-consent-picker-correction.md). Later passing evidence does not erase those failures or establish an unrelated root cause.

## Remaining acceptance boundaries

100216 settlement and 100217 real-producer work are unintegrated drafts and are excluded. B011 handover is not complete settlement acceptance. B028 center fixtures are not the eight real producer families; B010 local capture is not actual email delivery. Full feature UX, source coverage, retention and relevant policy decisions remain open. Broad contacts-table admission and similar concurrency tradeoffs require their bounded operational review, not a claim of global deadlock freedom.

Staging metadata access is read-only evidence; required new objects and an actual migration ledger were reported absent. No staging application acceptance, schema migration or deployment is established. No Mac migration is authorized by this record.

Claude independent Class B QA, other-machine and Depot gates, e-sign G0–G5 evidence as applicable, stage migration/restore/row-count/rollback evidence, exact-SHA CEO GO, production conditions and T+0/T+15 monitoring remain separate required gates. No production activation, real provider traffic, external transmission or legal-copy approval is granted. The entire release remains NO-GO until its applicable conditions are actually met.
