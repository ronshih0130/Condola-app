# B017 full cross-base custom roles — primary plan v2

2026-11-03T12:40:58.963779-08:00; local HEAD `4f85ea033e87cd242c23123066cf2bb3ff69ec90`. **PRIMARY_V2_DESIGN_PROPOSAL_FOR_INDEPENDENT_ARCHITECTURAL_REVIEW; SQL_NOT_AUTHORED; NO_RUNTIME_OR_ACTIVATION_GO**.

## Fixed policy

Ron approved FULL supported cross-base composition by Admin. This supersedes the Astra-v1 base-ceiling recommendation and its proposed two-mode evaluator. One fixed policy only: an assigned native staff member has exactly the explicit supported template key set; do not intersect it with the target's old PERMS roles. An unassigned member has the current PERMS native behavior. The native persona remains immutable to that template and enforces mandatory Accountant protected-photo/ID restrictions, native-Admin-only full-company audit and governance, plus existing portal/company/environment boundaries. All eighteen catalog keys are eligible for cross-base grants, with each key's explicit operation semantics below; catalog labels never authorize unrelated APIs. No permission can create tenant/vendor/owner identity, platform-admin status or billing-owner powers. No independent review or runtime has run for this v2 plan.

## Current evaluation and native persona

Current lookup uses the validated cookie -> auth_sessions row -> current membership, selected live parent and selected environment. The service adapter validates the actual cookie hash; a session UUID or user ID supplied by a form is not a credential. The database verifier rechecks that session row, expiry/revocation, member ACTIVE/current native persona and selected-org/live-parent relation. Management is live-only; sandbox uses its live parent's effective assignment for previews, never independent role administration. Return readiness, member ID, native persona, explicit effective keys, template/assignment/state revisions and mandatory restrictions as a bounded request-local snapshot. Rendering may use that snapshot; each data projection and mutation must re-evaluate within its own transaction. No auth authority in cookies, submitted role values, writable GUCs, cached sidebar or stale Session.role. Keep canonical B016 confirmed Auth Email untouched. Current functions can/rolesFor remain native-matrix utilities; do not reinterpret rolesFor as a new authority source. Introduce explicit effective can/assert helpers and migrate actual consumers, so mixed native/effective calls are visible in review.

## Eighteen-key operation and bypass closure

Each entry names current source, exact proposed authority and its raw/API/file boundary. Proposed bridges are contracts for new fixed functions, not existing implemented objects. The final SQL/application package must close every row before all18/B017 acceptance.

### dash.view

- Actual routes: `/m`.
- Actual functions: `queries.dashboard`, `queries.counts`, `queries.loadManagerChrome`.
- Raw objects: `properties`, `units`, `rooms`, `leases`, `invoices`, `payments`, `maintenance_tickets`.
- Meaning: Org-level dashboard aggregates only; no contact phone, account numbers, raw journal or ticket photo in bootstrap HTML/badge payload. Minimal per-operation chrome counts must not restore forbidden datasets.
- Fixed bridge: app.b017_dashboard_read; source-bind exact dashboard DTO/aggregate SQL.
- Required floor: No automatic props.view/stmt.view grant; no hidden financial details beyond the deliberately advertised aggregate.

### props.view

- Actual routes: `/m/properties`, `/m/units`, `/m/tenants`, `/m/leases`, `/m/owners`, `/m/archive`, `/api/pdf/leases/[id]`, `/m/leases/[id]/signed/[pdfId]`.
- Actual functions: `queries.listProperties/searchProperties/propertyDetail/listOwners/listTenants/searchTenants/listLeases/searchLeases/leaseDetail/tenantDetail/listSpaces/searchSpaces`, `pdf-docs.canDownloadLeasePdf`, `pdf-download.leasePdfForSession`, `paper-lease-versions reads`, `record-archive.archiveView/archiveList`.
- Raw objects: `properties`, `property_owners`, `units`, `rooms`, `contacts`, `leases`, `lease_parties`, `lease_charges`, `listing_terms`, `lease_signatures`, `lease_signed_pdfs`, `files`.
- Meaning: Read portfolio/tenant/lease metadata and authorized lease documents, with phone_e164 omitted unless tenants.contact. Signed original PDFs may themselves contain contact/ID data: permission must not supply a less-protected binary escape.
- Fixed bridge: app.b017_portfolio_read; app.b017_lease_document_read returns safe file reference only after document-specific admission; byte route rechecks.
- Required floor: No ID document photo, no other org/sandbox, no owner-portal extra data. For a document containing restricted tenant phone use tenants.contact as additional admission rather than pretend redaction of immutable original PDF.

### props.edit

- Actual routes: `/m/properties/new`, `/m/properties/[id]/edit`, `/m/owners/[id]`, `/m/units/new`, `/m/units/room`, `/m/units/whole`, `/m/import`, `/api/import`, `/api/flows/createProperty`.
- Actual functions: `domain.createProperty/setMeterSerial`, `portfolio.createOwner/updateOwner/updateProperty/createSpace/updateSpace/seedPortfolio`, `import-batch.dryRunImport/previewImport/commitImportBatch`, `record-archive.archiveCommand property/unit/room; owner archive is separate unfinished B015 scope`.
- Raw objects: `properties`, `property_owners`, `units`, `rooms`, `contacts`, `meters`, `listing_terms`, `import_jobs`.
- Meaning: Create/edit portfolio and owner contact/space/meter data; property/unit/room archive/restore only existing approved ancestry/finance-warning semantics; owner-only archive remains unimplemented B015 dependent scope. Portfolio import which also commits an actual lease additionally requires leases.edit; preview may report that missing permission, never partially commit.
- Fixed bridge: app.b017_property_create/update; app.b017_owner_create/update; app.b017_space_create/update; app.b017_meter_set; app.b017_portfolio_import; app.b017_record_archive/restore (typed target only).
- Required floor: No custom authority over shared owner+tenant contact linkage, phone edits or ID records without actual corresponding operation admission; no creation of another identity to bypass archive.

### leases.edit

- Actual routes: `/m/leases/new`, `/m/leases/[id] write actions`, `/m/rent/utilities`, `/api/flows/createLease`, `/api/flows/updateLease`, `lease signing/upload/simulation and B002 move-out handlers`.
- Actual functions: `domain.createLease/updateLease/signLease/uploadSignedLeasePdf/simulateTenantSignature`, `deposit-rules-actions`, `b002-move-out-actions`, `renewal-comparison`, `actions.actionPrepareUtility/actionConfirmUtility/actionVoidUtility`.
- Raw objects: `leases`, `lease_parties`, `lease_charges`, `lease_signature_events`, `lease_signatures`, `invoices`, `invoice_lines`, `meter_readings`, `utility_bills`, `utility_allocation_runs`, `utility_allocation_lines`.
- Meaning: Lease lifecycle and existing utility prepare/confirm/void operations; preserve signs, rule overrides, exact original tenant/owner attribution and feature gates. Staff signing can only exercise existing staff authority, never sign for a tenant.
- Fixed bridge: app.b017_lease_create/update/sign/upload/simulate; app.b017_move_out; app.b017_deposit_override; app.b017_utility_prepare/confirm/void. Existing unpublished DB-dependent lifecycle operations remain explicitly unavailable.
- Required floor: No new settlement, e-sign activation, protected ID-photo entitlement or tenant consent. Original document immutable; data/photo floor survives.

### tenants.contact

- Actual routes: `/m/tenants`, `/m/leases/[id]`, `related ticket/contact selectors`, `/api/export/all filtered contacts`.
- Actual functions: `queries.leaseDetail phone CASE`, `queries.listTenants/searchTenants/tenantDetail`, `owner_lease_tenants definer view`, `queries phone projections`.
- Raw objects: `contacts`, `listing_terms`, `profiles`, `owner_lease_tenants`, `tenant_lease_picker`.
- Meaning: See tenant phone numbers within actual permitted staff record/context; does not grant tenant-directory mutation or all member profiles. Full raw contacts are not an acceptable fallback because they include email, notes, bank suffixes and multiple personas.
- Fixed bridge: app.b017_tenant_phone_read fixed bounded projection; optional phone fields in other fixed readers use the same current evaluator.
- Required floor: Remove app.is_member shortcut in owner_lease_tenants phone CASE for enrolled custom staff; genuine nonstaff owner privacy rule remains unchanged. Staff-first persona cannot route around key via own-owner view.

### pay.record

- Actual routes: `/m/payments`, `/api/flows/recordPayment`, `/api/flows/confirmPayment`, `/api/flows/rejectPayment`.
- Actual functions: `domain.recordPayment/confirmPayment/rejectPayment`, `payment-center-events`, `payment-result-events`, `payment-request-status`.
- Raw objects: `payments`, `payment_allocations`, `invoices`, `invoice_lines`, `ledger_transactions`, `ledger_entries`, `app.b028_center_events / app.b028_center_recipients`, `app.b010_payment_commands / app.b010_source_events / app.b010_payment_contexts`.
- Meaning: Record staff payment; confirm/reject submitted report with existing exact allocation, posting, payer/audit and center/result semantics. Tenant own submitted report is a separate unchanged portal operation.
- Fixed bridge: app.b017_payment_record/confirm/reject; preserve existing B010/B028 functions and same transaction/order; replace their current role-list checks with operation-specific verified authority for enrolled actors.
- Required floor: No reversal, arbitrary payment status edit, money movement, bank auto-match or disclosure of other payer/private reason. All financial asserts remain.

### pay.reverse

- Actual routes: `/m/payments reverse action`, `domain.reversePayment caller paths`.
- Actual functions: `domain.reversePayment`, `public.post_reversal(two and three argument overloads)`, `payment-center-events reversal`, `payment-result-events reversal`.
- Raw objects: `payments`, `payment_allocations`, `ledger_transactions`, `ledger_entries`, `invoices`, `audit_log`, `B018 private public-reason companion if later installed`.
- Meaning: Reverse an eligible actual confirmed payment using original business locks and exact journal opposition. Not a generic arbitrary journal reversal API. Manager assigned pay.reverse must succeed through this exact path, not be rejected by old admin/accountant lists.
- Fixed bridge: app.b017_payment_reverse with explicit payment ID/request/reason; scoped post_reversal admission validates canonical payment and preserves B018 sealed public-reason gateway if enrolled.
- Required floor: Private journal reason never projected as tenant reason; do not bypass B018 source-bound invariant. No arbitrary invoice retarget via three-argument overload, no portal reversal.

### bank.reconcile

- Actual routes: `/m/bank`, `/api/bank/matching`, `/api/flows/importBankCsv`, `/api/flows/approveMatch`.
- Actual functions: `bank-matching.authorize/bankMatchingEnabled/bankBoard/importBankFile/decideBankMatch`, `domain.importBankCsv/approveMatch`, `bank-match-basis`.
- Raw objects: `bank_accounts`, `bank_csv_mappings`, `bank_statement_imports`, `bank_transactions`, `bank_match_suggestions`, `payments`, `payment_allocations`, `ledger_transactions`, `ledger_entries`, `app.b009_file_imports`, `app.b009_decisions`, `files`.
- Meaning: Bank board/import/dedupe/manual match/reject, including existing match-to-submitted-payment confirmation as part of bank.reconcile. This declared composite operation does not implicitly grant general pay.record. No automatic matching or changed math.
- Fixed bridge: app.b017_bank_board/import/decide; replace BOTH TS role check and owner-query SQL admin/accountant list with verified current bank.reconcile; preserve B009/B010/B028 concurrency and feature flags.
- Required floor: Ron explicit Manager bank-reconcile positive is required. Bank account full-payee detail remains B003 gateway-bound; bank.reconcile is not company account editor.

### stmt.view

- Actual routes: `/m/rent`, `/m/statements`, `/m/statements/preview`, `/api/pdf/statements/[id]`.
- Actual functions: `queries.listStatements/statementRoster/rentRoll/statementDetail/statementPdfSource`, `statement-preview.statementPreview`, `utility-reconciliation`, `pdf-docs.canDownloadStatementPdf`, `pdf-download.statementPdfForSession`.
- Raw objects: `owner_statements`, `owner_statement_lines`, `invoices`, `payments`, `payment_allocations`, `expenses`, `management_agreements`, `fee_rules`, `ledger_entries`.
- Meaning: Read statement/rent-roll and read-only amount preview through existing financial calculation. Includes bounded source details needed to explain this statement, not unrestricted raw ledger/audit.
- Fixed bridge: app.b017_statement_read/preview/document_read, exact DTO and read-only snapshot.
- Required floor: No generate/issue/month close, no phone unless contact key, no admin audit/private identity document; owner projection stays own issued statements.

### stmt.generate

- Actual routes: `/m/statements generate`, `/api/flows/generateStatement`.
- Actual functions: `domain.generateStatement/linkStatementInvoices`, `statement-calculation.calculateStatement`, `statement-preview`.
- Raw objects: `owner_statements`, `owner_statement_lines`, `invoices`, `payments`, `payment_allocations`, `expenses`, `management_agreements`, `fee_rules`.
- Meaning: Generate/issue statement with canonical amount/fee/rule snapshot, source fingerprint and invoice linkage; minimal owner/month selectors and preview for this command are included without broad stmt.view list.
- Fixed bridge: app.b017_statement_generate; source-port unchanged algorithm and fingerprint/multi-currency/idempotence.
- Required floor: No month close or arbitrary payouts; unresolved B014 report/payout expansion remains outside completed B017 evidence.

### exp.add

- Actual routes: `/m/expenses`, `/m/statements expense form`, `/m/tickets/[id] expense subcommand`.
- Actual functions: `expenses.expenseFormOptions/listExpenses/getExpense/createExpense/updateExpense/voidExpense/approveExpense/addExpense`, `repairs.saveRepairRecord`, `vendor-repair.confirmVendorCost`.
- Raw objects: `expenses`, `ledger_transactions`, `ledger_entries`, `maintenance_tickets`, `files`.
- Meaning: Existing expense create/edit/approve/void workflows with current amount/source/closed-month invariants; expense-only form/read lists are included as current catalog behavior. Repair-linked expense posting needs tickets.update AND exp.add.
- Fixed bridge: app.b017_expense_create/update/approve/void; ticket expense path uses same private implementation after conjunctive admission.
- Required floor: No tickets.update or protected photos via expense attachment/cost details; reject caller-injected ticket link changes outside approved repair command.

### month.close

- Actual routes: `/m/close`, `/m/statements owner transfer actions`.
- Actual functions: `domain.closeMonth`, `owner-transfers.ownerTransferView/recordOwnerTransfer/reverseOwnerTransfer`, `owner-transfer-period-lock`.
- Raw objects: `month_closes`, `ledger_transactions`, `ledger_entries`, `owner_statements`, `invoices`.
- Meaning: Existing period close and current manual owner transfer/reversal/history operation bound to month.close; preserve typed ledger and scoped origin checks. Current transfers are ledger records identified by source_table, not an owner_transfers table. It records a human-reported transfer, does not initiate actual bank transfer.
- Fixed bridge: app.b017_month_close; app.b017_owner_transfer_read/record/reverse; preserve B014 source/security and future seal contract rather than manufacture seal readiness.
- Required floor: No actual money movement, no arbitrary balance repair; no assumption B014 current advisory lock closes hosted legacy race.

### tickets.update

- Actual routes: `/m/tickets`, `/m/tickets/[id]`, `/api/flows/createTicket/updateTicket`, `/api/tickets/photos/sign/confirm/[id]`, `staff vendor-dispatch actions`.
- Actual functions: `domain.createTicket/updateTicket`, `repairs.saveRepairRecord/addTicketComment/repairPhotoTarget/attachRepairPhoto/readRepairPhoto`, `ticket-photos.prepareTicketPhotoUpload/confirmTicketPhoto/openTicketPhoto/signTicketPhotoUrls`, `vendor-repair.addVendor/dispatchVendor/revokeVendorJob/approveVendorSharing/confirmVendorCost`, `vendor-onboarding staff paths`.
- Raw objects: `maintenance_tickets`, `ticket_comments`, `ticket_attachments`, `files`, `expenses`, `repair_vendor_jobs`, `vendor sharing/onboarding private objects`.
- Meaning: Ticket create/update/schedule/comment/vendor dispatch and attachment operation under current flags/scope. Accountant may manage supported text/status with this grant but protected photo metadata/signing/upload/view/bytes remain denied. Cost posting additionally exp.add.
- Fixed bridge: app.b017_ticket_create/update/comment; app.b017_vendor_add/dispatch/revoke/share; app.b017_ticket_photo_prepare/confirm/read only after mandatory base floor; new staff photo byte proxy.
- Required floor: Photo signing helpers cannot accept unreviewed arbitrary paths. Tenant/vendor own-ticket/token scopes remain separate; no custom entitlement can become portal identity or enlarge vendor token scope.

### messages.send

- Actual routes: `/m/messages`, `/api/flows/postMessage`.
- Actual functions: `queries.listThreads/threadMessages`, `domain.postMessage`, `message attachment readers`.
- Raw objects: `message_threads`, `thread_participants`, `messages`, `message_attachments`, `files`.
- Meaning: Read allowed staff threads and send message within same org/current thread rules; no arbitrary contact/recipient or external Email/LINE delivery. New browser/mock tests capture locally.
- Fixed bridge: app.b017_message_threads/read/send/attachment_read with exact typed thread/message IDs.
- Required floor: Do not use read access to bypass tenants.contact via structured phone fields; existing free text is not a new automatic structured-data entitlement. Preserve participant/portal and internal message boundaries.

### reports.export

- Actual routes: `/m/reports`, `/m/reports/export`.
- Actual functions: `income-expense.loadIncomeExpense/reportCsv`, `src/app/m/reports/export/route.ts`.
- Raw objects: `properties`, `property_owners`, `contacts`, `payments`, `payment_allocations`, `expenses`, `ledger_transactions`, `ledger_entries`, `owner_statements`.
- Meaning: Existing period/property/owner income-expense report view and CSV export; same scoped calculation and field list. No broad data export, private journal notes or audit snapshots.
- Fixed bridge: app.b017_income_expense_read/export (same result contract); route current can(session.role) replaced with effective read.
- Required floor: Keep min/max date constraints, archived/history semantics, org/env and read-only financial snapshot; tenant phone absent unless separately approved exact field.

### team.manage

- Actual routes: `/m/team`, `/m/roles assignment/editor only for baseAdmin`, `team invitation/member actions`.
- Actual functions: `auth.inviteMember/resendInvite/revokeInvite/setMemberRole/setMemberActive/acceptTeamInvite`, `auth-actions`, `domain.inviteTeammate`, `queries.listTeam`.
- Raw objects: `org_members`, `invitations`, `auth_sessions`, `app.b017_roles`, `app.b017_assignments`, `app.b017_commands`, `app.b017_org_state`.
- Meaning: All supported staff personas may receive team.manage for member directory/invite/resend/revoke/nonself native nonAdmin role/status changes within actor resulting-grant ceiling. Custom role CRUD/assignment and native Admin governance remain baseAdmin AND team.manage because they confer recovery/audit/persona authority beyond catalog. No self role/status change.
- Fixed bridge: app.b017_team_invite/resend/revoke/set_role/set_status/accept; app.b017_role_create/edit/retire/assign/unassign; explicit signatures and invariant below.
- Required floor: Cannot create/demote/suspend/remove native Admin or alter billing owner as a nonAdmin. Only baseAdmin can confer native Admin implicit authority; template named Admin has none. Last usable Admin invariant and current inviter revalidation apply.

### settings.edit

- Actual routes: `/m/settings`, `/m/notify`, `/m/roles existing owner privacy form`, `current org settings portions of /m/account`.
- Actual functions: `auth.setRequireMfa/setOwnerPrivacy`, `domain.setOwnerPhoneVisibility`, `mail-settings.saveOrgMailSettings`, `settings/edit guards on current account view`.
- Raw objects: `organizations`, `jurisdiction_rules org overrides`, `reminder_rules`, `mail_preferences/settings private objects`, `property_owners`.
- Meaning: Existing company rules/notification/owner-portal privacy/require-MFA settings only. May be granted cross-base; does not mutate global platform flags, role definitions, billing owner, own password/verified Email or fees policy not yet approved. Self account preferences keep independent existing self authority.
- Fixed bridge: app.b017_settings_rules/mail/privacy/mfa; call each existing fixed domain validation and require actual current key.
- Required floor: Do not expose other users MFA secrets, provider keys, private org audit or B016 unfinished company/Email/fee writers; no external messages or legal text.

### data.export

- Actual routes: `existing /api/export properties.csv`, `proposed /api/export/all`.
- Actual functions: `src/app/api/export/route.ts currently staff+consent only`, `queries.listProperties`, `No actual full-data export consumer exists in current source`.
- Raw objects: `all explicit authorized domain projection collections; files only via reauthorized per-file reader`.
- Meaning: This key is currently a real implementation gap. Deliver finite all-authorized-data export package, not database dump: explicit collection/field manifest for portfolio/leases/contact fields/payments/bank/statements/expenses/tickets/messages/team/settings as permitted by current corresponding read/action key; authorized document/photo bytes only under original mandatory floors. Include omitted/redacted collection reasons and snapshot/currency/source metadata. data.export is export ability, not a bypass to all other read permissions.
- Fixed bridge: app.b017_export_manifest plus exact existing per-domain read projections; /api/export/all streams an authorized package; /api/export assigned branch requires data.export+props.view, unassigned old route unchanged.
- Required floor: Never export auth/session/invitation secrets, raw private command payloads, identity photos, whole-company audit, unapproved tenant reversal internal reasons, provider credentials or raw bank private fields. Accountant protected photo denial survives. Do not call property-only CSV “all data”; until this package exists do not claim all18 supported-complete.


## Minimal durable schema

Minimal coherent persistence is FOUR private app tables, not just two nullable identity fields. (1) app.b017_org_state(live_org_id PK/FK, enforcement_state 'prepared'|'enforced', schema_contract integer, authority_revision bigint, enrolled_at nullable, created_at/updated_at): once enforced it never downgrades through user/admin flags; no ordinary DELETE or unenrollment. It is the durable fail-closed fence, not an activation flag. (2) app.b017_roles(org_id,role_id UUID, display_name bounded, name_key canonical, keys text[] sorted/unique/known <=18, revision bigint positive, lifecycle 'draft'|'active'|'retired', created_by/updated_by, timestamps; PK(org_id,role_id), UNIQUE(org_id,name_key)); no base-role ceiling column. PostgreSQL canonical name rule: trimmed/collapsed whitespace, documented lower-case comparison; reject empty/control/invisible/builtin-impersonating names. Client display normalization is not uniqueness authority. A checked known-key predicate binds the exact current PERMS catalog and schema contract; independent source parity check prevents two divergent catalogs. (3) app.b017_assignments(org_id,member_id,role_id nullable, revision bigint, assigned_by, updated_at): PK(org_id,member_id), composite FKs to org_members(org_id,id) and roles(org_id,role_id). Retain rows as unassignment tombstones with role_id NULL; never DELETE to restore base access. Inactive/removed members keep their assignment; reactivation rechecks it, never implicitly clears it. (4) app.b017_commands(org_id,actor_member_id,request_id,operation,target_id,payload_sha256,expected_revisions/result_revisions JSONB,result_identity JSONB,committed_at): unique(org_id,actor_member_id,request_id), immutable committed intent/receipt, bounded metadata only, no display names, email, permission-bearing free-text or cookies. A failed transaction leaves no success receipt. Same request/different operation/target/payload/revisions is conflict. Exact receipt does not bypass current reader authorization after revocation; return authorized committed identity or unavailable. Existing private audit_log gets one metadata event in the SAME transaction, not writeAudit after independent commit. Private role command rows are not a general request engine and are used only for role/member authority changes. No backfill to existing assignments, no ON DELETE CASCADE restoring privileges. Ordinary retirement requires zero active references; referenced retired/damaged role denies, never base fallback. Destructive org reset is maintenance-only with actual nonMac reset/retention evidence; private receipt/audit retention must be reconciled with existing org purge rather than invent permanent PII storage.


## Fixed authority commands

Fixed role APIs only: b017_role_create(session,org,request,payloadDigest,name,keys); b017_role_edit(...role,expectedRoleRevision,name,keys); b017_role_retire(...role,expectedRoleRevision); b017_role_assign(...member,expectedMemberTuple,expectedAssignmentRevision,role,expectedRoleRevision); b017_role_unassign(...member,expectedMemberTuple,expectedAssignmentRevision); b017_role_command_status(...request,payloadDigest); bounded role/member-list/read-self projections. No caller-selected SQL, dynamic function name, arbitrary permission string, SET ROLE instruction or generic mutate(table,fields). Derive actor from the verified current session; any actor input is only compared to that identity. Creation cannot return an active grant before contract readiness. Assignment and edits require all keys in actor's current effective set and fully implemented support manifest. Unassignment/native-role change checks the FULL RESULTING native/default set and implicit governance/photo consequences, not merely old or added key difference. Only native Admin + current team.manage can create/edit/retire/assign/unassign custom roles. team.manage delegated to a nonAdmin remains meaningful for ordinary member management while not conferring the implicit Admin-only audit/recovery authority. A native Admin custom template may omit team.manage only if another active native Admin retains usable role administration. No own assignment/template permission edit, native role/status change or indirect assigned-template edit that changes own authority; exact no-op is permitted after fresh authorization, metadata-only renaming may proceed. No emergency recovery superuser is invented.


## Concurrency, revocation and last usable Admin

Every enrolled authority mutation has one transaction and an explicit order: existing global rollout-control fence (platform_settings SHARE where the existing domain requires it), live organizations row FOR UPDATE (seat changes already lock this row), selected sandbox org if any in deterministic ID order, b017_org_state FOR UPDATE, affected member rows ordered by immutable member ID, affected role rows ordered by role ID, assignment rows, command receipt, then existing domain rows. Reads/financial writes acquire the authority rows in FOR SHARE before domain locks and retain them to COMMIT, so a template revoke cannot commit between admission and posting. Revalidate after waits. READ COMMITTED re-reads or verified serializable equivalent; no stale REPEATABLE READ assumption. A direct writer with inverse lock order must fail promptly via bounded NOWAIT/lock timeout; deadlock/serialization failures return unavailable/stale, never authorization success or blind retry. Prevalidate own actor membership/session/consent health and hold a share lock on the canonical session row so session revocation serializes; other existing session/consent/member revokers must participate or trigger equivalent final validation. Role edit evaluates ALL active assignees and actor grant ceiling under the same org lock; it is not a cosmetic template update. Compute post-state recoverability before mutation and again with a deferred constraint: >=1 active native Admin with effective team.manage and valid role/assignment contract. Preserve is_billing_owner -> native admin check and existing one-owner index, without inventing an always-active owner. Deny removal/suspension of the last usable Admin, including two concurrent admins demoting each other. Membership INSERT/UPDATE/DELETE, role/status/billing-owner changes, assignment edits and role-key changes all schedule the same invariant. Deleting a referenced member/role or editing its org is denied in ordinary runtime. Maintenance/bootstrap/reset is a separate trusted offline path, not a caller GUC exception.


## Membership and invitation writers

Convert inviteMember/resendInvite/revokeInvite/setMemberRole/setMemberActive and acceptTeamInvite to fixed enrolled-org gateways with SAME transaction audit. Existing TS source currently separates last-admin SELECT, UPDATE and audit; that is inadequate. Native Admin promotion/demotion/removal and billing-owner changes require native Admin, not delegated team.manage alone, because native Admin carries full-company audit outside the eighteen keys. Ordinary nonAdmin member operations may be delegated, but cannot act on self, cannot grant any resulting key or implicit protected capability the actor lacks, cannot strip another user's mandatory persona floor by a disguised role change, and cannot change template/member association behind expected revisions. Pending team invitations carry immutable native role and actual invited_by; at acceptance revalidate the inviter is current/active and can still grant the full resulting native set. Old pending invitations are not grandfathered if authority was revoked. An existing inactive member with a custom assignment retains it through acceptance/reactivation, and the expected assignment/native-role consequence is validated; no UPDATE role/status that silently clears authority. New org bootstrap creates its first native Admin before enforcement via its already trusted creation path; once state is enforced no frontend can invoke bootstrap to escape last-admin protection. Preserve seats, current team-invite allowlist, real user acceptance/password/consent requirements and no automatic sends.


## Raw SQL, RLS, owner and old-writer closure

Do NOT globally redefine app.is_member/app.has_role: their role arrays encode different operations and portal scope, and many later policies/functions depend on them. For assigned staff in an enforced live org or its linked sandbox, direct authenticated staff SELECT on covered domain tables is denied by named restrictive policies; authorized app reads use fixed safe projection functions. This deliberately prevents phone/notes/account/photo leakage through a broad row read. Preserve genuine unassigned/nonstaff portal predicates and their original own-record rules; an assigned staff-first person cannot claim portal authority in that same org to regain denied staff data. A person who is genuinely nonstaff in another org keeps that org's existing portal rights. Update owner_lease_tenants and every other SECURITY DEFINER view/function shortcut (notably phone CASE app.is_member) to use the same staff-versus-genuine-portal decision. Cover raw profiles_teammates phone and listing_terms tenant_phone, not only contacts. Public JWT role/GUC cannot establish gateway admission.
For enforced orgs, ordinary authenticated/service direct STAFF mutation of covered domain tables is rejected; allowed staff operations go through the exact fixed bridges in the key matrix, including unassigned native members in that enrolled org. Genuine existing tenant submitted-payment/ticket/comment and owner/vendor scoped flows remain their exact separate operations, never a staff escape; keep their existing row-shape checks. Each bridge reuses/ports the actual existing command body and calls a private authority checker, not arbitrary DML. Native/unassigned behavior in unenrolled orgs stays byte-equivalent under default-OFF, while new last-admin transaction fixes are separately regression tested. Direct org_members authority writes are denied once enforced, including deletion/cascade escape. New guarded functions must replace or fence current SECURITY DEFINER/owner-executed legacy entrypoints (post_reversal overloads, statement/utility writers, B003/B007/B009/B010/B014/etc). A role with a read key cannot use generic table INSERT/UPDATE to manufacture a journal, post expenses or reclassify a payment. Multi-key operations explicitly require conjunction; bank-match confirmation is the documented bank.reconcile composite, not general pay.record inheritance.
The fixed gateway owner is a dedicated NOLOGIN, non-superuser role with only enumerated object privileges; no membership in it is granted to anon/authenticated/service_role or an end-user-switchable role. Functions use fully qualified objects, pg_catalog-only safe search_path, explicit revokes, bounded inputs, no dynamic SQL from payload, and no PUBLIC/default EXECUTE. The trusted backend caller gets only exact fixed-function EXECUTE; current-user identity of a gateway must be distinguishable from caller identity in guard functions, which themselves cannot accidentally SECURITY DEFINER-switch before checking it. Ordinary row-level triggers are not permission secrets. Actual application pool role/owner/BYPASSRLS and service-role reachability are TARGET_UNVERIFIED. If the current pool is table owner/BYPASSRLS, protected credentials plus current application checks are a trust boundary, not proof an old worker is fenced. First enrollment requires an attested old-worker/old-credential fence and protected new function ACL; no assignment before that. Do not claim RLS constrains a DB owner. PE verifies/establishes the actual caller and NOLOGIN owner roles on nonMac; Codex supplies their exact SQL/grant manifest and adapter code.


Identity assumption: Supabase authenticated must be NOLOGIN and reachable only through its verified-JWT broker. A raw test pins the actual subject; caller-writable request.jwt.claim.sub is not a credential. Fixed gateways deny untrusted callers even with forged GUCs. If target permits end users arbitrary SQL as authenticated/owner, caller binding is a concrete security blocker; auth.uid alone is insufficient.

## Field and projection contract

Safe read families are explicit fixed projections, not SELECT *: dashboard; portfolio+lease metadata; tenant phone; payments/payer status; bank board; statement/preview; expenses; ticket text/status; authorized photo/file metadata+bytes; messages/attachments; team; org settings; income-expense report; export manifest. Each field has source object, key/mandatory floor and portal rule in the implementation manifest. Reuse current source DTOs but remove hidden privileged fields before serialization, including HTML/server-component payload and cache. For props.view without tenants.contact, omit phone in structured queries and deny immutable PDF/download objects whose known content includes restricted phone; do not promise PDF content redaction without actually implementing it. Edit commands may accept user-submitted phone fields to complete an existing typed workflow, but readback still obeys contact visibility; no broad phone list is inferred from edit. Minimal selectors required by a command are scoped to that command and expose only label/ID/currency/date/status needed to operate; a bank key need not grant general property or contacts navigation. Accountants get necessary finance DTOs with tickets.update text operations allowed when granted, while every protected photo metadata/path/upload/sign/read/bytes operation checks the mandatory native floor independently.


## Attachment and signed-link revocation

Current ticket GET redirects to storage signed URL; signTicketPhotoUrls issues 600-second URLs. A fresh permission check at issuance does not revoke an already issued URL. For enrolled staff use a server byte proxy (reuse downloadRepairObject), private/no-store/nosniff, with current key/persona/session/org/ticket check on every GET; never emit raw signed storage URLs in DTOs or HTML. Preserve existing MIME/path/magic-byte/upload-grant checks, sizes and tenant/vendor exact scopes. Before first assignment fence old signed-URL issuance, wait >=600 seconds from verified last issuance (or revoke the storage capability through an independently proven mechanism), then enroll; previously downloaded bytes cannot be revoked and are not claimed erased. Native role changes within an enforced org then have no newly minted external staff bearer URL bypass. Signed lease/PDF/other attachments need their existing expiry/revocation semantics and mandatory audience check; an export must fetch bytes through the same authorization, not package privileged raw storage paths.


## Default-OFF rollout and sticky enforcement

CUSTOM_ROLES management control is strict global enabled + allowed org + selected-org opt-in; absent/malformed/missing schema means no new role management. It NEVER chooses permission policy. Prior to any enrollment, new additive objects have zero assigned grants, new app exact legacy native matrix/flags/portal behavior is proven against old and new schema. Then deploy all projection/admission/legacy guards and immutable support manifest while management OFF; prove all eighteen supported operations and mandatory restrictions in disposable/nonMac staging. PE attests target roles/ACL/FORCE RLS/default ACL/dependencies/migration history, old-worker and credential fence, backup/restore, row counts and rollback/quarantine. Only separate Ron/QA activation can move one allowed org to enforced and create assignments. No operational activation here.
Once enforced or an assignment row exists, guard enforcement is STICKY and independent of management OFF/global kill/expired flag; kill blocks new management and can deny affected operations, never restores native base keys. If contract/tables/lookup/readiness unavailable, deny affected org access with honest unavailable; no absent-table fallback for a configured/enrolled org. Pre-enrollment old-code/new-schema compatibility is required. Post-enrollment rollback to base-only code is prohibited unless a verified deny/quarantine bridge runs first; never delete assignments or unenroll to make rollback work. Revoke/fence old credentials/workers before granting, not after. SQL down migration is not an ordinary rollback. Each template/assignment mutation increments authority revision; request-local snapshots only, no cross-request permission cache until invalidation is separately proved. No secrets/new production keys/Mac parser/migrations/flag activation are authorized.


## Exact catalog and privilege package

The proposed SQL package must enumerate four private tables/constraints/indexes, exact NOLOGIN owner and exact caller EXECUTE ACLs, private fixed verifier/projections/domain gateways, org/member/role/assignment invariant triggers, covered-table restrictive policies, explicit modifications/revokes for every legacy definer/public RPC and owner-view bypass, and current function allowlist/default-ACL changes. It is NOT additive-only merely because table shapes are additive: policy/privilege changes must be classified accurately and reviewed. Do not blanket revoke table privileges from unassigned legacy orgs or claim column REVOKE overrides table-level SELECT/UPDATE. Capture pg_class owner/relrowsecurity/relforcerowsecurity, pg_roles rolsuper/rolbypassrls/inheritance, pg_auth_members, table+column ACLs, schema/default ACLs, pg_proc owner/security-definer/search_path/ACL and current view definitions; none are live-verified in this plan. SQL expected source object list is pinned from current repo, actual target reconciliation is PE work after Codex exact package is authored. NonMac parse/replay on clean and supported upgrade states plus existing old-code/OFF, assigned raw denial/allowed fixed RPC, reset/restore/rollback tests are mandatory. No new migration SQL is authored by this planning task.


## Bounded implementation order

Sequential implementation order: (1) independent architectural review of this single approved policy and exact data/export/team semantics; (2) author disconnected pure rules from existing PERMS plus focused matrix tests, with NO provisional ceiling modes; root reserves paths first and owns flags/package/docs; (3) author complete inactive proposed SQL + MD + support/ACL/field manifest under current writable workspace, with exact function bodies and domain algorithm parity, no Mac parse/apply; source-only independent review before PE target work; (4) add effective resolver, named projection and fixed command adapters and role/member UI, updating actual routes/actions/files plus all bypass manifests in reserved bounded rounds; leave source-overlapping B016/B018 paths to root serialization; (5) execute only currently authorized old approved local fixtures until PE approved nonMac proposed-schema results exist; then exact candidate full gate/build/browser/staging and required independent Claude/Class B/Ron acceptance; (6) publish/mirror/handoff only under root authorization and stop without starting B019+. A pure evaluator or two-table foundation is partial, never all18/B017 done. This plan itself grants no source reservation, runtime permission or target authority.


## Acceptance matrix

For EACH of eighteen keys: unassigned native positive/negative compatibility; assigned explicit allowed outside native base positive (Manager bank reconcile mandatory); assigned key absent negative; permitted minimal selector vs forbidden broad list; page/nav/form/server action/API; named fixed RPC positive; ordinary authenticated raw table/RPC deny; service-only foreign session/forged actor/key/role/GUC deny; no hidden response/HTML/cache/file leak. Include shared key combinations: ticket+expense both required; bank reconciliation confirmation allowed only within exact match command; settings not role management; data.export not phone/photo/audit escape. All four native staff personas, identical user in another company, active/suspended/removed, revoked/expired session, live/sandbox, actual tenant/owner/vendor/anonymous and same-user staff-first persona cases.
Adversarial authority cases: two admins simultaneous demote/suspend, template changes affecting self/last usable Admin, concurrent actor revoke vs financial commit, stale session/native role/assignment revisions, bulk edit all assignees, duplicate keys/unknown catalog, same request changed payload, lost response exact replay after subsequent edit, retire referenced role, FK/missing role/missing schema/global kill, delete membership/assignment, base promotion granting implicit Admin/photo entitlement, old invitation acceptance after inviter revoke, seat races, inherited role/owner/RLS bypass, SET ROLE/GUC forgery, direct raw insert/update/delete/cascade, and old Worker + old credentials after enrollment.
Record full original failures, audit transaction rollback, exact key absence/present metadata/org flags restoration, no old assertion relaxation, EN/zh-TW390/1280 empty/loading/invalid/stale/denied/success, direct financial and photo/data matrix. Actual target migration/ACL tests, current build/fullbrowser/staging/Claude/real-device are NOT RUN for this plan. Existing native review does not replace Claude acceptance. Whole item remains pending.


## Actual gaps and decisions

No new Ron decision is required for base ceilings: that is resolved. The explicit v2 operation contracts for team.manage (delegable ordinary member work, nativeAdmin-only implicit Admin/custom-role governance) and data.export (all currently authorized regular domain data, mandatory redaction/audience) are implementation proposals requiring the designated independent/root product-scope review; they are not historical approved behavior. If that review identifies a real incompatible canonical requirement, report that exact item to Ron rather than silently narrow all eighteen keys. Concrete current gaps: full-data export has no implementation; field/legacy gateway manifests and SQL bodies must be authored; current target privileged login/ACL/role memberships, old-worker fence and backup/restore are unverified. These are assigned work/prerequisites, not an undefined demand that PE invent the design. After source package exists, PE owns only actual target reconciliation, approved nonMac parse/application and proof; Codex still owns application integration and exact acceptance evidence. Earlier inventory primary v7 assessment is superseded by independent Astra NO_GO; B018 v8 review belongs to root and is outside this B017 plan.


## Evidence and limits

Companion JSON binds 37 actual source/doc files, the prior plan and Ron decision. This primary plan authors no application source or migration SQL, runs no parser/DB/runtime/network/browser/tests, and reserves no source paths. It does not approve target application, staging, activation or whole-feature completion.
