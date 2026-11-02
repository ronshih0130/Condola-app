# Ordered build queue

> **Current 2026-11-02T13:18:10.146031-08:00: complete queue remains active. B011 photo comparison has scoped local PASS at `bb02a75d9440a20a067b9e6481a65b3a5bb78a83`; whole settlement/staging remains pending. Earlier stop notes are historical.**

Priority follows ROADMAP P1: finish existing flag-OFF work, then manager → tenant → owner → vendor → platform gaps, then complete three-portal LINE.

All statuses begin `todo`, including previously built items: their first action is evidence reconciliation, not automatic reimplementation.

All feature flags below default **OFF**. Names marked `*` are proposals; reconcile with the registry. Existing live behavior stays at its recorded setting. Testing a flag ON is permitted only in an isolated local/staging test organization.

| ID | Title | Story / journey / capability; inventory | Depends on | Flag, default OFF | Class | Size / hours | Status |
|---|---|---|---|---|---|---|---|---|
| B-001 | Finish e-sign integration and gates; activation: **Ron decides** | MGT-09/10, TEN-03; J2; CAP-P-09/10, CAP-T-01/08, CAP-M-01/19; T-04 | Existing paper fallback evidence | ESIGN_ENABLED | B | L / 24–40 | pending |
| B-002 | Finish MOVE_OUT and ID_PURGE; activation: **Ron decides** | MGT-20, TEN-02, PLT-04; J1.7/J6; CAP-M-13, CAP-P-02, CAP-T-06; M-67 | Existing errredact/privacy release evidence | MOVE_OUT_ENABLED; ID_PURGE_ENABLED | B | M / 16–24 | pending |
| B-003 | Finish payee details and full access audit; activation: **Ron decides** | MGT-04, TEN-06; J3.3; CAP-M-03, CAP-T-03; T-08 | Existing payee lane | PAYEE_DETAILS_ENABLED | B | M / 16–24 | pending |
| B-004 | Verify paper lease versions, tenant downloads and audit | MGT-10, TEN-03; J2.6/7; CAP-M-02, CAP-T-02 | — | PAPER_LEASE_VERSIONS_ENABLED; TENANT_SIGNED_PDF_ENABLED | B | S / 6–10 | pending |
| B-005 | Onboarding, invitations and resumable trial | MGT-01/02/03/28; J1; CAP-M-04/05/28; P-10 | — | TEAM_INVITES_ENABLED; ONBOARDING_PROGRESS* | B | M / 16–24 | pending |
| B-006 | Import error detail and regional source formats | MGT-05; J2.1; CAP-M-06 | — | IMPORT_ERROR_DETAILS* | A | S / 6–10 | pending |
| B-007 | Deposit rule hints and excess-reason audit | MGT-08; J2.3; CAP-M-07 | — | DEPOSIT_RULE_HINTS* | B | M / 12–20 | pending |
| B-008 | Billing, utility and statement amount previews | MGT-12/26; J3.1/J7; CAP-M-08/22; M-40 | — | BILLING_PREVIEWS* | B | M / 20–32 | pending |
| B-009 | Bank CSV dedupe and manual matching | MGT-14; J3.5; CAP-M-10/23 | — | BANK_MATCHING* | B | M / 16–24 | pending |
| B-010 | Rent reminders and payment review results | MGT-13/15, TEN-07; J3.2/6/7; CAP-M-09/11; M-70 reminder | —; delivery adapter contract in B-028 | RENT_EMAIL_REMINDERS*; PAYMENT_REVIEW_RESULTS* | B | M / 20–32 | pending |
| B-011 | Handover and deposit settlement, including bilateral replies | MGT-16/23/24, TEN-10/11; J4/J6.6–8; CAP-M-12/14/21, CAP-T-05/10; M-26 | B-002 | HANDOVER_RECORDS*; DEPOSIT_SETTLEMENT* | B | L / 40–64 | pending |
| B-012 | Renewal comparison and early-termination lifecycle | MGT-20/21/22, TEN-14–17; J6; CAP-M-13/20, CAP-T-11; M-25 | B-002, B-011 | LEASE_LIFECYCLE_RECORDS*; LEASE_RENEWAL* | B | L / 32–48 | pending |
| B-013 | Manager dispatch and shared repair approval state | MGT-17/18/19/35; J5; CAP-M-15/16; M-48/49 | —; coordinated B-021/B-024 | vendor_dispatch; REPAIR_APPROVALS* | B | L / 32–48 | pending |
| B-014 | Owner net ledger, transfers and report versions | MGT-25/26/27, OWN-02; J7; CAP-M-17/18, CAP-O-03; M-43 | B-008 | OWNER_NET_LEDGER*; MONTHLY_REPORT_DELIVERY* | B | L / 24–40 | todo |
| B-015 | Archive records and reuse/edit tenant identities | MGT-06/07; J2.1/3; CAP-M-26/27; M-11/14 | — | RECORD_ARCHIVE*; TENANT_DIRECTORY_EDIT* | B | M / 16–24 | pending |
| B-016 | Company/profile settings and management-fee rules | MGT-04; J1.1/J7; CAP-M-25/29; M-42/58 | B-003 | COMPANY_PROFILE_EDIT*; MANAGEMENT_FEE_RULES* | B | M / 20–32 | todo |
| B-017 | Custom role permissions with escalation protection | PLT-01/02; J1.4; CAP-P-12; M-54 | — | CUSTOM_ROLES* | B | L / 24–40 | todo |
| B-018 | Tenant payment history and home states | TEN-07/08; J3; CAP-T-04/09; T-09 | B-003, B-010 | TENANT_PAYMENT_HISTORY* | B | M / 12–20 | todo |
| B-019 | Tenant conversation creation | TEN-13; J5; CAP-T-12; T-15 | — | TENANT_THREAD_CREATE* | B | S / 6–10 | todo |
| B-020 | Tenant account, sessions, preferences and data requests | TEN-18; J1; CAP-T-13; T-16/17 | —; notification integration B-028 | TENANT_ACCOUNT_SETTINGS* | B | M / 16–24 | todo |
| B-021 | Owner thresholds and versioned repair decisions | OWN-12/13/06; J5.4; CAP-O-01/02/08; O-05 | B-013 | REPAIR_APPROVALS* | B | M / 16–24 | pending |
| B-022 | Owner transfers, receipt title and report replies | OWN-02/03/10; J5.7/J7; CAP-O-04/06/07; O-08 | B-014 | OWNER_RECEIPT_TITLE*; OWNER_REPORT_REPLIES* | B | M / 16–24 | todo |
| B-023 | Owner files, lifecycle replies, repairs, messages and settings | OWN-04/05/07/08/09; J1/J2/J5/J6; CAP-O-09/10/11; O-06/07/09/10/11 | B-001, B-011, B-012 | OWNER_PORTAL_EXTENSIONS* | B | L / 40–64 | todo |
| B-024 | Vendor accept/reject/schedule/completion UI | VEN-01/04/13; J5.2–6; CAP-V-01/02/03; V-01/02/03 | B-013, B-021 | vendor_dispatch; VENDOR_COMPLETION_REASON*; REPAIR_APPROVALS* | B | M / 20–32 | todo |
| B-025 | Vendor onboarding, fixed data, documents and trade fields | VEN-02/05/06/07/08/11/12; J1.8/J5.7; CAP-V-04/05/07/08/09; V-05–10 | B-022, B-024 | VENDOR_DOCUMENTS* | B | L / 40–64 | todo |
| B-026 | Vendor estimates, account/history and enhanced sharing | VEN-03/09, MGT-30; J1.8/J5; CAP-V-06/10/11, CAP-M-24; V-11/12/13 | B-013, B-024, B-025 | VENDOR_ACCOUNT*; VENDOR_ESTIMATES*; VENDOR_LINK_ENABLED | B | L / 32–48 | todo |
| B-027 | Platform isolation, partner consent and rollout controls | PLT-01/02/03/16; J1; CAP-P-01/03/05/06/07/09/12/16; M-68 | B-001–003 for relevant integration checks | PARTNER_CONSENT_GATE; PARTNER_PRICING_HIDE*; PARTNER_UNIT_OVERRIDE*; PARTNER_EA* | B | L / 32–48 | todo |
| B-028 | Event delivery results, reminders and four-app notification center | PLT-05/13; J1/J3/J5/J7; CAP-P-13/15/22; P-19, M-70 | — | EMAIL_DELIVERY_RESULTS*; NOTIFICATION_CENTER* | B | L / 32–48 | pending |
| B-029 | Usage events and five metering hooks | PLT-11; J2/J3/J4/J5; CAP-P-11; P-23 | — | USAGE_EVENTS* | B | M / 16–24 | todo |
| B-030 | Usage summaries, limits, plans and subscription lifecycle | PLT-12/15, MGT-33; J1/J3; CAP-P-25/26; P-22/24, M-68 | B-027, B-029; Ron pricing/provider decisions | USAGE_LIMITS*; SUBSCRIPTIONS* | B | L / 40–64 | todo |
| B-031 | Audit detail, reliable uploads and token/session hardening | PLT-07/08/09; J1/J2/J4/J5; CAP-P-19/20/21/24 | B-001 | AUDIT_DETAIL*; UPLOAD_RECOVERY*; SESSION_HARDENING* | B | L / 24–40 | todo |
| B-032 | Regional formats, export explanations and legacy-demo verification | PLT-06/10/14; J1/J3/J7; CAP-P-14/23/27, CAP-M-05; P-29 | —; approved copy batch for protected texts | REGIONAL_FORMATS* | B | M / 16–24 | todo |
| B-033 | LINE shared schema, real login, webhook and quota foundation | TEN-09, VEN-10, PLT-05; J1/J3/J5; CAP-P-18; P-34 | B-027, B-028 | LINE_PLATFORM_ENABLED*; LINE_PUSH_QUOTA_GUARD | B | L / 56–76 | todo |
| B-034 | Tenant LIFF, invitations, binding and unlinking | TEN-01/09; J1.6/J3; CAP-P-18, CAP-T-07 | B-033 | LINE_TENANT_ENABLED | B | M / 12–18 | todo |
| B-035 | Vendor LIFF and job-scoped binding | VEN-09/10; J1.8/J5; CAP-P-18, CAP-V-11 | B-026, B-033 | LINE_VENDOR_ENABLED* | B | M / 12–18 | todo |
| B-036 | Owner LIFF and authorized-property binding | OWN-01, PLT-05; J1.5/J5; CAP-P-18, CAP-O-05 | B-033 | LINE_OWNER_ENABLED* | B | M / 10–16 | todo |
| B-037 | Rent and payment-result LINE pushes | TEN-09, PLT-05; J3.2/6/7; CAP-P-18, CAP-M-09/11 | B-010, B-018, B-034–036 | LINE_RENT_PUSH_ENABLED* | B | M / 12–16 | todo |
| B-038 | Repair-state LINE pushes | TEN-09, OWN-13, PLT-05; J5; CAP-P-18 | B-013, B-021, B-034–036 | LINE_REPAIR_PUSH_ENABLED* | B | M / 8–12 | todo |
| B-039 | Dispatch LINE pushes and full three-portal rehearsal | VEN-10, PLT-05; J5.2/3/6; CAP-P-18 | B-024, B-034–038 | LINE_DISPATCH_PUSH_ENABLED* | B | M / 10–14 | todo |

## Legend and execution

- S/M/L describe implementation and verification effort, not elapsed delivery time. Hours are planning ranges, including review/fixes, excluding external waits and production release.
- Story IDs and CAP IDs are from the hub. Short M-/T-/O-/V-/P- IDs reference `current-state.md`.
- B-017 has no dedicated custom-role CAP: it maps to the existing isolation capability and explicitly covers inventory M-54. Do not invent a canonical CAP ID.
- LINE owner scope maps to shared CAP-P-18 and existing owner invitation stories; there is no separate owner-LINE story in the source.
- `LINE_PUSH_QUOTA_GUARD` is a protective control, not a feature toggle defaulting OFF. It defaults **ON** whenever LINE is enabled; OFF/invalid/unavailable means no push and Email fallback.
- Existing `MOVE_OUT`, consent, dispatch and partner flag identifiers must be confirmed against code/registry before mutation; names above never justify creating a second competing switch.

Choose the lowest-numbered unfinished item whose required dependencies are satisfied and which is not blocked. Forward platform dependencies may be implemented as mocked interfaces first; end-to-end completion waits for their evidence. Revisit earlier items after each completion.

B-013/B-021/B-024 share one repair-state contract. Reserve their shared files once and integrate as one coordinated lane. Likewise combine overlapping auth, finance, locale and migration-list edits. Do not create simultaneous unshipped PRs touching the same files. Large groups above are shared-file integration lanes, not instructions to combine unrelated small changes blindly.

Statuses: `todo → in_progress → verifying → done`; alternatives `blocked` or `pending`. `done` means exact-SHA staging verification and required independent verdict complete, never production activation. Write evidence links and SHA in the item’s `status.md`; update this table from the owning session. A blocked activation does not prevent build-only completion.

All 缺/部分 inventory gaps are covered, including P2 billing/usage gaps. Legal-text dependencies are recorded for Ron; implementation proceeds around them. No scope cuts are authorized.

## 2026-10-30 bounded closeout (Ron requested stop)

No new B item was started. `pending` for B-010/011/013/021/028 means an existing partial lane is parked with explicit next steps, not accepted or currently executing. Other rows retain their earlier status. **No whole B item reached `done` in this closeout**: that requires exact-SHA staging evidence and independent QA under this queue's definition.

- B-013/B-021: personal company/currency defaults and property override settings, audit and original-request recovery have scoped local evidence. Estimate versions, designated-owner decisions, emergency/reminder/dispatch enforcement remain incomplete; B-024 stays `todo`.
- B-010/B-028: current integrated RLS gate remains FAIL at the source fixture; producer research on the separate recovery branch is not a working notification producer.
- B-011: staff UNKNOWN draft/recovery UI is WIP on its recovery branch; real preview stream abort remains unresolved. No authoritative settlement or party completion.
- This closeout ran `npm run test:unit` once on unchanged runtime source `2822b413938cd68c0d91e8b2423d8f319ed0c671`: **599 PASS / 0 FAIL / 0 SKIP**. No DB migration, DB test, main merge or deployment was run.

Details and next actions: [handoff](handoff-20261030-closeout.md), [blockers](BLOCKED.md#closeout-20261030), [test evidence](../e2e-evidence/B-013/closeout-20261030.json). Remain stopped after checkpoint push; no automatic next-item execution.

## PE fixture repair / B013-B021 continuation — 2026-10-30

Latest candidate `f419aa6e454162b9bf48ebdfbe6a0b8c903441b9` full gate is **PASS**, unit599PASS and RLS357PASS0FAIL1approvedhistoricalSKIP. This supersedes the earlier closeout's gate-failure blocker only; old failures remain historical. Existing settings browser19PASS and Worker1PASS; Next/CF buildsPASS; originalpreflight PASS exit0. Whole B013/B021 remains **pending**, awaiting PE's requested new-structure proposal review/plan entry/application and Ron notice, plus future fixed gateways/guards/feature tests and independent QA. Settings alone do not complete estimate version/decision/dispatch requirements.

Only B013/B021 and their existing gate repair were resumed by Ron. B010/B028 producer and B011 UI remain pending, B024 and other queue items are not started. No full B item newly `done`. See [current evidence](../e2e-evidence/B-013/gate-fix-f419aa6.json), [PE proposal](../e2e-evidence/B-013/b013-db-handoff.md), [blockers](BLOCKED.md#pe-gate-fix-resolution--2026-10-30).

## Autonomous resume 2026-10-30T12:28:36.879071-07:00

Ron activated continuous BUILD-ORDER execution: DBchanges are handed off in Downloads and onlydependentparts skipped; no prod/mainmerge/Macoperationalmigration/flagON. B013/B021 digest/settings candidate `fbda2a0cc9ce592907632410e0eeea343dbdb5d2` fullgatePASS599unit/357RLS0FAIL1historicalSKIP and read-only staging metadata verified. Full estimate/decision/enforcement scope remains pending DBhandoff, notdone. Nexteligible is B001 formal-org simulation boundary fromcanonicalCAP-M-01; implementation will preserve sandbox and existing normal signing. [Digest proof](../e2e-evidence/B-013/digest-fix-fbda2a0.json), [DB handoff](../e2e-evidence/B-013/b013-b021-remaining-db-handoff.md). No otherB began during audits.
## B-001 bounded local delta — 2026-10-30T13:34:59-07:00

Candidate `9fe0e4a9f29956a4de49b7c2e6ce6392eeaf9f5f` closes the formal/sandbox simulation application gap with local evidence: full gate599unit/358RLS PASS0FAIL1approvedhistoricalSKIP, Next/CF/preflight/Worker and12browserPASS. Tests preserve actual tenant/manager signing, positive/zero invoices and rollback; no schema or persistent flag change. Whole B-001 is `pending` because original G0–G5/§11.1, staging app/cold starts/receipt and independent Claude Class B acceptance remain incomplete. This is not whole-item done. Next eligible is B-002 reconciliation after publishing this checkpoint. B-013/B-021 read-only catalog recheck at13:22PT still shows settings only and flagsOFF; remaining DB handoff is unchanged. [B-001 evidence](../e2e-evidence/B-001/simulation-boundary-9fe0e4a.json).

## B-002 local HTTP/scheduler checkpoint — 2026-10-30T14:28:52.121390-07:00

Candidate `71acf06d7675e99ef83cf20c545a2c56d775ccf3` is locally verified: gate599unit/358RLS PASS0FAIL1approvedhistoricalSKIP, builds/original-preflight/Worker1 and serial HTTP/browser1 PASS. Existing actual-date UI/fixed90 policy reused; new route proof covers real positive JPEG, independent token/object/auth/environment denial and OFF/missing/invalid/dry_run preservation of2previewdocuments+1expiredslot. No product/schema/copy change. Whole B002 remains `pending` for approved rollback target/compatibility, staging and independent Claude/ClassB acceptance. Existing later-of-two dates has recovered reviewed attribution; prospective notice/intent stays B012 scope, not a new B002 policy blocker. [Evidence](../e2e-evidence/B-002/http-boundary-71acf06.json). Publish/mirror, then continue B003; no whole B newlydone or activation.

## B-003 local payee selection/isolation checkpoint — 2026-10-30T14:56:25.343433-07:00

Candidate `0fb7c15a3679d5338eafdab906571b5dc1814d1d` locally verified: clean gate599unit/358RLS PASS0FAIL1approvedhistoricalSKIP; builds/originalpreflight/Worker1 and fresh protected UI/HTTP3 PASS53.5s,10screens390/1280. Existing company/owner gateway reused; actual owner assignment, missing/legacy distinction, other-tenant and selectedsandbox->live denial plus ingress/audit proof added. Exact setting/orgflags restored; normal metadata/audits advance. No app/schema/legal change. WholeB003 `pending` approvedold-code/rollback, staging and independentClaude/ClassB acceptance, notdone/activated. [Evidence](../e2e-evidence/B-003/http-boundary-0fb7c15.json). Publish/mirror, continue B004.

## B-004 local paper-delivery checkpoint — 2026-10-30T15:22:12.689041-07:00

Candidate`ee734857cf04f75d84c5a01eb89d433b9e89bfae` locally verified: gate599unit/358RLS PASS0FAIL1approvedhistoricalSKIP; builds/originalpreflight/Worker1 and protected4browsercasesPASS49.8s,8screens390/1280. Existing app reused; version/history/staffscope/tenantprivateaudit/fault/OFF and newfakeIDs pass. Global originallymissing restored toabsence, orgflagsrestored/faultobjectsremoved; normal metadata/audits/uploads remain. [Evidence](../e2e-evidence/B-004/http-boundary-ee73485.json). WholeB004 pendingold-code/rollback/stage/Claude. Visualcheckconfirmedpre-existingB001 unconditional pendingheadingabove signedtimeline; [localfollowup](../e2e-evidence/B-001/signing-heading-followup-ee73485.md) is now earliest actionable item. Publish/mirrorB004 thenrevisitB001beforeB005. No blanketparentvisualPASS/wholeBdone/activation.

## B-001 heading follow-up locally verified — 2026-10-30T15:56:54.814861-07:00

Candidate `41c5b7ff3c3a730308d4e31f3b4508df7a650055` fixes the signed-state heading using the existing tenant status/key; no signing/financial/legal/schema change. Final full gate599unit/358RLS PASS0FAIL1prior-approved historicalSKIP, builds/originalpreflight/Worker1, private paper-browser4 and affected utility1 PASS. [Proof](../e2e-evidence/B-001/heading-checkpoint-41c5b7f.md). B004's local parent finding is resolved, while whole B001 remains `pending` for its separate external acceptance. No whole item newly done/activated. Publish/mirror, then resume B005 (`in_progress`); no waiting on the dependent staging/Claude scopes.

## B005 onboarding/report local checkpoint — 2026-10-30T16:11:51.580068-07:00

Candidate `591564f232adc4e8e192c5dc3f8e52463bbd83a8` passes final gate599unit/358RLS+1priorhistoricalSKIP, builds/originalpreflight/Worker1 and4privatebrowsercases36.5s,6screens390/1280. Existing actualaccepted/bound/resume/noneaudited flow and nonempty live/ownedSBreport HTML+CSV isolation verified; full controls restored/OFF. [Evidence](../e2e-evidence/B-005/checkpoint-591564f.md). B005 stays `in_progress`: independent default-OFF owner/tenant resend-result contract/UI/mock is still eligible and is next after publication/mirror. Durable attempts/gateway are PE-handoff-only; stage/Claude/unmarkedlegacydemo remain pending. No wholeB newlydone/activation.

## B005 preparatory resend checkpoint — 2026-10-30T16:32:51.873431-07:00

Candidate `a95c7e1c86788d60b2eab2cb9405f494816fb75d` locally verifies pure simulation contract/shared renderer:607unit/358RLS+1priorhistoricalSKIP, builds/preflight/Worker1/preview4 PASS. [Evidence](../e2e-evidence/B-005/resend-checkpoint-a95c7e1.md). Actual onboarding/report checkpoint remains591564f. B005 now `pending` for the PE-dependent durable gateways/schema/audit/UNKNOWN recovery and exact stage/Claude acceptance; closed source-reviewed handoff is in Downloads/condola-bootstrap/b005-db-handoff.md, unapplied and not executable. No real sender or activation. After publish/mirror, choose B006; its old mobile-wrap finding is already fixed, so reconcile and harden current real-import evidence rather than rewrite the parser. B006 remains ClassA.

## B006 ClassA local import checkpoint — 2026-10-30T16:49:08.418530-07:00

Candidate `9bbf04a300f073256bc9a7c887f3c6025b84c5ee` locally verified:607unit/358RLS+1priorhistoricalSKIP, builds/originalpreflight/Worker1 and actual regional browser2PASS18.1s with4screens390/1280. [Proof](../e2e-evidence/B-006/checkpoint-9bbf04a.md). Existing CSV/resubmission and rejection paths reused; no app/parser/schema change. Exact seeded-baseline restore/readback passes; two prior wrong-template probes retained. Whole B006 now `pending` for authorized customer sample/disposition and exact staging. ClassA independent Codex review applies, not a new ClassB gate. Publish/mirror, then B007 (ClassB) existing deposit matrix/control-restoration proof.

## B007 ClassB local deposit checkpoint — 2026-10-30T17:05:07.679937-07:00

Candidate `05369e484a353fad0364d6b435fdbda3590521e7` verifies existing8-case configured deposit matrix:607unit/358RLS+1priorhistoricalSKIP, builds/originalpreflight/Worker1/browser8PASS1.1m,16screens. [Evidence](../e2e-evidence/B-007/checkpoint-05369e4.md). Exact original present global row/orgflags restored/OFF; absent-initial branch source-only, last aggregate not the whole matrix. No app/rule/schema/legal change. B007 now `pending` for exact stage/catalog/app/roles, approved old-code/new-schema/OFF/rollback and ClaudeClassB; Ron namedCHECK exception already resolved. Publish/mirror then B008, whose first-invoice combined and read-only monthly planning gaps remain eligible; monthly execution is not claimed complete.

## B008 preview continuation — 2026-10-30T17:58:16.504496-07:00

Candidate `4b8228f995a29a56ac89bb86b4a8b2e7e12adfe8` adds shared first-invoice and supported read-only monthly rent previews.611unit/373RLS+1sole prior historicalSKIP, builds/originalpreflight/Worker1/browser6PASS52.1s/22screens, native independent scopedPASS. [Evidence](../e2e-evidence/B-008/checkpoint-4b8228f.md). Explicitmonth and mobileform findings resolved; controls exactly restoredOFF. **B008 stays in_progress**, notdone: monthlywriter/fullbillparity and exact staging/ClassB remain. DB research is nonexecutable/notapply-ready, not a blanketDBblock. Next eligible work remains withinB008: source-review the writer invariant and eligible non-writing scope before moving onward.

## Requested final stop — 2026-10-30T19:04:44.433953-07:00

All39IDs accounted for:0done/15partial-pending/24todo. No new B implementation started during closeout. B008rentdetail code `17ec9dfdd45c4a47807d0a251cbdff1840fe74c0` remains PARTIAL; user-requested cleanstandardgatePASS615unit/380RLS0FAIL1solepriorhistoricalSKIP. [Gate](../e2e-evidence/integration/closeout-1030-gate.md), [all item states](codex-handoff-1030.md), [inventory](../e2e-evidence/integration/closeout-1030-inventory.json). Samecodebuilds/preflight/Worker1/browser8/30PNGs alreadyPASS; initialpreliminarybrowsercauseUNKNOWN/unwaived. Actualmonthlywriter/fullbillparity and staging/Claude UNVERIFIED; newDBproposalunapplied. B008/B009/B015 changed fromin_progress topending because allworkstopped, not because accepted. Olderkeepworkinginstructions are historical; do not resume automatically.

## B009 local product checkpoint — 2026-11-02T10:50:03.207749-08:00

Code `0107baac619d3faee3f802f9a052aeb79bdbc84a` completes enabled-path historical suggestion basis with safeDTO/unavailable state, preserving humanmatching/auth/finance/OFF. [Evidence](../e2e-evidence/B-009/checkpoint-0107baa.md): standardgate618unit/380RLS+1solepriorhistoricalSKIP; builds/originalpreflight/Worker1/browser2/4screens PASS, independentSol scopedGO. Firstgate failed due existing month-boundary sampleownership inconsistency; reviewed synthetic date/precondition correction and freshgatePASS preserve report rules/assertions. Originalreadback exitNOT_CAPTURED and correctedobservationPASS bothretained. B009whole remains pendingrealfile/stage/owner/Claude; no newlywholeBdone. Next eligible actualproductwork B010/B028 payer center forconfirm/reject/reversal and manager/legacy/enhancedconfirm paths, independent center flag using existing checked-in schema. EmailpreferencepersistenceseparatePEhandoff; no blanketnewDBblock. Publish/mirror before sharedpath edits.

## B010/B028 real payment-center checkpoint — 2026-11-02T11:32:32.249854-08:00

Code `3c46882327ea85d3cc3be34758fca39226f2b507` locallyimplementsall6actualfinancialentrypoints→eligiblepayerexistingcenter, samecommit; independentcenterflag, originalfinancialRLS/math/roles/JWTpreserved. [Evidence](../e2e-evidence/B-010/payment-center-checkpoint-3c46882.md):618unit/390RLS+solepriorapprovedhistoricalSKIP,builds/originalpreflight/Worker1,center2+affectedbank2browser/6screens/readbackactual0,independent62bindingsGO. No newruntimeDDL. WholeB010/B028 remains pendingremainingfamilies/stage/Claude/Emailpreference+capture+provider; separateminimalpaymentEmailSQLproposal sourceGOONLYUNAPPLIED/NOTRUN inDownloads. Skiponlydependentparts; afterpublication/mirror nextB011source/recoveryreconciliation. No wholeBnewlyaccepted/no39MVPcompletion.

## B011 photo comparison local checkpoint — 2026-11-02T13:18:10.146031-08:00

Code `bb02a75d9440a20a067b9e6481a65b3a5bb78a83`:618unit/390RLS+one sole prior-approved historical skip, builds/originalpreflight/Worker1, final4browser32captures, independent exact control metadata/whole-org flags restoration all PASS. Separate Sol source/evidence review PASS. [Checkpoint](../e2e-evidence/B-011/comparison-checkpoint-bb02a75.md). B011 remains `pending`: settlement attribution/gateways/outcomes/old stream, exact staging and required independent acceptance remain incomplete. No whole B item newly done, no scope cut.

Closed settlement proposal in Downloads remains UNAPPLIED/NOTRUN/NOTAPPLYREADY. Codex still owns the minimal canonical attribution/fixed-gateway proposal; PE owns later nonMac validation/application. Approved specific manual deposit proof is not blocked by unknown remainder purpose; invoice allocations are not an additional cash use. Current photo feature is independent of that work.

After publication/mirror, next eligible bounded work is B012 comparison/linked-draft preparation. Hosted draft creation cannot rely solely on new TypeScript or flag OFF: old paper/e-sign code can activate drafts, so a narrow persistent hold guard/old-code evidence goes to PE and only that dependent writer stays parked. Keep all flags operationally OFF; no main/prod/Mac migrations or external messages.

## B012 current local work — 2026-11-02T13:53:29.354087-08:00

B012 in_progress: authorized actual-current-vs-unsaved-proposed lease terms comparison source-reviewed, local runtime NOT RUN. Persistent linked-draft guard proposal is unapplied/source-only; dependent writer parked for PE validation/application, no full B012 completion or staging acceptance claimed. Existing B011 photo comparison checkpoint remains valid for its immutable candidate. All39/four-party/fullLINE scope remains open.

## B012 local comparison checkpoint — 2026-11-02T14:21:46.495835-08:00

Code `9caeed8a4378f7eff932d65b1f332581113646cc`:621unit/392RLS+solepriorhistoricalskip, builds/originalpreflight/Worker1,final4browser28PNG,independentSELECT-only keyABSENCE/wholeflags/OFF restoration PASS. Sol independently verified195bindings/51pins/13receipts/2histories;root14+reviewer14visualGO withknownbadge/paired-scrolllimits. [Checkpoint](../e2e-evidence/B-012/renewal-checkpoint-9caeed8.md). WholeB012 remains pendingdurablelinkedcreate/history,partyversionedintents/notices,tenantcomparison,earlytermination/depositcarryforward andstaging/Claude/ClassB/Ron. Codex stillowns lifecycle/authorityproposals/appwork;PE ownsapprovednonMacvalidation/apply,notunfinishedCodexdesign. Persistentholdproposal sourceGOONLYUNAPPLIED/NOTRUN/NOTAPPLYREADY. No39itemnewlyfullyaccepted/noMVPscope cut. Publish/renew/mirrorthencontinueorderedeligiblework;B013/B021workflowDB-dependentpartsremainparked;B014existing-ledgerrecordingplanavailable.
