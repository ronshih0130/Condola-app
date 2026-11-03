# B017 operation and all-authorized-data export contract v3

2026-11-03T13:28:13.549980-08:00; immutable source baseline `b8c4134fde7bbce933c1206137b9d92f4a55667f`. **PRIMARY_OPERATION_AND_EXPORT_CONTRACT_V3_FOR_INDEPENDENT_REVIEW_NOT_IMPLEMENTATION_OR_SQL_GO**. Incorporates independent fd11dbce amendments.

## Authority, persona and selector rules

C is trusted backend-only context(sessionId UUID, selectedOrg UUID, liveOrg UUID, environment live|sandbox, expectedAuthorityRevision bigint). No actor/role/mask/action/table fields from HTTP may confer authority. Adapter validates real cookie then SQL derives actual user/membership/persona. Admission includes org-state authority revision, actual member ID/native role/status, assignment+template revision, current session/consent/partner and schema-contract revision. Keys are fixed PERMS18; assigned explicit set is never intersected with old native ceiling.
Global staff-first is mandatory: canonical getSession resolution across live memberships is authoritative, including hidden memberships. Staff in A plus tenant in B cannot request tenant/owner export/reader through B to bypass staff floors. Vendor token is a separate persona path and never becomes a staff export credential. This staff custom-role export endpoint is staff only; genuine tenant/owner/vendor self-exports are existing separate features and are not invented here. Each chunk/file admission repeats global persona, not a selected-org-only membership lookup.
Selectors are fixed per operation, 25 choices/page max, bounded q<=100 chars, exact org/env/resource admission, IDs+labels+currency/status only. They cannot be exported, recursively expanded, joined to unrestricted contacts or treated as a fullread API. Explicit edit target may return only the exact fields needed to edit that one admitted object; request cannot enumerate arbitrary tables/fields. Current raw current page queries need splitting where list and edit forms are combined. tickets.update and messages.send have explicitly declared existing workspace read+write semantics; month.close has only its explicitly existing B014 typed history extension, not raw journal access. All other write-only grants remain selector/target/receipt scope.
Only native Admin plus effective team.manage governs custom roles, native Admin transitions or any transition removing a mandatory persona floor. Delegated team.manage manages ordinary nonself members/invitations within full RESULTING actor ceiling, including unassigned default rights. Serialize org/member/template/assignment/invitation and last usable Admin checks. Cover suspend/deactivate -> invitation issue/accept -> reactivation/base-role replacement as one effective floor analysis; an Accountant cannot evade photo denial by becoming Manager through a delegated two-step path. Actor cannot change self directly or via template. Preserve existing billing-owner check/unique index; no new recovery superuser. Expected revisions compare actual member and assignments, not coarse UI counts.

## Fixed gateway context and result contract

Every proposed name below is fixed and must be individually source-reviewed. C is the trusted context above. Complex typed payloads reuse the named existing TypeScript domain input with a frozen explicit field list and reject unknown keys; they are not arbitrary JSON DML. Byte inputs are validated by the existing importer/photo/PDF limits. Selectors return choices/nextCursor only; reads return ready rows and exact admission revision; mutations return resource ID/version only. UI readback requires a separately admitted reader.

## All18 operation mappings

### dash.view — READ_DASHBOARD

- Selector/fullread: none.
- Fixed signatures: b017_dashboard_read(C).
- Actual routes: `/m`.
- Actual functions: `queries.dashboard`, `queries.counts`, `queries.loadManagerChrome`.
- Actual raw/RPC objects: `properties`, `units`, `rooms`, `leases`, `invoices`, `payments`, `maintenance_tickets`.
- Export collections: dashboard.
- No inferred authority: .

### props.view — READ_PORTFOLIO

- Selector/fullread: none.
- Fixed signatures: b017_portfolio_page(C,cursor,limit); b017_lease_detail(C,lease_id); b017_lease_document(C,lease_id,version_id).
- Actual routes: `/m/properties`, `/m/units`, `/m/tenants`, `/m/leases`, `/m/owners`, `/m/archive`, `/api/pdf/leases/[id]`, `/m/leases/[id]/signed/[pdfId]`.
- Actual functions: `queries.listProperties/searchProperties/propertyDetail/listOwners/listTenants/searchTenants/listLeases/searchLeases/leaseDetail/tenantDetail/listSpaces/searchSpaces`, `pdf-docs.canDownloadLeasePdf`, `pdf-download.leasePdfForSession`, `paper-lease-versions reads`, `record-archive.archiveView/archiveList`.
- Actual raw/RPC objects: `properties`, `property_owners`, `units`, `rooms`, `contacts`, `leases`, `lease_parties`, `lease_charges`, `listing_terms`, `lease_signatures`, `lease_signed_pdfs`, `files`.
- Export collections: properties, units, rooms, owner_links, owners, tenants, leases, lease_parties, lease_signatures.
- No inferred authority: .

### props.edit — WRITE_PORTFOLIO_SELECTOR_ONLY

- Selector/fullread: property/space/owner IDs,label,currency,archive_state;25 choices/page; no phones/email/history.
- Fixed signatures: b017_property_choices(C,q,cursor,limit); b017_property_create(C,request_id,PropertyInput); b017_property_update(C,request_id,property_id,expected_version,PropertyEdit); b017_owner_create/update(C,request_id,target,OwnerEdit); b017_space_create/update(C,request_id,target,SpaceInput); b017_portfolio_import(C,request_id,exact_import_rows).
- Actual routes: `/m/properties/new`, `/m/properties/[id]/edit`, `/m/owners/[id]`, `/m/units/new`, `/m/units/room`, `/m/units/whole`, `/m/import`, `/api/import`, `/api/flows/createProperty`.
- Actual functions: `domain.createProperty/setMeterSerial`, `portfolio.createOwner/updateOwner/updateProperty/createSpace/updateSpace/seedPortfolio`, `import-batch.dryRunImport/previewImport/commitImportBatch`, `record-archive.archiveCommand property/unit/room; owner archive is separate unfinished B015 scope`.
- Actual raw/RPC objects: `properties`, `property_owners`, `units`, `rooms`, `contacts`, `meters`, `listing_terms`, `import_jobs`.
- Export collections: none solely from this right.
- No inferred authority: phone, email, full portfolio lists, export rows.

### leases.edit — WRITE_LEASE_SELECTOR_ONLY

- Selector/fullread: active property/unit/room ID,label,currency,status; exact existing lease editable terms only after explicit target admission.
- Fixed signatures: b017_lease_choices(C,q,cursor,limit); b017_lease_create/update(C,request_id,target,expected_version,LeaseInput); b017_lease_end(C,request_id,lease_id,actual_date,expected_version); b017_lease_sign/upload/simulate(C,request_id,lease_id,typed_existing_input); b017_utility_prepare/confirm/void(C,request_id,run_id,typed_existing_input).
- Actual routes: `/m/leases/new`, `/m/leases/[id] write actions`, `/m/rent/utilities`, `/api/flows/createLease`, `/api/flows/updateLease`, `lease signing/upload/simulation and B002 move-out handlers`.
- Actual functions: `domain.createLease/updateLease/signLease/uploadSignedLeasePdf/simulateTenantSignature`, `deposit-rules-actions`, `b002-move-out-actions`, `renewal-comparison`, `actions.actionPrepareUtility/actionConfirmUtility/actionVoidUtility`.
- Actual raw/RPC objects: `leases`, `lease_parties`, `lease_charges`, `lease_signature_events`, `lease_signatures`, `invoices`, `invoice_lines`, `meter_readings`, `utility_bills`, `utility_allocation_runs`, `utility_allocation_lines`.
- Export collections: none solely from this right.
- No inferred authority: unrelated leases, payment lists, tenant directory, photos.

### tenants.contact — READ_TARGET_PHONE

- Selector/fullread: explicit visible tenant contact target only; enumerable phonebook additionally props.view.
- Fixed signatures: b017_tenant_phone(C,tenant_contact_id,lease_id); b017_tenant_phone_page(C,cursor,limit) requires props.view too.
- Actual routes: `/m/tenants`, `/m/leases/[id]`, `related ticket/contact selectors`, `/api/export/all filtered contacts`.
- Actual functions: `queries.leaseDetail phone CASE`, `queries.listTenants/searchTenants/tenantDetail`, `owner_lease_tenants definer view`, `queries phone projections`.
- Actual raw/RPC objects: `contacts`, `listing_terms`, `profiles`, `owner_lease_tenants`, `tenant_lease_picker`.
- Export collections: tenant_phones.
- No inferred authority: bulk without props.view, email inference, portal switch.

### pay.record — PAYMENT_ACTION_QUEUE_SELECTOR_ONLY

- Selector/fullread: submitted queue ID,lease ID,amount,currency,date,payer label,status;50/page; explicit confirmed own command receipt; no archived bulk.
- Fixed signatures: b017_payment_queue(C,cursor,limit); b017_payment_lease_choices(C,q,cursor,limit); b017_payment_record(C,request_id,lease_id,amount_minor,paid_on,last5,reference); b017_payment_confirm/reject(C,request_id,payment_id,expected_state,rejection_reason).
- Actual routes: `/m/payments`, `/api/flows/recordPayment`, `/api/flows/confirmPayment`, `/api/flows/rejectPayment`.
- Actual functions: `domain.recordPayment/confirmPayment/rejectPayment`, `payment-center-events`, `payment-result-events`, `payment-request-status`.
- Actual raw/RPC objects: `payments`, `payment_allocations`, `invoices`, `invoice_lines`, `ledger_transactions`, `ledger_entries`, `app.b028_center_events / app.b028_center_recipients`, `app.b010_payment_commands / app.b010_source_events / app.b010_payment_contexts`.
- Export collections: none solely from this right.
- No inferred authority: full payment history, bank board, statement sources, reverse.

### pay.reverse — WRITE_REVERSE_EXPLICIT_TARGET

- Selector/fullread: exact payment ID,amount,currency,status,lease label and immutable posted-original identity; no journal list.
- Fixed signatures: b017_reversal_target(C,payment_id); b017_payment_reverse(C,request_id,payment_id,expected_original,internal_reason,explicit_public_reason).
- Actual routes: `/m/payments reverse action`, `domain.reversePayment caller paths`.
- Actual functions: `domain.reversePayment`, `public.post_reversal(two and three argument overloads)`, `payment-center-events reversal`, `payment-result-events reversal`.
- Actual raw/RPC objects: `payments`, `payment_allocations`, `ledger_transactions`, `ledger_entries`, `invoices`, `audit_log`, `B018 private public-reason companion if later installed`.
- Export collections: none solely from this right.
- No inferred authority: raw ledger, bulk payments, private reason export.

### bank.reconcile — BANK_WORKSPACE_READ_WRITE

- Selector/fullread: bank account ID/nickname/currency and same-command eligible payment ID/date/amount/currency/name; no full account number.
- Fixed signatures: b017_bank_board(C,cursor,limit); b017_bank_import(C,request_id,account_id,bytes,encoding,date_format); b017_bank_decide(C,request_id,bank_id,payment_id,suggestion_id,decision,reason).
- Actual routes: `/m/bank`, `/api/bank/matching`, `/api/flows/importBankCsv`, `/api/flows/approveMatch`.
- Actual functions: `bank-matching.authorize/bankMatchingEnabled/bankBoard/importBankFile/decideBankMatch`, `domain.importBankCsv/approveMatch`, `bank-match-basis`.
- Actual raw/RPC objects: `bank_accounts`, `bank_csv_mappings`, `bank_statement_imports`, `bank_transactions`, `bank_match_suggestions`, `payments`, `payment_allocations`, `ledger_transactions`, `ledger_entries`, `app.b009_file_imports`, `app.b009_decisions`, `files`.
- Export collections: bank_accounts, bank_lines, bank_suggestions.
- No inferred authority: payee numbers, general pay.record, raw CSV/provider payload.

### stmt.view — READ_FINANCIAL_VIEWS

- Selector/fullread: none beyond scoped financial read contract.
- Fixed signatures: b017_statement_page/detail/preview(C,target_or_cursor,limit); b017_rent_roll_page(C,cursor,limit); b017_invoice_page/line_page/payment_history_page/expense_financial_page(C,cursor,limit).
- Actual routes: `/m/rent`, `/m/statements`, `/m/statements/preview`, `/api/pdf/statements/[id]`.
- Actual functions: `queries.listStatements/statementRoster/rentRoll/statementDetail/statementPdfSource`, `statement-preview.statementPreview`, `utility-reconciliation`, `pdf-docs.canDownloadStatementPdf`, `pdf-download.statementPdfForSession`.
- Actual raw/RPC objects: `owner_statements`, `owner_statement_lines`, `invoices`, `payments`, `payment_allocations`, `expenses`, `management_agreements`, `fee_rules`, `ledger_entries`.
- Export collections: invoices, invoice_lines, payments, statements, statement_lines, rent_roll, utility_reconciliation, expense_financial.
- No inferred authority: full ledger/audit, account numbers, identity photos.

### stmt.generate — WRITE_GENERATE_SELECTOR_ONLY

- Selector/fullread: owner ID/name,currency,month; exact proposed statement preview/fingerprint for command, no historical list.
- Fixed signatures: b017_statement_owner_choices(C,q,cursor,limit); b017_statement_generate_preview(C,owner_id,month); b017_statement_generate(C,request_id,owner_id,month,expected_fingerprint).
- Actual routes: `/m/statements generate`, `/api/flows/generateStatement`.
- Actual functions: `domain.generateStatement/linkStatementInvoices`, `statement-calculation.calculateStatement`, `statement-preview`.
- Actual raw/RPC objects: `owner_statements`, `owner_statement_lines`, `invoices`, `payments`, `payment_allocations`, `expenses`, `management_agreements`, `fee_rules`.
- Export collections: none solely from this right.
- No inferred authority: statement archive, raw source ledger, bulk preview capture.

### exp.add — WRITE_EXPENSE_SELECTOR_ONLY

- Selector/fullread: property/unit/vendor IDs,labels,archive_state; explicit target ExpenseDetail for edit/approve under existing authority; no list.
- Fixed signatures: b017_expense_choices(C,q,cursor,limit); b017_expense_target(C,expense_id); b017_expense_create/update/approve/void(C,request_id,expense_id,expected_version,ExpenseDraft_or_reason).
- Actual routes: `/m/expenses`, `/m/statements expense form`, `/m/tickets/[id] expense subcommand`.
- Actual functions: `expenses.expenseFormOptions/listExpenses/getExpense/createExpense/updateExpense/voidExpense/approveExpense/addExpense`, `repairs.saveRepairRecord`, `vendor-repair.confirmVendorCost`.
- Actual raw/RPC objects: `expenses`, `ledger_transactions`, `ledger_entries`, `maintenance_tickets`, `files`.
- Export collections: none solely from this right.
- No inferred authority: bulk expenses, receipt bytes from selector, repair photo.

### month.close — CLOSE_ACTION_PLUS_EXPLICIT_TYPED_B014_HISTORY

- Selector/fullread: selected month,last closed period and status; typed B014 owner/property choices and source-marker records only.
- Fixed signatures: b017_close_context(C,month); b017_month_close(C,request_id,month,note); b017_owner_transfer_page(C,cursor,limit); b017_owner_transfer_record/reverse(C,request_id,typed_existing_input,expected_scope).
- Actual routes: `/m/close`, `/m/statements owner transfer actions`.
- Actual functions: `domain.closeMonth`, `owner-transfers.ownerTransferView/recordOwnerTransfer/reverseOwnerTransfer`, `owner-transfer-period-lock`.
- Actual raw/RPC objects: `month_closes`, `ledger_transactions`, `ledger_entries`, `owner_statements`, `invoices`, `properties`, `property_owners`, `contacts`.
- Export collections: owner_transfers.
- No inferred authority: raw journal, all invoices, statement history, internal reversal text export.

### tickets.update — REPAIR_WORKSPACE_READ_WRITE

- Selector/fullread: explicit compound queue/detail semantics required by current Maintenance workspace, not generic write-implies-read.
- Fixed signatures: b017_ticket_page/detail(C,target_or_cursor,limit); b017_ticket_create/update/comment(C,request_id,target,expected_version,typed_existing_input); b017_vendor_add/dispatch/revoke/share(C,request_id,target,typed_existing_input); b017_ticket_photo_prepare/confirm/read(C,target,typed_existing_input).
- Actual routes: `/m/tickets`, `/m/tickets/[id]`, `/api/flows/createTicket/updateTicket`, `/api/tickets/photos/sign/confirm/[id]`, `staff vendor-dispatch actions`.
- Actual functions: `domain.createTicket/updateTicket`, `repairs.saveRepairRecord/addTicketComment/repairPhotoTarget/attachRepairPhoto/readRepairPhoto`, `ticket-photos.prepareTicketPhotoUpload/confirmTicketPhoto/openTicketPhoto/signTicketPhotoUrls`, `vendor-repair.addVendor/dispatchVendor/revokeVendorJob/approveVendorSharing/confirmVendorCost`, `vendor-onboarding staff paths`.
- Actual raw/RPC objects: `maintenance_tickets`, `ticket_comments`, `ticket_attachments`, `files`, `expenses`, `repair_vendor_jobs`, `repair vendor sharing/onboarding private objects (exact manifest required)`.
- Export collections: repair_tickets, repair_comments.
- No inferred authority: Accountant photo metadata/bytes, expense post without exp.add, vendor bearer token export.

### messages.send — MESSAGE_WORKSPACE_READ_WRITE

- Selector/fullread: explicit current thread list/detail+send, not any-recipient bulk contact export.
- Fixed signatures: b017_thread_page(C,cursor,limit); b017_thread_messages(C,thread_id,cursor,limit); b017_message_send(C,request_id,thread_id,body).
- Actual routes: `/m/messages`, `/api/flows/postMessage`.
- Actual functions: `queries.listThreads/threadMessages`, `domain.postMessage`, `message attachment readers`.
- Actual raw/RPC objects: `message_threads`, `thread_participants`, `messages`, `message_attachments`, `files`.
- Export collections: message_threads, messages.
- No inferred authority: external send, new implicit recipients, auth/channel identities.

### reports.export — READ_EXPORT_FIXED_REPORT

- Selector/fullread: property/owner ID/name selectors only for existing period report.
- Fixed signatures: b017_report_choices(C,q,cursor,limit); b017_income_expense_report(C,period_mode,start,end,property_id,owner_id); existing report CSV route.
- Actual routes: `/m/reports`, `/m/reports/export`.
- Actual functions: `income-expense.loadIncomeExpense/reportCsv`, `src/app/m/reports/export/route.ts`.
- Actual raw/RPC objects: `properties`, `property_owners`, `contacts`, `payments`, `payment_allocations`, `expenses`, `ledger_transactions`, `ledger_entries`, `owner_statements`.
- Export collections: income_expense_report.
- No inferred authority: portfolio full export, raw financial rows beyond report fields.

### team.manage — READ_TEAM_PLUS_BOUNDED_GOVERNANCE

- Selector/fullread: member/invitation ID,displayed metadata and resulting effective set; current grants not submitted role authority.
- Fixed signatures: b017_team_page(C,cursor,limit); b017_team_invite/resend/revoke(C,request_id,target,typed_existing_input); b017_team_set_role/status(C,request_id,member_id,expected_membership,expected_assignment,result); b017_team_accept(verified_token_binding,typed_existing_acceptance); b017_role_create/edit/retire/assign/unassign(C,request_id,target,expected_revisions,explicit_keys).
- Actual routes: `/m/team`, `/m/roles assignment/editor only for baseAdmin`, `team invitation/member actions`.
- Actual functions: `auth.inviteMember/resendInvite/revokeInvite/setMemberRole/setMemberActive/acceptTeamInvite`, `auth-actions`, `domain.inviteTeammate`, `queries.listTeam`.
- Actual raw/RPC objects: `org_members`, `invitations`, `auth_sessions`, `app.b017_roles`, `app.b017_assignments`, `app.b017_commands`, `app.b017_org_state`.
- Export collections: team_members, team_invitations, custom_roles, custom_assignments.
- No inferred authority: self-lockout, native Admin/floor removal by nonAdmin, deactivate/reinvite bypass, raw session/MFA secrets.

### settings.edit — READ_EDIT_FIXED_SETTINGS

- Selector/fullread: only explicit settings tuple; no organizations.settings JSON.
- Fixed signatures: b017_settings_read(C); b017_settings_mail/privacy/mfa/rules(C,request_id,expected_version,typed_existing_input).
- Actual routes: `/m/settings`, `/m/notify`, `/m/roles existing owner privacy form`, `current org settings portions of /m/account`.
- Actual functions: `auth.setRequireMfa/setOwnerPrivacy`, `domain.setOwnerPhoneVisibility`, `mail-settings.saveOrgMailSettings`, `settings/edit guards on current account view`.
- Actual raw/RPC objects: `organizations`, `jurisdiction_rules org overrides`, `reminder_rules`, `mail_preferences/settings private objects`, `property_owners`.
- Export collections: org_settings.
- No inferred authority: platform flags, pricing/providers, unapproved B016 company/email/fees, role governance.

### data.export — EXPORT_EXISTING_READ_AUTHORITY_ONLY

- Selector/fullread: none; key alone returns manifest denied markers, never selectors promoted to datasets.
- Fixed signatures: b017_export_manifest(C); POST /api/export/all -> fixed projection capture and fixed file readers, no caller table/field/action selection.
- Actual routes: `existing /api/export properties.csv`, `proposed /api/export/all`.
- Actual functions: `src/app/api/export/route.ts currently staff+consent only`, `queries.listProperties`, `No actual full-data export consumer exists in current source`.
- Actual raw/RPC objects: `all explicit authorized domain projection collections; files only via reauthorized per-file reader`.
- Export collections: none solely from this right.
- No inferred authority: new data read rights, raw tables, private bank/audit/ledger payloads, role/persona override.


## Finite regular-data collection/column manifest

All collections require data.export plus their stated read gate. Sources below name exact columns/derived fields; they never license SELECT*. Native persona gates and field redactions are independent.

### dashboard [dash.view]

Output: `received_minor, outstanding_minor, owing_count, pending_count, ticket_count, room_count, occupied_count, currency_totals, as_of`.
Sources: `payments.amount_minor/status/paid_on/currency ; invoices.balance_minor/status/currency ; rooms.id/archived_at ; units.rental_mode/archived_at ; leases.status/target_room_id/target_unit_id ; maintenance_tickets.status`.
Reuse: queries.dashboard.
Work: Reuse calculations; fixed singleton projection, split monetary totals by actual currency; never sum currencies into unlabeled scalar.

### properties [props.view]

Output: `id, name, address_display, currency, rental_mode, archive_state`.
Sources: `properties.id/name/address_display/currency/default_rental_mode/archived_at`.
Reuse: queries.listProperties/searchProperties/propertyDetail.
Work: New bounded ID-keyset adapter over existing projection; no raw address JSON/notes/settings.

### units [props.view]

Output: `id, property_id, label, rental_mode, base_rent_minor, currency, archive_state`.
Sources: `units.id/property_id/label/rental_mode/base_rent_minor/archived_at ; properties.currency/archived_at`.
Reuse: queries.searchSpaces/propertyDetail.
Work: New safe unit reader because current searchSpaces is display-oriented; declared columns only, current portfolio visibility.

### rooms [props.view]

Output: `id, unit_id, property_id, label, room_type, base_rent_minor, currency, archive_state`.
Sources: `rooms.id/unit_id/label/room_type/base_rent_minor/archived_at ; units.property_id/archived_at ; properties.currency/archived_at`.
Reuse: queries.searchSpaces/propertyDetail.
Work: New bounded safe room projection, including current inherited archive state.

### owner_links [props.view]

Output: `id, property_id, owner_contact_id, owner_name, is_primary, effective_from, effective_to`.
Sources: `property_owners.id/property_id/owner_contact_id/is_primary/effective_from/effective_to ; contacts.display_name`.
Reuse: queries.propertyDetail/propertyEditor.
Work: New finite link projection; do not export can_view_tenant_phone without settings.edit; no owner bank data.

### owners [props.view]

Output: `id, name, email, phone, property_ids`.
Sources: `contacts.id/display_name/email/phone_e164/is_owner/is_tenant/archived_at ; property_owners.property_id/effective_from/effective_to`.
Reuse: queries.listOwnerDirectory.
Work: Reuse owner directory DTO with bounded paging. For a shared owner+tenant contact phone is redacted unless tenants.contact; never clear is_tenant or create duplicate contact to bypass it.

### tenants [props.view]

Output: `id, name, latest_lease_id, latest_place, latest_status, lease_count`.
Sources: `contacts.id/display_name/is_tenant/archived_at ; lease_parties.contact_id/lease_id/role ; leases.id/status/created_at ; properties.name ; units.label ; rooms.label`.
Reuse: tenant-directory.tenantDirectory.
Work: Reuse safe name/history projection; remove email/phone from this collection. Current directory SQL role lists and search terms must use effective rights; absent contact key cannot search by phone.

### tenant_phones [props.view AND tenants.contact]

Output: `tenant_contact_id, phone`.
Sources: `contacts.id/phone_e164/is_tenant/archived_at ; lease_parties.contact_id/lease_id/role`.
Reuse: queries.leaseDetail and tenant-directory conditional phone.
Work: New fixed bounded phone projection. A phone-only key without portfolio fullread supplies only explicit target context via b017_tenant_phone, never an enumerable phonebook.

### leases [props.view]

Output: `id, property_id, unit_id, room_id, status, esign_status, currency, rent_minor, deposit_minor, deposit_months, due_day, rent_frequency, start_date, end_date, signed_at, tenant_contact_id, tenant_name, tenant_email, archive_state`.
Sources: `leases.id/property_id/unit_id/target_room_id/status/esign_status/currency/rent_amount_minor/deposit_amount_minor/deposit_months/due_day/rent_frequency/start_date/end_date/signed_at ; lease_parties.contact_id/role ; contacts.display_name/email ; properties/units/rooms.archived_at`.
Reuse: queries.searchLeases/leaseDetail.
Work: New safe ID-keyset wrapper reuses actual lease fields. tenant_email only for the same visible primary-party row already returned by leaseDetail; never add unbound-directory emails, tenant_user_id or LINE identifiers. Phone is separate.

### lease_parties [props.view]

Output: `lease_id, contact_id, role, name`.
Sources: `lease_parties.lease_id/contact_id/role ; contacts.display_name`.
Reuse: queries.leaseDetail/listTenants.
Work: New bounded projection; exclude auth user link and contact channels.

### lease_signatures [props.view]

Output: `lease_id, signer_role, status, signed_name, signed_at`.
Sources: `lease_signatures.lease_id/signer_role/status/signed_name/signed_at`.
Reuse: queries.leaseDetail signatures.
Work: Reuse visible signature timeline; exclude signature images/identity material/provider audit envelope.

### invoices [stmt.view]

Output: `id, lease_id, status, issue_date, due_date, currency, total_minor, paid_minor, balance_minor`.
Sources: `invoices.id/lease_id/status/issue_date/due_date/currency/total_minor/paid_minor/balance_minor`.
Reuse: queries.rentRoll/leaseDetail financial rows.
Work: New fixed bounded invoice reader using current rent-roll/statement financial authority. This is a new safe adapter, not raw all-table permission.

### invoice_lines [stmt.view]

Output: `id, invoice_id, line_no, charge_type, description, amount_minor, period_start`.
Sources: `invoice_lines.id/invoice_id/line_no/charge_type/description/amount_minor ; invoices.period_start/lease_id/currency`.
Reuse: queries.tenantLeaseMoney financial calculation source; statement/rent-roll sources.
Work: New fixed staff financial line reader; no tenant-reader impersonation. Preserve signed credits and existing same-invoice parity; no raw journal memo.

### payments [stmt.view]

Output: `id, lease_id, status, amount_minor, currency, paid_on, payer_last5, payer_name, place`.
Sources: `payments.id/lease_id/status/amount_minor/currency/paid_on/payer_account_last5 ; contacts.display_name ; properties.name ; rooms.label`.
Reuse: queries.listPayments currently LIMIT40.
Work: New keyset/full-history adapter over exact existing safe list fields. pay.record alone only queue selectors/explicit command target; never enables this collection. Exclude reference, internal rejection/reversal reason, bank full numbers and raw audit.

### bank_accounts [bank.reconcile]

Output: `id, nickname, currency`.
Sources: `bank_accounts.id/nickname/currency/archived_at`.
Reuse: bank-matching.bankBoard accounts.
Work: Bounded adapter over exact board projection. Full account number, holder, private details, routing/provider fields never come from this collection.

### bank_lines [bank.reconcile]

Output: `id, posted_on, amount_minor, currency, last5, description, status, account_name, account_property_id, overlap`.
Sources: `bank_transactions.id/posted_on/amount_minor/currency/counterparty_account_last5/description/status ; bank_accounts.nickname/property_id`.
Reuse: bank-matching.bankBoard lines.
Work: Bounded adapter using existing board status set unmatched/suggested. Do not silently export matched/raw imports without a separately implemented safe history reader; mark bank_archive NOT_IMPLEMENTED if requested.

### bank_suggestions [bank.reconcile]

Output: `id, bank_id, payment_id, score, basis`.
Sources: `bank_match_suggestions.id/bank_transaction_id/payment_id/score/reasons/status`.
Reuse: bank-matching.bankBoard suggestions + bankMatchBasis.
Work: Reuse sanitized historical-basis DTO; raw reasons JSON, raw CSV/provider fields and private decision notes excluded.

### statements [stmt.view]

Output: `id, owner_id, owner_name, period_start, period_end, status, currency, opening_minor, rent_minor, other_minor, fee_minor, expenses_minor, payouts_minor, closing_minor`.
Sources: `owner_statements.id/owner_contact_id/period_start/period_end/status/currency/opening_balance_minor/rent_received_minor/other_income_minor/management_fee_minor/expenses_minor/payouts_minor/closing_balance_minor ; contacts.display_name`.
Reuse: queries.listStatements/statementDetail.
Work: Bounded exact statement projection; preserve original values, no recalculation of immutable report into latest state.

### statement_lines [stmt.view]

Output: `statement_id, line_type, description, amount_minor`.
Sources: `owner_statement_lines.statement_id/line_type/description/amount_minor`.
Reuse: queries.statementDetail lines.
Work: Reuse exact safe displayed fields; exclude ledger_transaction_id/raw ledger/expense-private pointers not displayed.

### rent_roll [stmt.view]

Output: `lease_id, place, tenant_name, currency, rent_minor, open_balance_minor, status`.
Sources: `leases.id/currency/rent_amount_minor/status ; properties.name ; units.label ; rooms.label ; contacts.display_name ; invoices.balance_minor/status`.
Reuse: queries.rentRoll.
Work: Bounded adapter reuses current rent-roll math; no tenant phone/user links.

### utility_reconciliation [stmt.view]

Output: `run_id, property_name, unit_label, currency, period_start, period_end, status, bill_minor, tenant_minor, owner_minor, public_minor, gap_minor, remainder_minor, difference_minor, availability`.
Sources: `utility_allocation_runs.id/currency/period_start/period_end/status ; utility_bills.total_amount_minor ; utility_allocation_lines.amount_minor/bearer ; properties.name ; units.label`.
Reuse: utility-reconciliation.utilityReconciliation/reconcileUtility.
Work: Reuse calculated typed output per month. No export of inputs JSON; malformed provenance gets row unavailable marker. Enumerating all periods needs bounded new month/index reader.

### expense_financial [stmt.view]

Output: `id, property_id, property_name, unit_id, unit_label, category, description, currency, amount_minor, incurred_on, status, bill_to, vendor_name, receipt_name, ticket_id, ticket_number, ticket_status, included`.
Sources: `expenses.id/property_id/unit_id/category/description/currency/amount_minor/incurred_on/status/bill_to/ticket_id/receipt_file_id ; contacts.display_name ; files.file_name ; maintenance_tickets.ticket_number/status`.
Reuse: expenses.ExpenseListRow/listExpenses and statement financial sources.
Work: New fixed financial-read wrapper over exact ExpenseListRow; exp.add only is selector/explicit edit target, not bulk read. Native legacy readers unchanged outside enrollment.

### owner_transfers [month.close]

Output: `id, original_id, owner_id, property_id, currency, minor_unit, amount_minor, effective_date, status, reference`.
Sources: `ledger_transactions.id/property_id/kind/currency/effective_date/description/reverses_transaction_id/source_table ; ledger_entries.amount_minor/account/contact_id/property_id ; currencies.minor_unit`.
Reuse: owner-transfers.ownerTransferView snapshot.
Work: Reuse ONLY validated B014 typed owner-transfer records from exact source marker; no arbitrary journal. This explicit existing B014 history read is part of month.close operation, not full financial-list inference; private reversal reason not exported.

### repair_tickets [tickets.update]

Output: `id, number, title, description, status, category, priority, property_id, place, currency, vendor_name, estimated_cost_minor, final_cost_minor, cost_bearer, scheduled_on, completed_on, expense_id, expense_status`.
Sources: `maintenance_tickets.id/ticket_number/title/description/status/category/priority/property_id/currency/vendor_name/estimated_cost_minor/final_cost_minor/cost_bearer/scheduled_on/completed_on/expense_id ; expenses.status`.
Reuse: queries.listTickets/ticketDetail.
Work: Explicit compound repair-workspace right includes bounded text/status queue/detail required by maintenance native persona. Implement safe keyset DTO; no photos/path from ticketDetail unless independent file gate below.

### repair_comments [tickets.update]

Output: `id, ticket_id, body, internal, status_from, status_to, at, author_name`.
Sources: `ticket_comments.id/ticket_id/body/is_internal/status_from/status_to/created_at ; profiles.display_name`.
Reuse: queries.ticketDetail comments.
Work: Reuse existing staff ticket comment audience; no author auth-ID/session fields. Native Accountant text access may be delegated; photo denial independent.

### message_threads [messages.send]

Output: `id, place, tenant_name, preview`.
Sources: `message_threads.id/lease_id/property_id/last_message_at ; messages.body ; contacts.display_name ; properties.name ; rooms.label`.
Reuse: queries.listThreads.
Work: Explicit existing message workspace read+send semantics, not a generic inference from any write key. Bounded keyset adapter; no external recipient/channel secrets or portal token.

### messages [messages.send]

Output: `id, thread_id, body, at, mine`.
Sources: `messages.id/thread_id/body/created_at/sender_user_id/deleted_at`.
Reuse: queries.threadMessages.
Work: Reuse existing allowed thread membership/staff scope; server derives mine; omit raw sender IDs, inbound provider/external IDs, deleted rows and raw attachments.

### team_members [team.manage]

Output: `member_id, name, email, native_role, status, mfa_enabled, last_sign_in`.
Sources: `org_members.id/role/status ; profiles.display_name/email ; user_mfa.enabled ; auth_sessions.last_active_at`.
Reuse: queries.listTeam.
Work: Reuse visible member metadata incl MFA boolean/last-sign-in summary only; omit user_id, auth/session rows, MFA seeds/backup codes. Native Admin transitions additionally governance gate.

### team_invitations [team.manage]

Output: `invitation_id, email, native_role, status, expires_at`.
Sources: `invitations.id/email/role/status/expires_at/kind`.
Reuse: queries.listTeam invitation union.
Work: Only team_member pending/revoked rows as existing page; token/code_hash/acceptance secrets and portal invitation bindings never exported.

### org_settings [settings.edit]

Output: `contact_email, contact_phone, tenant_lease_expiry_enabled, tenant_rent_overdue_enabled, owner_show_tenant_name, owner_show_tenant_phone, require_mfa`.
Sources: `organizations.contact_email/contact_phone; organizations.settings.require_2fa/show_tenant_name/show_tenant_phone/email_tenant_lease_expiry/email_tenant_rent_overdue`.
Reuse: mail-settings.orgMailSettings + auth.ownerPrivacy + require-MFA setting.
Work: Reuse exact typed setting readers; do not emit organizations.settings JSON, provider credentials, rollout flags, pricing/private company/fee drafts or legal text.

### custom_roles [native_admin AND team.manage]

Output: `role_id, display_name, keys, revision, lifecycle`.
Sources: `app.b017_roles.role_id/display_name/keys/revision/lifecycle`.
Reuse: B017 proposed role list; no current implementation.
Work: New fixed private-role read required; no raw command receipts/payload hashes or member secrets.

### custom_assignments [native_admin AND team.manage]

Output: `member_id, role_id, assignment_revision, role_revision`.
Sources: `app.b017_assignments.member_id/role_id/revision ; app.b017_roles.revision`.
Reuse: B017 proposed assignment read; no current implementation.
Work: New fixed governance projection; no requester supplied member/org authority.

### income_expense_report [reports.export]

Output: `property_id, property_name, owner_name, currency, income_minor, expense_minor, net_minor, period_start, period_end`.
Sources: `payments/payment_allocations/invoices/expenses/ledger source computations as current loadIncomeExpense ; properties.name ; contacts.display_name`.
Reuse: income-expense.loadIncomeExpense/reportCsv.
Work: Reuse actual reportPeriod + calculations with explicit period; no broad full-data substitute. CSV decimal path must preserve safe integer/string money source contract.

### audit_events [native_admin]

Output: `cursor, who, who_key, action_key, fields, other, masked, reason, record_key, record_text, found, when`.
Sources: `audit_log selected id/actor/action/event/changed_cols/reason/time ; existing recordLookupQuery safe names`.
Reuse: audit-read.loadAuditScreen/presentAudit.
Work: Reuse masked AuditView only with base Admin current-org checks. href omitted; no old_row/new_row/private source payloads even for native Admin; no implicit audit privilege from team.manage or data.export.


## File families

### lease_generated_pdf [props.view]

Binding: leases.id -> queries.leasePdfSource -> buildLeasePdf -> existing PDF renderer. Output metadata: `document_id, lease_id, filename, mime, size, sha256`.
Reader: pdf-download.leasePdfForSession. REUSE_RENDERER_ADD_EFFECTIVE_ADMISSION_AND_PER_FILE_AUDIT.
Existing generated source omits tenant phone/ID photo/full bank number; preserve exact template text without legal edits. This is a generated preview, never label a signed original.

### lease_signed_original [props.view AND tenants.contact AND current signed-file audience]

Binding: lease_signed_pdfs.org_id/lease_id/file_id -> files and existing signed-PDF byte route. Output metadata: `version_id, lease_id, filename, mime, size, sha256, current, supersedes_id`.
Reader: paper-lease-versions list + existing staff signed/[pdfId] route. REUSE_AUTHORIZED_ROUTE_ADD_EFFECTIVE_GATE.
Opaque uploaded bytes cannot be field-redacted. Unknown content classification gets UNSUPPORTED_CONTENT marker; do not assume separate identity-photo material is safe. Accountant protected ID/photo floor applies independently.

### statement_generated_pdf [stmt.view]

Binding: owner_statements.id -> queries.statementPdfSource -> buildStatementPdf. Output metadata: `document_id, statement_id, filename, mime, size, sha256`.
Reader: pdf-download.statementPdfForSession. REUSE_RENDERER_ADD_EFFECTIVE_ADMISSION_AND_AUDIT.
Use staff audience only after staff-first canonical resolution; no owner persona spoofing. No private bank or journal payload.

### repair_photo [tickets.update AND native_role != accountant AND existing exact photo audience]

Binding: ticket_attachments.org_id/ticket_id/file_id -> files matching private bucket/path. Output metadata: `attachment_id, ticket_id, filename, mime, size, sha256, internal`.
Reader: repairs.readRepairPhoto/ticket-photos.downloadRepairObject. NEW_AUTHENTICATED_BYTE_PROXY_OVER_EXISTING_DOWNLOAD.
Do not emit 600-second signed URLs. Metadata and bytes both denied to Accountant; no path/name/count leak in denied collection. Header/media validation unchanged.

### expense_receipt [stmt.view AND exact expense-financial record audience]

Binding: expenses.receipt_file_id -> files.org_id/id. Output metadata: `expense_id, filename, mime, size, sha256`.
Reader: expenses list/getExpense currently receipt_name only; no byte reader. NEW_FIXED_RECEIPT_BYTE_READER_REQUIRED.
Current demo receipt is text/plain synthetic name content. Never pretend filename proves real receipt. Unknown/opaque MIME or ID-photo-associated file gets unsupported marker; no generic files bucket download.

### message_attachment [messages.send AND exact existing thread audience AND file classification permits]

Binding: message_attachments.message_id/file_id -> messages.thread_id + files org. Output metadata: `attachment_id, message_id, filename, mime, size, sha256`.
Reader: schema association only; current threadMessages has no attachment byte reader. NEW_FIXED_MESSAGE_ATTACHMENT_READER_REQUIRED.
No actual existing app byte reader; must be implemented/reviewed before claiming complete. Protected ID/photo and native Accountant photo denial apply even through message attachments; unknown sensitivity cannot be guessed safe.


## Per-persona manifest evaluation

- admin: native export start True; if data.export is explicitly granted with these native read keys, eligible regular collections: dashboard, properties, units, rooms, owner_links, owners, tenants, tenant_phones, leases, lease_parties, lease_signatures, invoices, invoice_lines, payments, bank_accounts, bank_lines, bank_suggestions, statements, statement_lines, rent_roll, utility_reconciliation, expense_financial, owner_transfers, repair_tickets, repair_comments, message_threads, messages, team_members, team_invitations, org_settings, custom_roles, custom_assignments, income_expense_report, audit_events.
- manager: native export start False; if data.export is explicitly granted with these native read keys, eligible regular collections: dashboard, properties, units, rooms, owner_links, owners, tenants, tenant_phones, leases, lease_parties, lease_signatures, invoices, invoice_lines, payments, statements, statement_lines, rent_roll, utility_reconciliation, expense_financial, repair_tickets, repair_comments, message_threads, messages, income_expense_report.
- accountant: native export start False; if data.export is explicitly granted with these native read keys, eligible regular collections: dashboard, properties, units, rooms, owner_links, owners, tenants, leases, lease_parties, lease_signatures, invoices, invoice_lines, payments, bank_accounts, bank_lines, bank_suggestions, statements, statement_lines, rent_roll, utility_reconciliation, expense_financial, owner_transfers, income_expense_report.
- maintenance: native export start False; if data.export is explicitly granted with these native read keys, eligible regular collections: repair_tickets, repair_comments.

Custom assignments replace native keys; they do not inherit the listed read set. Global staff-first rejects portal reclassification. Accountant photo and native Admin governance/audit remain mandatory. File families always use their independent audience/classifier gate.


## Export start and input

POST /api/export/all is a fixed user-initiated read/download route with same-origin/consent checks and data.export; request accepts only approved report period and includeFiles boolean. Server chooses ALL manifest collections; no caller collection/table/field/mask/actor/role or SQL fragment. No external message/upload occurs. Allocate random exportId only as correlation, not authority. Capture canonical context and revisions server-side; no caller-supplied revision can create a grant. Unsupported period/filter is invalid, no unbounded range.


## Bounded capture and paging

Structured data uses one bounded repeatable-read READ ONLY capture transaction. Per collection fixed ID-keyset queries collect up to5000 rows,250/page,20000 overall and16MiB normalized UTF8 total; capture wall limit30s. Order by typed immutable source ID (audit uses existing UTC microsecond+ID keyset), retain duplicates where contract permits. Reuse source calculations and currency-safe integer strings. No OFFSET for all-data adapters. Limits are operational safety bounds, not commercial plan values. LIMIT+1 detects truncation; record TRUNCATED_LIMIT with continuation-available marker, no claim complete. A capture may not hold organization or authority row locks while bytes stream. After capture COMMIT, perform a FRESH current admission/revision check in another short read transaction and discard captured bytes if drift before any content leaves. This checks revocation that a repeatable-read snapshot could not see. Do not keep old snapshot/connection/locks alive across network/storage or response streaming.


## Revocation and byte delivery

Stream NDJSON contract3: header, collection_manifest, rows, per-file start/chunks/end, terminal_manifest. Auth and expected authority revision checked fresh before every <=1MiB structured batch/file chunk and at terminal footer; every file rechecks exact current resource audience and immutable metadata/hash before/after internal fetch. Each check transaction ends before writing bytes. On session/consent/persona/schema/authority drift abort further rows/files and emit terminal incomplete marker if transport still open; otherwise client treats missing terminal complete as incomplete. Already delivered bytes cannot be recalled and no instantaneous wall-clock revocation guarantee is claimed. This is bounded snapshot capture plus revalidated delivery, not lock-across-stream authorization. Cross-request resume is deliberately unsupported; restart a new export with new current authority, never use unsigned cursor/exportId as capability.


## File limits and private byte access

File metadata is itself gated before enumerating/counting. Max32 files,8MiB each,128MiB cumulative,180s total export lifetime; all limits include generated documents. Opaque filename/path content cannot prove safety; unknown sensitivity/classification yields UNSUPPORTED_CONTENT and no bytes. Hash+size/MIME/path allowlist and exact owning record are verified; generated existing PDFs retain original templates and are labeled generated. Use server internal fetch/render and audited proxy bytes, never export signed URLs/storage paths. Native Accountant denial covers protected photos through ticket, expense and message alternate associations; native Admin audit only allows masked AuditView, never raw audit JSON. No raw identity files, full account numbers, session/MFA/invite/LINE/provider secrets in any output.


## Denied, redacted and incomplete markers

Each finite collection/file family gets one status: INCLUDED, EMPTY_AUTHORIZED, DENIED_PERMISSION, DENIED_PERSONA, DENIED_MANDATORY_FLOOR, SELECTOR_ONLY, NOT_IMPLEMENTED, UNSUPPORTED_CONTENT, SOURCE_UNAVAILABLE, TRUNCATED_LIMIT, REVOKED_OR_REVISION_CHANGED. Unauthorized collection count is null and no IDs/names/counts leak; empty authorized count=0. Per-field redactions use fixed field names plus reason code, never hidden values or actual hidden counts. overallComplete is false if ANY denied, redacted, unsupported, unavailable, truncated or revoked collection/file exists; never label partial/denied package complete. A separate deliveredAuthorizedCollections count reports successful scope without implying missing datasets absent. Header declares fixed private-field exclusions from the regular-data contract. Missing terminal manifest means incomplete. Complete only means all declared regular contract3 datasets/files for this request were delivered without such markers, never a raw database backup or whole B017 acceptance.


## Private fields excluded from regular export

Never project auth.users passwords/provider identities; auth_sessions row/token/hash/UUID; MFA secret/recovery codes; invitations code_hash/token; contacts user_id/LINE ID/channel credentials; files storage_bucket/storage_path/signedURL; raw organizations.settings/feature_flags/provider config; raw bank details/full account/routing/holder data; bank_transactions.raw/import bytes; raw ledger_transactions.reason or ledger_entries.memo; raw audit old_row/new_row; private B010/B014/B015/B017/B018 commands/digests; existing internal reversal/rejection note by indirect join; identity-document photos/bytes/encryption references; legal/privacy/terms text not already existing rendered document. Existing ordinary user-written ticket/message/expense text is exported only through its exact authorized workspace reader; no false promise to remove a phone someone typed in free text.


## RLS/RPC/owner and old-client closure

Per-operation bridge maps actual source calls, not global has_role rewriting. Current schema generic team_read/insert/update/delete, org_members members_admin, contacts/profiles teammate SELECT, listing_terms policies and owner_lease_tenants definer view all require exact source-bound B017 gates. Assigned broad raw SELECT is denied; safe fixed readers return declared columns. Ordinary staff enrolled writes use exact fixed functions; current service/owner queries (bank-matching.authorize, B003, B007/B010/B014, archive, PDFs) need explicit effective admission and old-worker/credential fencing. No PUBLIC execute, no caller arbitrary field masks or bypass via set_config/SET ROLE. Actual target ACL/owner/FORCE-RLS remain unverified until the authored inactive SQL and nonMac evidence; Codex owns this manifest and implementation, PE owns actual target proof/application.


## Minimal new readers versus reuse

Required minimal NEW read adapters: safe unit/room/link projection; tenant-phone fixed projection; current-safe invoice/line/payment-history/expense-financial keyset readers; all-period utility summary index; bounded per-family adapters replacing fixed40/50 or unbounded current lists; masked audit page/export wrapper; B017 private role/assignment projection; explicit expense-receipt and message-attachment byte reader/classification; repair authenticated byte proxy; export manifest/capture/delivery coordinator. Reuse actual existing DTOs/calculations and fixed existing PDF builders. No financial math rewrite, new regular-data permission key, full raw ledger reader, new domain feature or legal copy is needed. Matched/archived bank history and arbitrary schema-only attachments have no current safe read surface and are explicitly OUTSIDE_CURRENT_READABLE_CONTRACT; do not invent mandatory new B017 domain scope. The six listed requested file families which lack a byte reader are marked NOT_IMPLEMENTED when includeFiles=true until their fixed authorized reader is delivered. These are concrete Codex work, not unspecified PE design.


## Source provenance and limits

All37 v2 source pins are reconciled against immutable b8c4134fde7bbce933c1206137b9d92f4a55667f. Additional actual reader files are pinned at the same baseline. Current working-source hashes are recorded separately; B018 changed files are not imported as new B017 design authority and B017 status/doc drift is disclosed. No app/SQL/reservation/runtime/DB/parser/browser/network/Downloads mutation by this task. Only these two workspace design reports authored.


## Eighteen-row acceptance matrix

| Key | Cross-base allowed example | Omission / selector / raw / export requirement |
|---|---|---|
| dash.view | Maintenance + dash.view sees labeled dashboard aggregates | Assigned omission denies every surface. READ_DASHBOARD: none. Raw/old-client probes required; export: dashboard |
| props.view | Maintenance + props.view reads portfolio names/lease metadata without phones | Assigned omission denies every surface. READ_PORTFOLIO: none. Raw/old-client probes required; export: properties, units, rooms, owner_links, owners, tenants, leases, lease_parties, lease_signatures |
| props.edit | Accountant + props.edit creates allowed space, photos still denied | Assigned omission denies every surface. WRITE_PORTFOLIO_SELECTOR_ONLY: property/space/owner IDs,label,currency,archive_state;25 choices/page; no phones/email/history. Raw/old-client probes required; export: No bulk collection solely from this key; data.export still needs actual read collection gates. |
| leases.edit | Accountant + leases.edit creates/ends allowed lease without broad directory | Assigned omission denies every surface. WRITE_LEASE_SELECTOR_ONLY: active property/unit/room ID,label,currency,status; exact existing lease editable terms only after explicit target admission. Raw/old-client probes required; export: No bulk collection solely from this key; data.export still needs actual read collection gates. |
| tenants.contact | Accountant + tenants.contact reads an admitted phone target; no base ceiling | Assigned omission denies every surface. READ_TARGET_PHONE: explicit visible tenant contact target only; enumerable phonebook additionally props.view. Raw/old-client probes required; export: tenant_phones |
| pay.record | Maintenance + pay.record confirms actual eligible submitted report | Assigned omission denies every surface. PAYMENT_ACTION_QUEUE_SELECTOR_ONLY: submitted queue ID,lease ID,amount,currency,date,payer label,status;50/page; explicit confirmed own command receipt; no archived bulk. Raw/old-client probes required; export: No bulk collection solely from this key; data.export still needs actual read collection gates. |
| pay.reverse | Manager + pay.reverse reverses actual eligible payment with required separate reasons | Assigned omission denies every surface. WRITE_REVERSE_EXPLICIT_TARGET: exact payment ID,amount,currency,status,lease label and immutable posted-original identity; no journal list. Raw/old-client probes required; export: No bulk collection solely from this key; data.export still needs actual read collection gates. |
| bank.reconcile | Manager + bank.reconcile imports and manually matches/rejects actual bank source | Assigned omission denies every surface. BANK_WORKSPACE_READ_WRITE: bank account ID/nickname/currency and same-command eligible payment ID/date/amount/currency/name; no full account number. Raw/old-client probes required; export: bank_accounts, bank_lines, bank_suggestions |
| stmt.view | Maintenance + stmt.view reads exact statement/rent-roll DTO | Assigned omission denies every surface. READ_FINANCIAL_VIEWS: none beyond scoped financial read contract. Raw/old-client probes required; export: invoices, invoice_lines, payments, statements, statement_lines, rent_roll, utility_reconciliation, expense_financial |
| stmt.generate | Manager + stmt.generate issues owner statement from exact preview | Assigned omission denies every surface. WRITE_GENERATE_SELECTOR_ONLY: owner ID/name,currency,month; exact proposed statement preview/fingerprint for command, no historical list. Raw/old-client probes required; export: No bulk collection solely from this key; data.export still needs actual read collection gates. |
| exp.add | Maintenance + exp.add records allowed expense via selectors | Assigned omission denies every surface. WRITE_EXPENSE_SELECTOR_ONLY: property/unit/vendor IDs,labels,archive_state; explicit target ExpenseDetail for edit/approve under existing authority; no list. Raw/old-client probes required; export: No bulk collection solely from this key; data.export still needs actual read collection gates. |
| month.close | Manager + month.close closes eligible month/records scoped B014 manual transfer | Assigned omission denies every surface. CLOSE_ACTION_PLUS_EXPLICIT_TYPED_B014_HISTORY: selected month,last closed period and status; typed B014 owner/property choices and source-marker records only. Raw/old-client probes required; export: owner_transfers |
| tickets.update | Accountant + tickets.update edits text/status while photo DTO/sign/bytes deny | Assigned omission denies every surface. REPAIR_WORKSPACE_READ_WRITE: explicit compound queue/detail semantics required by current Maintenance workspace, not generic write-implies-read. Raw/old-client probes required; export: repair_tickets, repair_comments |
| messages.send | Accountant + messages.send reads allowed thread and sends in-app message mock | Assigned omission denies every surface. MESSAGE_WORKSPACE_READ_WRITE: explicit current thread list/detail+send, not any-recipient bulk contact export. Raw/old-client probes required; export: message_threads, messages |
| reports.export | Maintenance + reports.export exports exact authorized report | Assigned omission denies every surface. READ_EXPORT_FIXED_REPORT: property/owner ID/name selectors only for existing period report. Raw/old-client probes required; export: income_expense_report |
| team.manage | Accountant + team.manage manages ordinary nonself target within ceiling; native Admin transition denied | Assigned omission denies every surface. READ_TEAM_PLUS_BOUNDED_GOVERNANCE: member/invitation ID,displayed metadata and resulting effective set; current grants not submitted role authority. Raw/old-client probes required; export: team_members, team_invitations, custom_roles, custom_assignments |
| settings.edit | Manager + settings.edit changes supported notice/privacy setting | Assigned omission denies every surface. READ_EDIT_FIXED_SETTINGS: only explicit settings tuple; no organizations.settings JSON. Raw/old-client probes required; export: org_settings |
| data.export | Manager + data.export + props.view exports permitted portfolio; other datasets denied markers | Assigned omission denies every surface. EXPORT_EXISTING_READ_AUTHORITY_ONLY: none; key alone returns manifest denied markers, never selectors promoted to datasets. Raw/old-client probes required; export: No bulk collection solely from this key; data.export still needs actual read collection gates. |

Every row additionally requires actual stale/revoked session+assignment, same/different org/env, hidden live membership staff-first, native privacy floors, operation replay/collision, exact current owner/service grants, and current flag OFF/native compatibility. Run real cross-base positive on fixed domain/API path, denied direct raw path and file byte route—not screenshots alone. Team row includes concurrent last-two Admin changes and deactivate/reinvite/accept floor attack; export row includes read/capture/delivery revision drift, truncation, missing footer and delayed file auth. No runtime has run here.

## Exact finite interface registry

The companion JSON expands prose family notation into 119 individual named interfaces, including all34 fixed collection projections. Each entry supplies exact arguments/results, permission gate and actual source reuse. No runtime function accepts a slash-separated action or arbitrary table/field list. Actual source type excerpts for PropertyInput, LeaseInput, SignLeaseInput, SpaceInput, PropertyElectricityInput, RepairInput, ExpenseDraft are bound in JSON to immutable b8; reuse those exact schemas and reject unknown keys. Additional domain signatures in this registry use explicit typed scalar fields or their exact current source argument schema, never open-ended DML.

Additional exact source argument bindings cover vendor add/dispatch/revoke/sharing/cost confirmation, photo prepare/confirm, utility prepare/confirm/void, specific archive targets, legacy bank paths and invitation acceptance. They reuse frozen b8 arguments with a trusted server context; no runtime Client/deps/arbitrary origin/table is accepted from callers. The registry defines fixed logical interfaces and source adapters, not an instruction to generate one redundant PostgreSQL wrapper for every existing pure reader: add a privilege bridge only where actual RLS/ACL/owner admission requires it.

includeFiles defaults true. Explicit false declares regular_structured_only and NOT_REQUESTED files; do not label that package all regular files. Current pay.record wording does not authorize inventing a new arbitrary charge writer; unfinished B008 issuing remains its existing capability.
