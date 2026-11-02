# B009 historical suggestion basis — local checkpoint

Recorded 2026-11-02T10:50:03.207749-08:00. Immutable code `0107baac619d3faee3f802f9a052aeb79bdbc84a`, baseline e4432b94b0f554d3adc66e9c764598b0be2ce172, branch mode-b-repair-override-prep, Class B. **Scoped local PASS; whole B009 remains PARTIAL/PENDING; release/activation NO-GO.**

## Product behavior

The enabled bank-matching screen now explains the stored suggestion-time amount match, account-last-five match and date gap. The server projects unknown JSON into a fixed DTO containing only booleans and a supported day count; raw account digits, unknown fields and malformed values are not forwarded. Historical labels distinguish these facts from current payment details; unsupported records show an honest unavailable state. The score is not recomputed. Existing human rejection/manual selection, authorization, financial locks/allocation and the legacy OFF screen are unchanged. The OFF screen was not enhanced with this basis UI.

## Actual exact-code verification

- Clean standard full gate: **618/618 unit; 381 RLS total, 380 PASS/0 FAIL/0 CANCELLED/1 sole exact prior Ron-approved historical b888ccd skip**. All11 checks PASS; no RLS waiver, newskip or assertion relaxation. [Gate summary](../../e2e/results/gate-0107baac619d3faee3f802f9a052aeb79bdbc84a.md).
- Next20.005s, Cloudflare27.742s, originalpreflight3.291s all actual/effective exit0; Worker1/1 actual0. Original preflight SHA2567c4a336fc33172efc8e0b736ac4930923801b776b3bd5d79240613b3b2f195cb unchanged, command-local GNUawk. No deploy.
- Actual browser **2/2 cases PASS,18.154s**, one worker,390/1280; four EN/zh PNGs before rejection removes the suggestion. Historical facts remain after current payment/bank details change, malformed fallback has no raw marker/digits, and all original exact dedupe/reject/manual/actor/reason/allocation assertions remain. Empty safe event-category array enforces no unexpected page/console/5xx/off-origin events in these journeys.
- Corrected SELECT-only [readback](control-readback-0107baa.json) actual/effective0: original PRESENT full global row(value/description/microsecond timestamp) and whole org featureflags restored exactly versus independently seeded same-source build clone; globalOFF/0optins. Append-only history retains both widths:2manualmatches+2suggestionrejections. Last-width current bank/payment joins show1each, allocation1/76500. No whole-DB restore or persisted first-width public fixtures claimed.
- [Manifest](local-runtime-0107baa.json), SHA256405044a982bdd33fc916acc76a137371876f473d4a2d8d16bf84995257141c8c. Independent Solhigh evidence review checked49bindings/43unique files,12literal reviewed paths/current+candidate, seven actual receipts with14stablepins, rawTAP and all4PNGs; no mismatch. RootEN390+ZH1280/reviewerEN1280+ZH390 coversall4. [Independent review](independent-native-0107baa.md). This is not Claude signoff.

## Preserved failures and bounded corrections

The first cf928ca gate FAILED:618unitPASS, RLS48PASS1FAIL stopped49. On Nov2, synthetic paymentOct30 was reported forOctober but synthetic ownership defaultedNov2. Production SQL correctly excluded that future ownership. The narrowly reviewed seed correction sets the3synthetic ownership dates to existing sample lease start; the test adds a date precondition and preserves every financial/org assertion. New candidate0107baa passed, without changing report SQL/schema/defaults. [First failure](first-gate-cf928ca.md) and original raw/receipt/report remain.

The original readback helper incorrectly expected one global audit pair although the private append-only decisions intentionally retain bothwidths. Its original node process exit is **NOT_CAPTURED/UNVERIFIED** because it preceded another command in a shell cell; outerexit0 is not readback success. Original helper/output/observation are retained. A separately reviewed SELECT-only helper572d4aad checks exact history2each AND current joined1each, keeping all control/allocation checks; its new explicit subprocess receipt proves actual0. No data was deleted or browser rerun for that observation correction. Old runtime driver044bd037 source was byte-identically reconstructed after its two known edits and verified by preexecutionhash; it is not represented as a pre-edit saved copy. Current driver42a139c2 binds expanded fixture paths.

## Remaining scope and limits

Authorized de-identified real bank CSV/source provenance, exact staging app/catalog/function-owner/runtime/OFF/approved old-code/rollback evidence and independent Claude/Class B/Ron acceptance remain UNVERIFIED. Original-byte identity dedupes exact same bytes/account/org; reordered or overlapping exports without stable source IDs still need manual review. CSV bytes are not archived; metadata/hash is not downloadable storage. Historical bank/utility correction has separate integration evidence; no global deadlock-freedom claim.

New historical basis/fallback is readable and unclipped at both widths/locales. Existing Next development badge overlaps some older controls/sidebar; no whole-parent visual perfection claimed. This run was the standard gate plus changed-journey builds/browser, not --release, all-repo browser, other-machine/Depot, staging or production acceptance. B008's earlier UNKNOWN remains unwaived.

No new migration/DDL, operational flag activation, prod/main merge, real messages or legal-copy changes. Existing approved disposable fixtures only. Skip dependent acceptance; next eligible implementation is B010/B028 actual payment results to actual payer center across all existing payment transitions, using existing schema, with separate Email preference PE handoff as needed.

STOP POINT: WORKING; next: publish this checkpoint/mirror, then run `cat ../B010-payment-center-plan-1102.md` from the repo root and reserve shared B010/B028 source paths; owner Ron/Codex3099AC86.
