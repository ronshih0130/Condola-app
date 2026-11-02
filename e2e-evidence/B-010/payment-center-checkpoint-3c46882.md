# B010/B028 actual payer center — local checkpoint

Recorded 2026-11-02T11:32:32.249854-08:00. Code `3c46882327ea85d3cc3be34758fca39226f2b507`, baseline e28eefdf62942f149ca4cb5887e4fb683d5a140b, mode-b-repair-override-prep, Class B. **Scoped local PASS; whole B010/B028 INCOMPLETE/PENDING; release/activation NO-GO.**

## Product behavior

Actual payment confirmation, rejection and reversal now create the actual eligible payer's existing tenant-center result in the same financial commit. Coverage includes ordinary confirm/reject/reverse, manager-recorded confirmed payment, legacy bank matching and enhanced bank matching. Center gating is independent of Email/payment_results. Linking an alreadyconfirmed bank payment emits none; rejecting a bank suggestion is not a payment rejection. No co-tenant broadcast, historical recipient backfill or new recipient on replay. Unbound/ineligible payer yields no tenant recipient while valid accounting remains intact.

A fixed server-only bridge saves/restores role and JWT around only private-center SQL on the same Client/transaction. Original financial work keeps its original RLS, permissions, math, allocations, reversal and command replay. A strict public OFF/missing/malformed precheck returns before private-schema/owner/RESET operations; ON still rechecks locked canonical selected/liveorg, session/membership/actionroles and owner capability. Pre-source resolution precedes transitions/source creation. New center records use existing neutral occurrences; when a b010 event exists, its returned id/key/actor are verified and its exact DB timestamp is reused by the neutral occurrence. This uses existing checked-in schema, not approval or proof of a hosted catalog.

## Exact immutable checks

- Standard clean pinned full gate **618unit PASS;391RLS total=390PASS/0FAIL/0CANCELLED/1sole exact prior Ron-approved historical b888ccd SKIP**, all11checksPASS, actual/effective0 in233.848s. No waiver/newskip/assertion relaxation. [Gate](../../e2e/results/gate-3c46882327ea85d3cc3be34758fca39226f2b507.md).
- Next20.672s,CF28.158s,original GNUawk preflight3.379s andWorker1/1 all actual/effective0; unchanged preflight SHA2567c4a336fc33172efc8e0b736ac4930923801b776b3bd5d79240613b3b2f195cb. No deploy.
- Final real browser center390/1280 **2/2PASS** and affected unchanged B009 private bank profile390/1280 **2/2PASS**, actual/effective0. Six PNGs. Tenant sees confirmed/read, rejected/unread and reversed/unread; real mark persists; othertenant has no payer recipients; paymentResults stays OFF in this journey. B009 historical basis/fallback and duplicate/reject/manual/allocation assertions remain. No unexpected page/console/5xx/off-origin categories in those journeys.
- Separate SELECT-only readback actualProcessExit0/effective0, Node20.20.2 and PostgreSQL-enforced readonly: named full global rows(value/description/UTCmicroseconds) plus whole selectedorgflags exactly match independently seeded same-source build clone; namedglobalsOFF/0optins in both profiles. Control restoration only, not a whole DB or audit-history restoration.
- [Manifest](payment-center-runtime-3c46882.json) SHA25608029a479a16f94c9949ede286907f1e4fa86bf8745458673b27905f33b61603,32048bytes. Independent Solhigh final review checked62bindings/62unique files,23literal source=current=candidate=freeze and14baseline invariants;8actual0receipts, rawgate/logs/helpers andall6screens. Source9changed+14unchanged match reviewed freeze. [Review](payment-center-independent-3c46882.md).

## Development history and source correction

Sixteen WIP/history artifacts are retained and bound. Earlier raw attempts contain failures(a2,b2,d1,e6,f1) and laterdevelopmentpasses(c4,g6,h7,i21,j10). Exact earlier-cause mapping stays UNVERIFIED where the raw evidence does not establish it; author reports are not substituted for raw proof. These are pre-freeze development attempts, not immutablecandidate passes or baseline waivers. Finalcandidate8phases succeeded without retry.

The real preliminary P2 OFF/nonowner regression was fixed before freeze: public precheck now precedes private owner operations, with actual authenticated nonowner OFF/missing/malformed tests and ONownerdenial. SQLguard42501 for legacybank while enhancedflagON remains productionbehavior; tests now explicitly prove denial/no sideeffects, then legacyOFF and enhancedON correctly. Original financial assertions remain. Author's selectedmodel capacity error happened after completed final receipts including readback; Terra performed read-only evidence assembly, no test/DB rerun or source edits. Independent Sol review ran no tests/DB, inspecting author-run evidence.

## Separate unapplied Email preference handoff

Downloads `b010-payment-email-db-handoff.md` SHA2565f848228737c3e46084152a831460cde9cab1332b8e1e269c700f277a1da744d and `20261102113010_b010_payment_email_preference.proposed.sql` SHA256b14c2696afbf6ac101994a56296dc82d01d5a54671be77f7e036fcee42bffae8. [Repo handoff](payment-email-db-handoff.md), [.sql.txt](payment-email-preference-proposed.sql.txt), [source-only verdict](payment-email-db-source-review-1102.json). One separate default-true personal paymentEmail preference on existing private table, fixed tenant-authorized get/set and redacted audit; preserves due/no-row/upsert semantics. Setter reuses existing resetadmission SHARE NOWAIT before parent/pref locks; this is reset coordination, not rollout gating. Currentinappcenter is not blocked by this proposed column.

**UNAPPLIED / syntax, catalog and behavior NOT RUN.** PE must validate actualtarget/history/timestamp/roles/grants,PG16/17,reset/concurrency/expiry/oldcode/OFF/backup/rowcounts/rollback on authorized nonMac workflow. Source GO is not apply/security/runtime approval. Original .initial drafts remain outside for history, not an executionlist. Future Email preference enforcement, claims/capture/provider/UNKNOWN/actualmailboxreceipt remain incomplete; captured is not delivered. Personal defaultON is not featureflag activation; operational release flags remain untouched.

## Limits and continuation

Eligible actualpayer source results are locally verified; current staged app/catalog/owner/runtime, independentClaude/ClassB/Ron acceptance, other notification families/four-app producers and real Email/LINE/provider delivery remain UNVERIFIED/incomplete. Full39/fourportal/LINEMVP not accepted. ExistingNextbadge overlaps olderbankcontrols/sidebar andtenant bottomnavigation, not newnotification content; all6affected captures readable/unclipped, no blanket parentvisualPASS. Standard gate plus relevant fourbrowsercases, not --release/all-repobrowser/othermachine/Depot/staging. B008UNKNOWN unwaived.

No newruntimeDDL/operationalmigration/prod/mainmerge/keys/activation/externalmessages/legalcopy. Existingapproved disposabletestfixturesonly. Otherworktrees/source/evidence preserved. Next: publish/mirror this verified checkpoint; skiponlydependentEmail/acceptance scope and inspect B011's actual handover/settlement source and retained recovery branch, without assuming new schema by default.

STOP POINT: WORKING; next: publishcheckpoint then read20-build/specs/B-011.md/currentB011status/BLOCKED; owner Ron/Codex3099AC86.
