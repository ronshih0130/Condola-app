# Ordered build queue

Priority follows ROADMAP P1: finish existing flag-OFF work, then manager → tenant → owner → vendor → platform gaps, then complete three-portal LINE.

All statuses begin `todo`, including previously built items: their first action is evidence reconciliation, not automatic reimplementation.

All feature flags below default **OFF**. Names marked `*` are proposals; reconcile with the registry. Existing live behavior stays at its recorded setting. Testing a flag ON is permitted only in an isolated local/staging test organization.

| ID | Title | Story / journey / capability; inventory | Depends on | Flag, default OFF | Class | Size / hours | Status |
|---|---|---|---|---|---|---|---|---|
| B-001 | Finish e-sign integration and gates; activation: **Ron decides** | MGT-09/10, TEN-03; J2; CAP-P-09/10, CAP-T-01/08, CAP-M-01/19; T-04 | Existing paper fallback evidence | ESIGN_ENABLED | B | L / 24–40 | in_progress |
| B-002 | Finish MOVE_OUT and ID_PURGE; activation: **Ron decides** | MGT-20, TEN-02, PLT-04; J1.7/J6; CAP-M-13, CAP-P-02, CAP-T-06; M-67 | Existing errredact/privacy release evidence | MOVE_OUT_ENABLED; ID_PURGE_ENABLED | B | M / 16–24 | in_progress |
| B-003 | Finish payee details and full access audit; activation: **Ron decides** | MGT-04, TEN-06; J3.3; CAP-M-03, CAP-T-03; T-08 | Existing payee lane | PAYEE_DETAILS_ENABLED | B | M / 16–24 | in_progress |
| B-004 | Verify paper lease versions, tenant downloads and audit | MGT-10, TEN-03; J2.6/7; CAP-M-02, CAP-T-02 | — | PAPER_LEASE_VERSIONS_ENABLED; TENANT_SIGNED_PDF_ENABLED | B | S / 6–10 | in_progress |
| B-005 | Onboarding, invitations and resumable trial | MGT-01/02/03/28; J1; CAP-M-04/05/28; P-10 | — | TEAM_INVITES_ENABLED; ONBOARDING_PROGRESS* | B | M / 16–24 | in_progress |
| B-006 | Import error detail and regional source formats | MGT-05; J2.1; CAP-M-06 | — | IMPORT_ERROR_DETAILS* | A | S / 6–10 | in_progress |
| B-007 | Deposit rule hints and excess-reason audit | MGT-08; J2.3; CAP-M-07 | — | DEPOSIT_RULE_HINTS* | B | M / 12–20 | in_progress |
| B-008 | Billing, utility and statement amount previews | MGT-12/26; J3.1/J7; CAP-M-08/22; M-40 | — | BILLING_PREVIEWS* | B | M / 20–32 | in_progress |
| B-009 | Bank CSV dedupe and manual matching | MGT-14; J3.5; CAP-M-10/23 | — | BANK_MATCHING* | B | M / 16–24 | in_progress |
| B-010 | Rent reminders and payment review results | MGT-13/15, TEN-07; J3.2/6/7; CAP-M-09/11; M-70 reminder | —; delivery adapter contract in B-028 | RENT_EMAIL_REMINDERS*; PAYMENT_REVIEW_RESULTS* | B | M / 20–32 | in_progress |
| B-011 | Handover and deposit settlement, including bilateral replies | MGT-16/23/24, TEN-10/11; J4/J6.6–8; CAP-M-12/14/21, CAP-T-05/10; M-26 | B-002 | HANDOVER_RECORDS*; DEPOSIT_SETTLEMENT* | B | L / 40–64 | in_progress |
| B-012 | Renewal comparison and early-termination lifecycle | MGT-20/21/22, TEN-14–17; J6; CAP-M-13/20, CAP-T-11; M-25 | B-002, B-011 | LEASE_LIFECYCLE_RECORDS*; LEASE_RENEWAL* | B | L / 32–48 | todo |
| B-013 | Manager dispatch and shared repair approval state | MGT-17/18/19/35; J5; CAP-M-15/16; M-48/49 | —; coordinated B-021/B-024 | vendor_dispatch; REPAIR_APPROVALS* | B | L / 32–48 | todo |
| B-014 | Owner net ledger, transfers and report versions | MGT-25/26/27, OWN-02; J7; CAP-M-17/18, CAP-O-03; M-43 | B-008 | OWNER_NET_LEDGER*; MONTHLY_REPORT_DELIVERY* | B | L / 24–40 | todo |
| B-015 | Archive records and reuse/edit tenant identities | MGT-06/07; J2.1/3; CAP-M-26/27; M-11/14 | — | RECORD_ARCHIVE*; TENANT_DIRECTORY_EDIT* | B | M / 16–24 | todo |
| B-016 | Company/profile settings and management-fee rules | MGT-04; J1.1/J7; CAP-M-25/29; M-42/58 | B-003 | COMPANY_PROFILE_EDIT*; MANAGEMENT_FEE_RULES* | B | M / 20–32 | todo |
| B-017 | Custom role permissions with escalation protection | PLT-01/02; J1.4; CAP-P-12; M-54 | — | CUSTOM_ROLES* | B | L / 24–40 | todo |
| B-018 | Tenant payment history and home states | TEN-07/08; J3; CAP-T-04/09; T-09 | B-003, B-010 | TENANT_PAYMENT_HISTORY* | B | M / 12–20 | todo |
| B-019 | Tenant conversation creation | TEN-13; J5; CAP-T-12; T-15 | — | TENANT_THREAD_CREATE* | B | S / 6–10 | todo |
| B-020 | Tenant account, sessions, preferences and data requests | TEN-18; J1; CAP-T-13; T-16/17 | —; notification integration B-028 | TENANT_ACCOUNT_SETTINGS* | B | M / 16–24 | todo |
| B-021 | Owner thresholds and versioned repair decisions | OWN-12/13/06; J5.4; CAP-O-01/02/08; O-05 | B-013 | REPAIR_APPROVALS* | B | M / 16–24 | todo |
| B-022 | Owner transfers, receipt title and report replies | OWN-02/03/10; J5.7/J7; CAP-O-04/06/07; O-08 | B-014 | OWNER_RECEIPT_TITLE*; OWNER_REPORT_REPLIES* | B | M / 16–24 | todo |
| B-023 | Owner files, lifecycle replies, repairs, messages and settings | OWN-04/05/07/08/09; J1/J2/J5/J6; CAP-O-09/10/11; O-06/07/09/10/11 | B-001, B-011, B-012 | OWNER_PORTAL_EXTENSIONS* | B | L / 40–64 | todo |
| B-024 | Vendor accept/reject/schedule/completion UI | VEN-01/04/13; J5.2–6; CAP-V-01/02/03; V-01/02/03 | B-013, B-021 | vendor_dispatch; VENDOR_COMPLETION_REASON*; REPAIR_APPROVALS* | B | M / 20–32 | todo |
| B-025 | Vendor onboarding, fixed data, documents and trade fields | VEN-02/05/06/07/08/11/12; J1.8/J5.7; CAP-V-04/05/07/08/09; V-05–10 | B-022, B-024 | VENDOR_DOCUMENTS* | B | L / 40–64 | todo |
| B-026 | Vendor estimates, account/history and enhanced sharing | VEN-03/09, MGT-30; J1.8/J5; CAP-V-06/10/11, CAP-M-24; V-11/12/13 | B-013, B-024, B-025 | VENDOR_ACCOUNT*; VENDOR_ESTIMATES*; VENDOR_LINK_ENABLED | B | L / 32–48 | todo |
| B-027 | Platform isolation, partner consent and rollout controls | PLT-01/02/03/16; J1; CAP-P-01/03/05/06/07/09/12/16; M-68 | B-001–003 for relevant integration checks | PARTNER_CONSENT_GATE; PARTNER_PRICING_HIDE*; PARTNER_UNIT_OVERRIDE*; PARTNER_EA* | B | L / 32–48 | todo |
| B-028 | Event delivery results, reminders and four-app notification center | PLT-05/13; J1/J3/J5/J7; CAP-P-13/15/22; P-19, M-70 | — | EMAIL_DELIVERY_RESULTS*; NOTIFICATION_CENTER* | B | L / 32–48 | in_progress |
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
