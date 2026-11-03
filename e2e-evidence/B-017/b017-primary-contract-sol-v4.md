# B017 minimal primary authoring contract v4

2026-11-03T14:14:54.870288-08:00; immutable baseline `b8c4134fde7bbce933c1206137b9d92f4a55667f`; current HEAD `1c8fd07bc1fd78e7a86a00daff994f68e734be4f`. **MINIMAL_PRIMARY_V4_FOR_INDEPENDENT_REVIEW_AND_INACTIVE_AUTHORING_NOT_SQL_OR_ENROLLMENT_GO**.

## scope

Accepted S1-S4 govern. Recognize18 PERMS keys but support17 in capability_version1. data.export is visibly UNSUPPORTED/unassignable. No all-data route,34 new collections,6 export file families,streaming product or B032 work. V3 export-only scaffolding remains immutable unapproved history and is superseded. Retain v2 explicit role assignment/four-table/governance design where valid; supersede its cross-org portal exception. Supported17 keys allow FULL cross-base explicit composition, never a target-base ceiling. This contract is source-only authoring guidance; no SQL/runtime/target/enrollment GO.

## catalog

One immutable supported-v1 list is the recognized PERMS18 minus data.export. Editor/API/DB role create/edit/assign, restored/imported authority validation, unassignment resulting state and replay all reject unknown, duplicate or unsupported keys. Do not silently remove a key. A referenced imported/stale/poisoned role or unavailable capability version returns UNAVAILABLE and no effective grants; it never becomes unassigned/native. Upgrading support version requires separate exact capability proof and explicit revalidation; no auto-grant. Existing property CSV remains six fields name,address,currency,mode,rooms,owner under effective props.view for enrolled staff; report CSV remains reports.export. Outside enrollment preserve original native/OFF behavior. Do not claim18 functioning grants.

## context

Trusted C derives from actual validated cookie and canonical getSession: session ID, actual actor, selected org/live parent/env, current native membership, effective keys and exact member/assignment/template/org-state revisions. Session UUID or submitted actor/role/GUC is not a credential. SQL additionally rechecks real unrevoked/unexpired session, live membership and selected relationship. Global staff-first includes every live membership, even hidden; staff in A plus tenant in B cannot choose B portal by a selected-org-only lookup. Genuine nonstaff tenant/owner/vendor remain separate exact existing audiences. Native Accountant photo denial and nativeAdmin company-audit/governance survive custom labels. Preserve B016 confirmed Auth Email and current B018 implementation unchanged.

## governance

Custom-role governance, nativeAdmin transitions and any transition removing a mandatory persona floor require nativeAdmin AND effective team.manage. Delegated team.manage permits ordinary nonself member operations only within full RESULTING actor authority, including all default rights of an unassigned target. Preserve inactive/removed membership native role and assignment tombstone; invitation issuance/acceptance/reactivation must examine them so deactivate/reinvite cannot turn Accountant into photo-capable Manager under a nonAdmin. No own direct/indirect authority change. Preserve existing billing-owner constraint/index; no invented owner recovery privilege. Role edits evaluate all assignees. Exact command receipt replay is freshly authorized; changed operation/payload/target/revision is conflict. No automatic retry of unknown mutation.

## locking

Authority order is current control fence where existing operation needs it -> live org FOR UPDATE -> selected sandbox org in deterministic order -> org_state FOR UPDATE -> members sorted ID -> roles sorted ID -> assignments/invite/receipt -> existing domain rows. Keep seat org-before-invite order. Domain writers hold shared authority/session rows before existing source/lease/invoice locks through COMMIT, so actor/template/session revocation serializes; recheck after waits under READ COMMITTED or proven equivalent. Bounded NOWAIT/lock timeout makes inverse old-writer order fail. Validate poststate >=1 active nativeAdmin with valid effective team.manage both command-end and deferred constraint across member/role/assignment transitions. Early SET CONSTRAINTS is not a reusable validation token. No locks while waiting on external storage/network; no background heartbeat.

## S4

OwnerCreate exact payload is {name,email,phone,propertyIds}; OwnerUpdate additionally ownerId and expectedOwnerLinksSha256. propertyIds is explicitly present, duplicate-free bounded uuid[]; missing INVALID, never default[]. Bind a256-link operational bound for this proposed command (not pricing). A text-only UI edit submits its actual complete array plus snapshot digest, never synthesized empty links. Explicit[] means intentional unlink only after same-org/current-authority/CAS checks. Canonical digest covers contact id/name/email/phone/is_owner/is_tenant/archived_at/updated_at at full SQL precision and ALL link tuples sorted immutable ID: id,property_id,owner_contact_id,is_primary,can_view_tenant_phone,effective_from,effective_to,created_at. Baseline property_owners has NO updated_at; do not invent one. Lock owner/current links/add-remove properties in stable order, recompute actual delta, validate same-org/active/history and preserve unchanged link IDs/dates/primary/phone flags. Do not call syncOwnerProperties with[] because a field was omitted.
For assigned/custom staff, new PropertyInput.canViewTenantPhone defaults false; explicit true requires props.edit AND effective settings.edit, checked before any property/contact/invite/link side effect. Reject unauthorized true atomically. Existing setOwnerPhoneVisibility is a separate explicit settings.edit operation with exact org/link/owner/property/expected-version checks; unrelated owner/contact/property edits never reopen exceptions. Global owner privacy stays its existing separate settings.edit contract. No new nativeAdmin ceiling is invented on a supported cross-base settings key. Preserve the previously permitted unassigned native creation choice only through an identified source-bound native compatibility branch, as S4 requires; custom props.edit does not acquire that implicit native exception. Explicitly test both branches.

## S2S3

In ENFORCED orgs the native Accountant floor applies to assigned AND unassigned members. Restrictive rules must defeat permissive team_read/uploaded-by-self/portal OR routes for files, ticket_attachments including legacy content, repair_vendor_job_shared_photos, repair_vendor_jobs, message_attachments and identity-document/photo relations. Native Accountant direct files reads may be denied wholesale; safe existing expense receipt-name/financial DTOs preserve nonphoto finance without raw file path/bytes. Actual ticket text/comments/status remain available under tickets.update while photo IDs/names/counts/paths/content/upload/sign/bytes are absent/denied. NativeAdmin company audit remains actual native role, never custom label/team.manage/settings.edit. Genuine tenant/vendor audience remains exact; global staff-first prevents staff portal coercion.
At staff dispatch creation, loadVendorDispatch secret/sharing lookup, share-change and detail serialization enforce the native floor. Accountant+tickets.update cannot mint/rotate/replay a photo-capable job URL, read it, enumerate attachments or change sharing. Safe text/vendor/status operations are separate. Text-only save omits sharing/photo fields entirely, never[] and never deletes existing shares. Revoke may return only status without mint/disclosure. Protect both existing vendor modes and findVendorPhoto/openVendorPhoto/streamVendorPhoto; a copied bearer on another device cannot be attributed through a staff cookie.

## bearers

Choose conservative retirement; no new exposure-tracking subsystem. Before first enrollment fence ALL old worker/credential minting and staff/vendor signed-read issuance, deploy checked proxies for staff and both vendor modes, and retire every potentially exposed active photo-capable org job bearer when attribution is absent. Set actual job inactive/revoked/expired, delete corresponding repair_vendor_secrets token; preserve job rows/shares/attachments/reported costs/expense/confirmation history. Verify OLD copied URLs fail through open_vendor_job and both legacy/enhanced photo paths. Wait>=600s from VERIFIED last old storage signed-read issuance, or prove actual storage revocation, without a DB lock during wait. Vendor job expiry is its own actual expires_at/revocation, not600s.
After proxy rollout, any template/assignment/native-role/status/invite transition losing photo authority privately retires all potentially exposed org photo-capable bearers in the SAME governance transaction under org/job locks. No URL regeneration or external send. New deliberate dispatch/share waits for a properly authorized photo-capable staff actor. If issuance/credential fence or retirement cannot be verified, defer enrollment/transition honestly. Evidence timestamps/digests are records, never caller authorization. Already delivered bytes cannot be erased; in-flight/snapshot limits remain explicit.

## ownersACL

Use b017_authority_owner and b017_domain_owner as NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT roles. Backend receives exact function EXECUTE, never role membership/SET ROLE. Authority owner owns four private tables/functions and receives exact canonical org/member/session read grants/policies; avoid policy recursion. Domain owner owns only reviewed fixed domain/projection functions with exact source-table grants/policies. Private tables RLS ENABLE+FORCE, no PUBLIC/anon/authenticated/service direct SELECT/DML. Fixed definer functions fully qualify names, safe pg_catalog search_path, strict source schemas, no arbitrary action/table/field/actor SQL. Trigger invoker-owner checks run SECURITY INVOKER or bind actual invoker before definer context changes; never trust every non-authenticated/table-owner role. Existing function allowlist/default ACLs must be updated exactly. Actual login owner/BYPASSRLS/inheritance/FORCE RLS is TARGET_UNVERIFIED. An old privileged worker can bypass read RLS: require actual credential/worker retirement before enrollment, not only an inactive migration or flag.

## Exact four private tables

### app.b017_org_state

Columns: live_org_id uuid PK/FK; enforcement_state prepared|enforced; capability_version int=1; authority_revision bigint>0; support_manifest_sha256 bytea32; photo_issuance_fenced_at/vendor_bearers_retired_at/enrolled_at timestamptz nullable; updated_at timestamptz.
Enforced cannot downgrade/delete by UI/flags. Evidence is not capability. Enrollment is trusted nonMac maintenance after explicit activation gates.

### app.b017_roles

Columns: org_id,role_id uuid compositePK; display_name bounded; name_key canonical unique per org; keys text[] canonical supported17; revision bigint; lifecycle draft|active|retired; created_by/updated_by UUID; timestamps.
No base ceiling field. Referenced retired/unknown/unsupported role unavailable. No role deletion/cascade broad fallback.

### app.b017_assignments

Columns: org_id,member_id uuid compositePK/FK exact org_members; role_id nullable compositeFK exact role; revision bigint; assigned_by UUID; updated_at.
Explicit NULL-role tombstone on unassign, never delete/reset on suspend/reinvite. Expected membership/assignment/role revisions required.

### app.b017_commands

Columns: org_id,actor_member_id,request_id UUID unique; command fixed authority enum; target_id; intent_sha256 bytea32; expected_revisions strict tuple; result_identity strict metadata; committed_at.
Immutable committed authority receipt only. SQL canonical intent; no arbitrary DML/actions, financial engine, token/email/free payload or secret.

## Core fixed SQL functions

These names/signatures are fixed contracts, not generic table/action/field dispatch. Context never replaces real-cookie validation. Actual domain ports reuse source bodies listed below.

| Signature | Result | Fixed contract |
|---|---|---|
| `app.b017_recognized_keys_v1()` | fixed text[]18 | pure immutable recognized list; no authority |
| `app.b017_supported_keys_v1()` | fixed text[]17 | pure immutable excludes data.export |
| `app.b017_keys_supported_v1(text[])` | boolean | strict canonical duplicate-free supported subset for CHECK+commands |
| `app.b017_effective_context(p_session uuid,p_org uuid,p_env text)` | bounded current C tuple | service-only verified cookie adapter; actual global persona/current session/member/revisions/readiness |
| `app.b017_has_permission(p_org uuid,p_key text)` | boolean | policy helper derives actual subject; unknown/unsupported/poison false; no mutation capability |
| `app.b017_raw_read_ok(p_org uuid,p_relation text)` | boolean | policy passes fixed literal relation; no arbitrary query/row output |
| `app.b017_native_photo_allowed(p_org uuid)` | boolean | native Accountant/global staff-first floor independent assignment |
| `app.b017_role_list(p_session uuid,p_org uuid,p_env text)` | bounded role/assignment metadata | nativeAdmin+effective team.manage |
| `app.b017_role_create(p_session uuid,p_org uuid,p_request uuid,p_name text,p_keys text[])` | roleId/revision | strict support/actor ceiling/current governance |
| `app.b017_role_edit(p_session uuid,p_org uuid,p_request uuid,p_role uuid,p_expected bigint,p_name text,p_keys text[])` | roleId/revision | all assignees/self/lastAdmin/photo-loss retirement |
| `app.b017_role_retire(p_session uuid,p_org uuid,p_request uuid,p_role uuid,p_expected bigint)` | roleId/revision | deny referenced role |
| `app.b017_role_assign(p_session uuid,p_org uuid,p_request uuid,p_member uuid,p_expected_member text,p_expected_assignment bigint,p_role uuid,p_expected_role bigint)` | member/assignment revision | resulting ceiling/floors |
| `app.b017_role_unassign(p_session uuid,p_org uuid,p_request uuid,p_member uuid,p_expected_member text,p_expected_assignment bigint)` | member/assignment revision | resulting full native set; no self or default escalation |
| `app.b017_command_status(p_session uuid,p_org uuid,p_request uuid,p_intent bytea)` | committed|unknown|forbidden | exact freshly authorized metadata receipt |
| `app.b017_member_set_role(p_session uuid,p_org uuid,p_request uuid,p_member uuid,p_expected text,p_assignment bigint,p_role public.org_role)` | member revision | nativeAdmin/floor/lastAdmin/ceiling invariants |
| `app.b017_member_set_status(p_session uuid,p_org uuid,p_request uuid,p_member uuid,p_expected text,p_assignment bigint,p_active boolean,p_confirmed boolean)` | member revision | seat/session/floor/lastAdmin atomic |
| `app.b017_member_invite(p_session uuid,p_org uuid,p_request uuid,p_email text,p_name text,p_role public.org_role)` | existing invite receipt | actual current inviter/inactive target/default ceiling, no send |
| `app.b017_member_invite_rotate(p_session uuid,p_org uuid,p_request uuid,p_invite uuid)` | existing invite receipt | fresh target/issuer floor |
| `app.b017_member_invite_revoke(p_session uuid,p_org uuid,p_request uuid,p_invite uuid)` | inviteId | current exact scope |
| `app.b017_member_invite_accept(p_actual_token_binding text,p_actual_user uuid,p_expected_invite text)` | member receipt | trusted original bearer/password/consent identity, current inviter/target native floor; actual user not form authority |
| `app.b017_owner_create(p_session uuid,p_org uuid,p_request uuid,p_name text,p_email text,p_phone text,p_property_ids uuid[])` | ownerId/link digest | explicit propertyIds required; no missing [] |
| `app.b017_owner_update(p_session uuid,p_org uuid,p_request uuid,p_owner uuid,p_name text,p_email text,p_phone text,p_property_ids uuid[],p_expected_owner_links bytea)` | ownerId/link digest | same-org/CAS actual link delta preserving flags/dates |
| `app.b017_owner_phone_set(p_session uuid,p_org uuid,p_request uuid,p_link uuid,p_expected bytea,p_visible boolean)` | linkId/digest | explicit settings.edit and exact link/owner/property scope |
| `app.b017_retire_exposed_vendor_bearers(p_org uuid)` | void | PRIVATE governance helper only; retires token/secret, preserves shares/job/cost history |
| `app.b017_guard_authority_write()` | trigger SECURITY INVOKER | ordinary raw authority/member writes rejected when enforced; fixed owner only |
| `app.b017_guard_assigned_domain_write()` | trigger SECURITY INVOKER | fixed actual TG_TABLE_NAME set; assigned/unknown actor uses exact domain-owner bridge |
| `app.b017_guard_owner_link_write()` | trigger SECURITY INVOKER | versioned explicit owner/link/phone path, no ordinary raw mutation |
| `app.b017_require_recovery_admin()` | private validator+constraint trigger | poststate >=1 active nativeAdmin+team.manage; command-end and deferred |
| `app.b017_command_immutable()` | trigger | ordinary UPDATE/DELETE/TRUNCATE denied; explicit approved org/reset maintenance only |

## Exact policy and trigger targets

- b017_assigned_read_fence: AS RESTRICTIVE FOR SELECT TO authenticated on `properties, property_owners, units, rooms, contacts, listing_terms, leases, lease_parties, lease_signatures, lease_signature_events, lease_charges, rule_check_results, meters, meter_readings, utility_bills, utility_allocation_runs, utility_allocation_lines, invoices, invoice_lines, payments, payment_allocations, ledger_transactions, ledger_entries, bank_accounts, bank_csv_mappings, bank_statement_imports, bank_transactions, bank_match_suggestions, maintenance_tickets, ticket_comments, ticket_attachments, expenses, owner_statements, owner_statement_lines, message_threads, thread_participants, messages, message_attachments, files, lease_signed_pdfs, repair_vendor_jobs, repair_vendor_job_shared_photos`. b017_raw_read_ok(org_id, fixed literal relation). Outside enforced existing semantics; assigned broad raw deny; genuine nonstaff original portal remains row-scoped; canonical staff foreign-portal denied.
- b017_native_photo_floor: AS RESTRICTIVE SELECT/ordinary writes where applicable TO authenticated on `files, ticket_attachments, repair_vendor_job_shared_photos, repair_vendor_jobs, message_attachments, identity_document_photos, identity_documents`. Enforced native Accountant denies regardless assignment; defeats uploaded-by-self/team/portal OR and legacy content. Exact safe nonphoto finance projection replaces raw file join when needed.
- b017_native_audit_floor: AS RESTRICTIVE FOR SELECT TO authenticated on `audit_log`. actual current nativeAdmin in org only; definer API checks same; no assignable raw-audit privilege
- b017_private_owner: RLS ENABLE+FORCE + exact owner policies/ACL on `app.b017_org_state, app.b017_roles, app.b017_assignments, app.b017_commands`. No public/anon/authenticated/service table access; exact owner policies avoid recursive member reads; backend EXECUTE only
- b017_phone_projection_fence: fixed safe projection plus actual restrictive guards/view amendment on `contacts, profiles, listing_terms, owner_lease_tenants`. No row-RLS claim of column masking; global staff-first, effective tenant phone, genuine owner privacy; self profile preferences remain actual existing self scope
- b017_member_authority_guard: BEFORE INSERT/UPDATE/DELETE on `org_members`, `app.b017_guard_authority_write()`. enforced raw role/status/user/org/billing owner/member deletion rejected; fixed commands include old invite and deactivate/reinvite
- b017_private_authority_guard: BEFORE INSERT/UPDATE/DELETE on `app.b017_org_state, app.b017_roles, app.b017_assignments`, `app.b017_guard_authority_write()`. strict keys/revisions/org/sticky state; no ordinary delete/unassign fallback
- b017_last_admin_constraint: DEFERRABLE INITIALLY DEFERRED AFTER INSERT/UPDATE/DELETE + command-end validator on `org_members, app.b017_roles, app.b017_assignments`, `app.b017_require_recovery_admin()`. org lock/current poststate, native/effective recoveryAdmin >=1
- b017_domain_write_guard: BEFORE supported INSERT/UPDATE/DELETE on `properties, property_owners, units, rooms, contacts, listing_terms, leases, lease_parties, lease_signatures, lease_signature_events, lease_charges, rule_check_results, meters, meter_readings, utility_bills, utility_allocation_runs, utility_allocation_lines, invoices, invoice_lines, payments, payment_allocations, ledger_transactions, ledger_entries, bank_accounts, bank_csv_mappings, bank_statement_imports, bank_transactions, bank_match_suggestions, maintenance_tickets, ticket_comments, ticket_attachments, expenses, owner_statements, owner_statement_lines, message_threads, thread_participants, messages, message_attachments, files, lease_signed_pdfs, repair_vendor_jobs, repair_vendor_job_shared_photos`, `app.b017_guard_assigned_domain_write()`. assigned/unknown service actor only named domain-owner body; preserve genuine portal shape; not broad privileged-role waiver
- b017_owner_link_guard: BEFORE INSERT/UPDATE/DELETE on `property_owners`, `app.b017_guard_owner_link_write()`. enforced explicit versioned links/privacy command; no empty-default or implicit visibility
- b017_command_no_change: BEFORE UPDATE/DELETE; BEFORE TRUNCATE statement on `app.b017_commands`, `app.b017_command_immutable()`. ordinary immutable; approved org/reset maintenance separate and proved

## Forty-seven existing enforcement groups

These are47 existing call groups, not47 new features or119 export wrappers. Reuse actual current typed source inputs/results; bridge only actual privilege/field gaps.

### O01 navigation

Keys: all supported. Source: `src/server/perms.ts; src/app/m/layout.tsx; src/components/chrome.tsx`. Actual: `can/assertPerm/visibleNav/noPermHref/roleHome`. request snapshot display; operations reauthorize.

### O02 roles

Keys: nativeAdmin+team.manage. Source: `src/app/m/roles/page.tsx`. Actual: `PERMS matrix/custom role controls`. 18recognized/17selectable; fixed role CRUD/assign APIs.

### O03 team_read

Keys: team.manage. Source: `src/app/m/team/page.tsx; src/server/queries.ts`. Actual: `listTeam`. existing safe member metadata only.

### O04 member_role_status

Keys: team.manage + governance floor. Source: `src/server/auth.ts; src/server/auth-actions.ts`. Actual: `setMemberRole/setMemberActive`. atomic floor/lastAdmin/seat/session effects.

### O05 invite_management

Keys: team.manage + resulting ceiling. Source: `src/server/auth.ts; src/server/domain.ts`. Actual: `inviteMember/resendInvite/revokeInvite/inviteTeammate`. current inviter/target native floor; no send.

### O06 invite_accept

Keys: actual bearer + current inviter authority. Source: `src/server/auth.ts`. Actual: `acceptTeamInvite`. same org lock; inactive native floor and assignment retained.

### O07 dashboard

Keys: dash.view. Source: `src/server/queries.ts; src/app/m/page.tsx`. Actual: `dashboard/loadManagerChrome`. bounded displayed aggregates; no bootstrap leakage.

### O08 portfolio_lists

Keys: props.view. Source: `src/server/queries.ts; src/app/m/properties/page.tsx; src/app/m/units/page.tsx`. Actual: `listProperties/searchProperties/listSpaces/searchSpaces`. existing safe projection.

### O09 portfolio_detail

Keys: props.view read / props.edit edit. Source: `src/server/queries.ts; src/app/m/properties/[id]/page.tsx`. Actual: `propertyDetail/propertyEditor/spaceEditor`. split financial/photo/edit subresults.

### O10 property_create

Keys: props.edit + settings.edit for custom true. Source: `src/server/domain.ts; src/server/actions.ts; src/app/api/flows/[action]/route.ts`. Actual: `createProperty`. S4 false default; true admission before side effects.

### O11 property_space_meter

Keys: props.edit. Source: `src/server/portfolio.ts; src/server/domain.ts; src/server/actions.ts`. Actual: `updateProperty/createSpace/updateSpace/setMeterSerial`. no implicit owner/privacy reset.

### O12 owner_read

Keys: props.view. Source: `src/server/queries.ts; src/app/m/owners/page.tsx`. Actual: `listOwnerDirectory/ownerEditor/listOwners`. safe row; contact phone separate.

### O13 owner_create

Keys: props.edit. Source: `src/server/portfolio.ts; src/server/actions.ts`. Actual: `createOwner/syncOwnerProperties`. required explicit propertyIds.

### O14 owner_update

Keys: props.edit. Source: `src/server/portfolio.ts; src/server/actions.ts`. Actual: `updateOwner/syncOwnerProperties`. required propertyIds+link digest; preserve unchanged links.

### O15 owner_phone

Keys: settings.edit explicit. Source: `src/server/domain.ts; src/server/auth.ts; src/server/auth-actions.ts`. Actual: `setOwnerPhoneVisibility/setOwnerPrivacy`. exact link/org/CAS; no cosmetic edit widening.

### O16 portfolio_import

Keys: props.edit + leases.edit if actual lease. Source: `src/server/import-batch.ts; src/server/portfolio.ts; src/app/api/import/route.ts`. Actual: `dryRunImport/previewImport/commitImportBatch/seedPortfolio`. same source parser/atomic key conjunction.

### O17 tenant_phone

Keys: props.view / tenants.contact. Source: `src/server/tenant-directory.ts; src/server/queries.ts`. Actual: `tenantDirectory/tenantDirectoryHistory/listTenants/leaseDetail`. effective phone CASE/search; no hidden phone or user/LINE payload.

### O18 lease_read

Keys: props.view. Source: `src/server/queries.ts; src/app/m/leases/[id]/page.tsx`. Actual: `listLeases/searchLeases/leaseDetail`. safe metadata/signatures; separate financial/photo gates.

### O19 lease_write

Keys: leases.edit. Source: `src/server/domain.ts; src/server/actions.ts; src/app/api/flows/[action]/route.ts`. Actual: `createLease/updateLease/createLeaseFromForm`. minimal selectors; exact existing terms/version/ancestry.

### O20 lifecycle_rules

Keys: leases.edit. Source: `src/server/b002-move-out-actions.ts; src/server/deposit-rules-actions.ts; src/server/renewal-comparison.ts`. Actual: `actual move-out/deposit override/comparison`. no invented unfinished B012 writer.

### O21 paper_sign_upload

Keys: leases.edit. Source: `src/server/domain.ts; src/server/paper-lease-versions.ts; src/server/actions.ts`. Actual: `signLease/uploadSignedLeasePdf/simulateTenantSignature`. same current staff audience/formal/sandbox.

### O22 lease_pdf

Keys: props.view + exact file audience. Source: `src/server/pdf-download.ts; src/server/pdf-docs.ts; staff signed-PDF routes`. Actual: `leasePdfForSession/listPaperLeaseVersions`. reuse current renderer/version bytes, no new export reader.

### O23 payment_action_read

Keys: pay.record selector; stmt.view financial list. Source: `src/server/queries.ts; src/app/m/payments/page.tsx`. Actual: `listPayments/payment target selectors`. write-only key no broad archive/raw journal.

### O24 payment_record

Keys: pay.record. Source: `src/server/domain.ts; src/server/actions.ts; src/app/api/flows/[action]/route.ts`. Actual: `recordPayment`. unchanged allocation/posting/B010/B028.

### O25 payment_confirm

Keys: pay.record. Source: `src/server/domain.ts; src/server/actions.ts; src/app/api/flows/[action]/route.ts`. Actual: `confirmPayment`. same source/locks/eligible state.

### O26 payment_reject

Keys: pay.record. Source: `src/server/domain.ts; src/server/actions.ts; src/app/api/flows/[action]/route.ts`. Actual: `rejectPayment`. submitted-only explicit reason.

### O27 payment_reverse

Keys: pay.reverse. Source: `src/server/domain.ts; src/server/auth-actions.ts; src/server/payment-center-events.ts`. Actual: `reversePayment/post_reversal payment path`. B018 separate reason unchanged; no arbitrary journal retarget.

### O28 bank_read

Keys: bank.reconcile. Source: `src/server/bank-matching.ts; src/server/queries.ts; src/app/m/bank/page.tsx`. Actual: `bankMatchingEnabled/bankBoard/listMatches`. replace TS+owner SQL base ceilings; safe DTO.

### O29 bank_import

Keys: bank.reconcile. Source: `src/server/bank-matching.ts; src/server/domain.ts; src/app/api/bank/matching/route.ts`. Actual: `importBankFile/importBankCsv`. same parser/dedupe/account/currency.

### O30 bank_decision

Keys: bank.reconcile. Source: `src/server/bank-matching.ts; src/server/domain.ts; src/app/api/bank/matching/route.ts`. Actual: `decideBankMatch/approveMatch`. existing match-confirm composite, not general pay.record.

### O31 statement_read

Keys: stmt.view. Source: `src/server/queries.ts; src/server/statement-preview.ts; src/app/m/statements/page.tsx`. Actual: `rentRoll/listStatements/statementDetail/statementPreview`. same safe math/DTO, no private raw sources.

### O32 statement_generate

Keys: stmt.generate. Source: `src/server/domain.ts; src/server/actions.ts; src/app/m/statements/page.tsx`. Actual: `generateStatement`. command owner/month/preview only without stmt.view.

### O33 statement_pdf

Keys: stmt.view + exact audience. Source: `src/server/pdf-download.ts; src/app/api/pdf/statements/[id]/route.ts`. Actual: `statementPdfForSession`. global staff-first, current renderer/privacy/audit.

### O34 expenses

Keys: exp.add target / stmt.view full read. Source: `src/server/expenses.ts; src/server/actions.ts; src/app/m/expenses/page.tsx`. Actual: `expenseFormOptions/getExpense/createExpense/updateExpense/approveExpense/voidExpense`. safe receipt-name DTO despite native Accountant raw file fence.

### O35 month_close

Keys: month.close. Source: `src/server/domain.ts; src/server/auth-actions.ts; src/app/m/close/page.tsx`. Actual: `closeMonth`. selected-month context only.

### O36 owner_transfer

Keys: month.close existing B014 scope. Source: `src/server/owner-transfers.ts; src/server/owner-transfer-period-lock.ts`. Actual: `ownerTransferView/recordOwnerTransfer/reverseOwnerTransfer`. typed b014_owner_transfer_v1, no raw ledger/money movement.

### O37 utilities

Keys: leases.edit writes / stmt.view read. Source: `src/server/utility-posting.ts; src/server/utility-reconciliation.ts; src/app/m/rent/utilities/page.tsx`. Actual: `prepareUtilityRun/confirmUtilityRun/voidUtilityRun/utilityReconciliation`. same original tenant/owner/math/rules/flags.

### O38 ticket_text

Keys: tickets.update. Source: `src/server/repairs.ts; src/server/domain.ts; src/server/queries.ts; src/app/m/tickets/[id]/page.tsx`. Actual: `listTickets/ticketDetail/createTicket/updateTicket/saveRepairRecord/addTicketComment`. explicit repair workspace, photo subresult omitted for Accountant.

### O39 ticket_expense

Keys: tickets.update AND exp.add. Source: `src/server/repairs.ts; src/server/vendor-repair.ts`. Actual: `saveRepairRecord postExpense/confirmVendorCost`. both keys; no photo/bearer inferred.

### O40 staff_photo

Keys: tickets.update AND native!=accountant. Source: `src/server/ticket-photos.ts; src/server/repairs.ts; ticket photo API routes`. Actual: `prepareTicketPhotoUpload/confirmTicketPhoto/readRepairPhoto/openTicketPhoto`. assigned+unassigned floor; checked byte proxy.

### O41 vendor_dispatch

Keys: tickets.update; native floor before mint. Source: `src/server/vendor-repair.ts; src/app/m/tickets/[id]/page.tsx`. Actual: `addVendor/dispatchVendor/revokeVendorJob/loadVendorDispatch`. text-only job view; no restricted mint/read/replay/attachment metadata.

### O42 vendor_share

Keys: tickets.update AND native!=accountant. Source: `src/server/vendor-repair.ts`. Actual: `approveVendorSharing/loadVendorDispatch sharing`. separate explicit operation; text save never[].

### O43 vendor_bearer

Keys: genuine actual job token. Source: `src/server/vendor-repair.ts; vendor-job photo API routes`. Actual: `loadVendorJob/findVendorPhoto/streamVendorPhoto/openVendorPhoto`. both modes; old copied token retirement; current proxies.

### O44 messages

Keys: messages.send. Source: `src/server/domain.ts; src/server/queries.ts; src/app/m/messages/page.tsx`. Actual: `listThreads/threadMessages/postMessage`. exact current in-app audience, no new file/export/send.

### O45 property_csv

Keys: props.view enrolled. Source: `src/app/api/export/route.ts; src/app/m/properties/page.tsx`. Actual: `GET properties.csv`. exact six fields, direct URL parity, no data.export/new route.

### O46 report_csv

Keys: reports.export. Source: `src/app/m/reports/export/route.ts; src/server/income-expense.ts`. Actual: `loadIncomeExpense/reportCsv`. same report/period fields only.

### O47 settings

Keys: settings.edit; governance separate. Source: `src/server/auth.ts; src/server/mail-settings.ts; src/app/m/settings/page.tsx; src/app/m/notify/page.tsx`. Actual: `setRequireMfa/setOwnerPrivacy/saveOrgMailSettings`. fixed current settings tuple; no provider/flags/legal/B016 expansion.

## raw

Do not globally redefine app.has_role/is_member. Assigned broad raw SELECT and ordinary protected writes deny; exact named safe projections/domain operations authorize existing supported17 functionality. Enforced native mandatory floors and serialized governance/link guards are NOT assignment-only. Unknown service identity does not get a native fallback. Genuine portal operations keep exact existing row-shape checks and cannot be invoked by canonical staff to escape restrictions. Column masking requires a fixed safe projection; row policies cannot hide phones/path bytes. Amend owner_lease_tenants member phone shortcut to effective staff vs genuine owner privacy, not a global role rewrite. Old public/definer/domain gateways and backend owner queries must be fenced or amended at the precise call groups below. No arbitrary caller role/action/table/session impersonation is an API. An enrolled operation lacking its exact bridge stays UNAVAILABLE, visibly incomplete, and blocks enrollment/all17 acceptance. Codex owns source design/body/app port; PE does actual target verification and approved nonMac application, not undefined design.

## package

The initial author package is CLOSED inactive SQL+MD: four private tables/two owner roles; recognized18/supported17 validators; effective/policy helpers; fixed role/member/invite commands and request receipts; org-serialized recovery-Admin invariant; S2/S3 photo/raw/audit policies; S4 explicit versioned owner/link/privacy functions; private bearer-retirement helper. Existing domain bodies are reused/ported only for the47 actual call groups below, never119 export wrappers. Add a fixed DB privilege bridge only where current RLS/ACL/owner admission requires it; do not wrap every pure query redundantly. Exact new function bodies/signatures/grants and altered old functions belong in the source/ACL manifest. A reviewed core foundation may be prepared first with management OFF, but is NOT enrollment/apply-ready/full B017 until remaining supported route ports are closed. No TODO assigning missing Codex source work to PE.

## rollout

Management flag defaults OFF: strict global enabled+org allowlist+org opt-in allows management only, never chooses permission semantics. Persisted enforced state/assignments remain sticky during kill/OFF/expiry/readiness loss; poisoned/missing role/schema/version fails affected access closed, never native broad fallback. Before enrollment old code+new schema with no assignments/OFF must match baseline. After assignments old base-only code/credentials must not run: verified deny/quarantine/current bridge before rollback; no assignment delete, unenrollment, guard disabling or table drop to roll back. Capture exact support/callsite/credential/token-fence evidence, candidate SHA, flags/restoration and actual target owner/ACL/history/backup/restore tests. No Mac parser/application/production/activation by this task.

## patches

1 Root reserves disconnected catalog/evaluator/source tests and core author paths after exact-v4 independent review. 2 Terra authors complete inactive SQL/MD/source/ACL manifest in writable workspace, including strict supported17 and all S1-S4 requirements; independent exact source review precedes target execution. 3 Reserve effective resolver and47 actual call groups in bounded shared-file rounds, keep B0181c and B016 untouched. Unsafe enrolled branches first fail closed, then each exact existing route gets its reused or necessary fixed bridge. 4 Preserve the two actual CSVs; eliminate export-only scaffolding. 5 Approved nonMac target schema/ACL/native/OFF/poison/floors/oldclient/rollback proof then app targets, exact clean gate/build/browser/restoration and required independent Claude/Class B/Ron acceptance. 6 Later separately authorized enrollment only after all17 positives/negatives and credential/bearer fence. 7 Finish in-hand capability/handoff; no B019+new work. No source reservation/runtime authority is granted by this report.

## acceptance

S1:18 recognized/17supported; disabled unavailable data.export; editor/API/DB/import/replay reject it; poisoned reference unavailable. All17 native baseline/full cross-base positive (Manager bank reconcile required), omitted key negative, write-selector vs bulk read, actual page/action/API/fixed RPC/file/raw/old-owner paths, stale/revoked identity/revisions and org/env/global hidden staff persona.
Governance: concurrent last-two Admin changes, self/indirect template edit, nativeAdmin floor-removal, deactivate/reinvite/accept/reactivate attack, default unassigned actor ceiling, billing owner, same-key changed intent and raw DELETE/cascade escape.
S2: Accountant+tickets.update both vendor modes/direct actions/HTML/RSC cannot mint/read/share/replay or obtain IDs/names/counts/link; text work preserves shares; copied old URL fails after retirement; genuine vendor retains job-scoped access; no messages. S3: assigned AND unassigned Accountant raw files/legacy content/own uploader/portal/sharing/identity-photo deny; safe finance remains usable; nativeAdmin full-audit positive vs nonAdmin custom deny. S4: custom false create positive; unauthorized true rolls back property/contact/invite/link; combined keys positive; native old true compatibility proof; exact per-link setter actual owner result; existing links/dates/flags preserved; missing vs explicit[]/stale/foreign link cases. Verify OFF/stickykill/oldcredential/token lifetimes/rollback on actual target. No runtime/staging/feature acceptance is asserted here.

## Source/proof limits

61 actual source files are pinned at b8 and compared with current HEAD and working bytes; JSON records drift. Exact input schemas reused from source remain bound, while export-specific proposals are superseded. Current target roles/ACL/schema/credentials/bearers and runtime acceptance are unverified. No product/SQL/runtime mutations performed.
