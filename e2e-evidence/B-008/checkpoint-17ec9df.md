# B008 monthly rent detail — bounded stop checkpoint

Recorded 2026-10-30T19:04:44.433953-07:00; immutable code `17ec9dfdd45c4a47807d0a251cbdff1840fe74c0`, baseline `56bd4998adca57704dd26132cc39eaed5140f649`, branch `mode-b-repair-override-prep`, ClassB. **SCOPED LOCAL PASS / whole B008 INCOMPLETE / release NO-GO.** Ron has stopped the queue; no new B starts.

## Product boundary

SELECT-only lease detail now binds the supported monthly rent plan to exactly one current usable primary bill-to, property/currency metadata, dates/due date and current rent evidence. Shared versioned operation plan distinguishes inclusive periodEnd from exclusive servicePeriodEnd; configured minor unit/display decimals preserve significant fractional value. Unsupported partial/move-out/nonmonthly/zero/uncertain range/payer/currency/coverage/cap states have no operation digest. Org batch digest remains a separate contract. Existing authority/session/consent controls are reused. No issuing control, private-table call, invoice numbering or financial write was added. Managers may read; future posting must validate actual current Admin/Accountant, never promote read permission into write authority. New monthly_rent_posting is reserved default-OFF registry metadata only, not an installed setting or issuing workflow.

## Actual checks

- Original fixed-code gate and user-requested separate clean rerun both PASS:615unit;381RLS total=380PASS/0FAIL/0CANCELLED/1sole exact prior Ron-approved b888ccd historicalSKIP. No RLS waiver/new skip/assertion relaxation. Last rerun18:57:18–19:01:39PT, actual exit0; [summary](../integration/closeout-1030-gate.md), [receipt](../integration/closeout-1030-gate.json). It is the standard gate, not --release or whole-repo browser.
- Same code Next20.999s,CF29.071s,original preflight3.307s all exit0/PASS; Worker1/1. Command-local GNUawk, original preflight SHA2567c4a336fc33172efc8e0b736ac4930923801b776b3bd5d79240613b3b2f195cb unchanged.
- Real final browser8/8,390/1280,30PNGs,70.662s, actual subprocess/effective exit0. New detailOFF/EN/zh/unsupported and existing statement/close/first-period/monthly cases. Controls compare original complete PRESENT global row and org flags to same-source seeded baseline: exact restore/OFF/0opt-ins; proposed private tables/posting control absent. No whole-DB restore claimed.
- [Original immutable manifest](rent-detail-boundary-17ec9df.json), SHA2569e230034f0a03f0f1aa6629a8cee542714004d56ad1c40d9b15e552f88b2c1d8. Independent native highest review verified75 artifact bindings,36 current/candidate files/72refs,15 baseline invariants and21changed-file set. Reviewer26+root4 finalPNGs=30. No mismatch. This review predates expected operational documentation/log updates; reviewed18 implementation/control/test blobs remain unchanged. [Review](../integration/closeout-1030-native-review.md).

## Failure and coverage limits

Initial preliminary monthly1280 case FAILED:7PASS1FAIL, original event/cause UNKNOWN; original log/context/all5casePNGs retained and bound. Static phase diagnostics preserve assertions; target1/full8 and final8passed. This is UNKNOWN_NOT_REPRODUCED, not a baseline designation, cause resolution or waiver. Whole-feature/release remains NO-GO. Existing dev badge overlaps some older controls/navigation; mobile edit image is pre-save checking/disabledSave, not settled/persisted proof. Pure21digit precision fixture exceeds issuable PostgreSQL numeric storage; do not claim a DB issuance case.

Staging read-only catalog/privilege and zero-row200 checks only reflect their timestamp. Login owner/EXEC metadata does not prove function runtime, deployed app/version or current complete catalog. StagePG17 vs localgatePG16 is explicit; no engine migration attempted. Claude/DesktopClassB, other-machine/Depot, approved old-code/new-schema/OFF/rollback, actual bill parity and staging acceptance remain UNVERIFIED.

## Unfinished DB-dependent portion

Actual monthly posting/full-bill parity is unfinished. New [MD](monthly-operation-db-handoff.md) + [.sql.txt](monthly-operation-proposed.sql.txt) exactly mirror Downloads b008-monthly-operation-db-handoff.md and20261031110008_b008_monthly_rent_operation.proposed.sql. Source review PASS_SCOPED_DB_PROPOSAL_REVIEW ONLY; NOT_APPLIED/NOT_RUN syntax or behavior. Two private tables/own-operation uniqueness+immutable historical outputs, no issuingRPC/legacywriter rewrites/globalfence. PE must validate actual target/roles/locks/reset/retention/compatibility and unique timestamp before an authorized nonMac entry. Applying tables alone does not finish B008. Earlier non-executable research remains historical, superseded as a proposed minimum contract; no approved source requires universal direct/legacy-write fencing.

STOP POINT: STOPPED_AFTER_REQUESTED_HANDOFF; next: wait for Ron, then recheck ownership and read20-build/codex-handoff-1030.md/BLOCKED before any work; owner Ron/Codex3099AC86. No prod/main merge/operationalMacmigration/newproposedSQL execution/externalmessage/legalcopy/operationalflagactivation.
