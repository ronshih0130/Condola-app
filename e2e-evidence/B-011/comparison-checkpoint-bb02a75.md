# B-011 photo comparison — verified local checkpoint

Recorded 2026-11-02T13:18:10.146031-08:00. Immutable code `bb02a75d9440a20a067b9e6481a65b3a5bb78a83` on `mode-b-repair-override-prep`, Mode B, Class B. **Photo-comparison slice: local PASS. Whole B-011: pending/incomplete. Release and activation: NO-GO.**

## Product behavior

Managers and tenants can independently choose a move-in and move-out version and photo from their authorized lease. Historical selections preserve the selected version's publisher/publication time and the photo's original uploader/upload time. An inherited photo is not presented as a new upload. Selection is read-only; existing immutable history and separate replies remain unchanged.

The comparison uses existing checked-in handover schema and the unchanged authenticated private file route. No new runtime DDL, financial writer, authorization route or provider integration was added. Current-prop validation and composite version/attachment identity prevent stale or foreign selections; changing lease resets component state. PDFs remain downloadable history, with an honest no-photo state. Loading/error states and protected original-file links are explicit. A per-mount image state and stable completion ref handle revisits and already-decoded images without leaving false loading captions. Container-based columns keep wide staff views paired and narrow tenant shells stacked.

No automatic same-room pairing, damage assessment, deduction, agreement or money-movement inference is made.

## Exact local verification

- Standard clean pinned gate: **618/618 unit PASS, zero unit skips; 391 RLS total = 390 PASS, 0 FAIL, 0 CANCELLED, 1 exact prior-approved historical `b888ccd` skip**. All 11 gate checks passed, actual/effective exit 0. The old skip was approved by Ron on 2026-10-29; no additional skip or baseline waiver. [Gate](../../e2e/results/gate-bb02a75d9440a20a067b9e6481a65b3a5bb78a83.md).
- Next build 18.639s; Cloudflare build 27.592s; unchanged original GNUawk preflight 3.231s with `PREFLIGHT PASS`; Worker 1/1 in 2.342s. Every actual/effective exit is 0. No deployment or `--release` claim.
- Final browser matrix: **4/4 PASS, 49.4s**, English and zh-TW at 390/1280, eight captures each: **32 PNGs**. Real synthetic publish/upload, distinct decoded PNGs, old/current versions, phase independence, inherited provenance, empty/PDF/loading/error/recovery, staff/tenant, private no-store/exact bytes, foreign-tenant denial and flag OFF are exercised. Version/attachment/reply and selected financial rows remain identical across read-only selection; legitimate attachment-read audit records are allowed.
- The separate single EN390 diagnostic passed 1/1 with eight captures. It does not replace the final four-case matrix; its other three cases were NOT RUN.
- Exact expected negative responses are asserted separately: the injected photo 404 and the intentional feature-OFF document 404. The latter requires exact message, owned URL, intentional phase/navigation, actual GET/document/main-frame 404 response, and exactly one matched response and console event. All other console/page/5xx/off-origin errors still fail. This is not an all-404 allowlist.
- **Unchanged SELECT-only independent readback: actual/effective 0.** PostgreSQL-enforced read-only connections compare the full named `handover_records` row (key, value, description, UTC microsecond timestamp) and the whole selected organization's flags against an independently seeded same-source clone. All match; named global OFF and zero org opt-ins. This is not whole-database or audit-history restoration.

[Runtime manifest](comparison-runtime-bb02a75.json): SHA-256 `a76bf686dcf37eeeb0393a0b5d2f8c4eca6f8a7c364bb389e2e1cb87fa6e8b03`, 115224 bytes. Independent review verified 295 hash/size bindings, 286 unique paths, 25 source pins, three helpers and 13 receipts. [Independent review](comparison-independent-bb02a75.md).

All 32 final images were inspected (root EN390/ZH1280; separate reviewer EN1280/ZH390). Native scrolling fixes earlier sticky-header capture artifacts; tenant viewport pairs jointly show both phases. Existing Next dev-badge partial overlays and tenant navigation/older-history/editor limits remain. The fixtures are valid distinct **1px** PNGs: transport, state and provenance proof, not realistic photo-detail/large-aspect QA or perfect parent-page UI.

## Preserved failures

All eight earlier attempt archives remain: 204 physical files and 192 recorded archive entries independently rehashed. Their original outcomes are not rewritten:

| Attempt | Recorded outcome |
|---|---|
| 8909c64 a1 | Gate FAIL: missing PDF tools in helper PATH; unit 616 PASS/1 FAIL/1 new unapproved SKIP; completed RLS 191 PASS/1 FAIL/1 historical SKIP. Corrected environment; no skip waiver. |
| 8909c64 a2 | Clean-checkout FAIL before tests because the prior generated summary remained untracked. Tests NOT RUN. The exact generated file was preserved and moved outside. |
| b2e4b6e a3 | Gate/build passed; browser exit 130: two English timeouts, zh390 interrupted, zh1280 NOT RUN, zero browser passes. Timeout cause remains UNKNOWN. |
| 59f3b5c a4 | One focus FAIL: repeated GET observed zero after a bounded wait. Underlying mechanism remains UNKNOWN; no retrospective cache/React claim. |
| d4a6aa4 a5 | One focus FAIL: decoded photos retained two loading captions. Product state handling corrected; mechanism not overclaimed. |
| 9790f39 a6 | One focus FAIL at an unattributed generic console 404; location was not retained. Attribution remains UNKNOWN. |
| 5f5de70 a7 | Observation-only focus FAIL preserved. Exact categories proved that run's intentional OFF-document 404, enabling the strict named-negative assertion. It does not retroactively identify a6. |
| 98d5f79 a8 | Gate/build/final 4-browser passed, but independent exact-control readback FAILED. Separate SELECT-only diagnostic proved only timestamp differed because the enabled UPDATE trigger stamps `now()`. Diagnostic exit 0 meant data collection, not restoration. |

The final fixture reuses the existing B009/B010 transactional targeted DELETE/INSERT restoration method, verifies the exact saved row and whole selected flags before COMMIT, rolls back on failure and preserves journey/cleanup/close errors. No trigger disabling, timestamp omission or assertion/timeout relaxation. The independent readback helper is unchanged and finally passes.

## Remaining scope and handoff

Whole settlement remains unfinished: authoritative deposit attribution, itemized charges/adjustments, current financial-source validation, independent actual refund/top-up acknowledgement, original settlement preview-stream issue, staging and Claude/Class B/Ron acceptance. The recovery draft `b13c82b` remains preserved and unaccepted; no unreviewed schema/UI was ported.

Downloads `b011-settlement-db-handoff.md` (SHA-256 `9ac0608d9e74baa32e65bf4385e528f894e806b624a2a81aba84834a38f16aa5`) and `20261102194206_b011_settlement_foundation.proposed.sql` (`1b5a94893e8bad11a0b933d0abce1fce05197f1b014a0e80abe9371b9ba70abe`) are a **closed six-table design only: UNAPPLIED, NOT RUN, NOT APPLY-READY**. [Handoff](settlement-db-handoff.md), [SQL text](settlement-foundation-proposed.sql.txt), [source-only review](settlement-foundation-source-review-1102.json). Current photo comparison does not depend on this proposal.

Codex still needs to write/review the minimal canonical attribution and fixed-gateway proposal before PE validates/applies anything on an authorized non-Mac workflow. Approved manual supported deposit amounts do not require classifying every remaining dollar; invoice-level allocations are context for the same payment, not an additional withdrawal to subtract again. Specific unresolved source collisions remain unknown. Do not treat the existing closed proposal as financial authority or approval to apply it. No new broad Ron policy is assumed.

Current hosted catalog/app/runtime and full feature acceptance are **UNVERIFIED**. No prod access/keys, main merge, proposed SQL execution, operational flag activation, external messages or protected legal-copy edit occurred. Existing approved disposable fixtures only. Full 39-item/four-party/LINE objective remains open; B008 UNKNOWN remains unwaived.

STOP POINT: WORKING; next: publish/mirror this checkpoint, then execute the bounded B012 plan while parking only DB-dependent hosted writers and producing the required PE handoff; owner: Ron/Codex 3099AC86.
