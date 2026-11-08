// Copy the migration files this branch adds or changes versus main into the
// staging artifact, and say whether each change is add-only.
// Add-only: new columns, defaults, triggers, or functions. A NOT NULL, a new
// constraint, a rewrite of existing behavior, or a privilege change is not.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyMigration } from "./migration-classification.mjs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "pr-migrations"));
const base = "2bedb895306726310252aac26f742baeaa6f3ea9";

/** Added files. Modified files are classified from their diff. */
const added = {
  "supabase/migrations/20261107150000_s3_bounded_share_locks.sql": {
    addOnly: false,
    reason: "BLK-MAC-17: adds two private invoker helpers (EXECUTE revoked from PUBLIC/anon/authenticated/service_role): app.lock_tables_bounded (bounded LOCK TABLE wait, lock_timeout max(2s, deadlock_timeout+1s), deadlock re-raised as 55P03) and app.lock_tables_nowait_retry (bounded NOWAIT retry, jittered, ~2s budget, never queues). Re-creates 28 existing functions from their current definitions with only their 37 single-shot table-level LOCK TABLE ... NOWAIT statements replaced: per statement, 29 use the bounded wait (first-lock platform_settings SHARE gateways and ACCESS SHARE/ROW EXCLUSIVE requests) and 8 use the NOWAIT retry (every SHARE request reachable after row/write locks: b017_old_source_insert, b017_occurrence_valid, b028_center_recipient_valid, b017_resolution_admit, b028_center_session, b013_owner_view's regional_defaults lock, and the flag helpers b028_delivery_enabled and b033_line_enabled reached from LINE push paths after row pins); fails closed on any count/ownership mismatch. A concurrent autovacuum/analyze or vacuum truncation is waited out (or retried past) instead of an immediate 55P03; a long holder still yields a bounded 55P03. Owners, grants, proconfig and row-level NOWAIT locks unchanged; the three B-010 polling functions keep NOWAIT. No table, column, flag or data change.",
  },
  "supabase/migrations/20261107151000_s3_b013_mutator_lock_timeout.sql": {
    addOnly: false,
    reason: "BLK-MAC-24: ALTER FUNCTION ... SET lock_timeout = '3s' on the six B-013 repair mutators (submit/decide/emergency/appointment session mutators from 20261107120000, vendor appointment and reminder), so a held parent row yields a bounded 55P03 instead of an unbounded wait. Bodies, owners, grants and search_path unchanged. No table, column, flag or data change.",
  },
  "supabase/migrations/20261107133000_b031_upload_recovery.sql": {
    addOnly: false,
    reason: "Adds private upload batch/item tables with NOT NULL columns, CHECK and unique constraints, RLS, restricted SECURITY DEFINER gateways and a default-OFF upload recovery flag. Old code does not read or write them.",
  },
  "supabase/migrations/20261107120000_b028_repair_context_integrity.sql": {
    addOnly: false,
    reason: "Drops and recreates the four B-013 session mutators (submit/decide/emergency/appointment) with (p_live, p_env) after p_org; bodies unchanged apart from a private actor helper binding the selected environment/live-org tuple and request principal, and a private photo helper requiring real owner-visible same-org/same-ticket photos. Adds a validated composite appointment->vendor-job (org_id, ticket_id, id) foreign key. Old callers of the dropped signatures fail. Same service_role grants; rollout defaults OFF.",
  },
  "supabase/migrations/20261107080000_b028_notification_event_producers.sql": {
    addOnly: false,
    reason: "New private notification event and recipient tables with NOT NULL, CHECK and composite org foreign keys, immutable triggers, service-only producer/message gateways, an internal shared delivery row write, an OFF->ON transition ledger with AFTER triggers on platform_settings/organizations (write only on delivery-flag ON transitions), CREATE OR REPLACE of b028_delivery_enqueue (same body, shared row write) and b028_delivery_claim (same body plus a stale producer-attempt sweep), and privilege revokes. Rollout defaults OFF.",
  },
  "supabase/migrations/20261107020000_b017_custom_role_governance.sql": {
    addOnly: false,
    reason: "B017 private role authority, immutable revisions, receipts, gated governance/member triggers and restrictive photo/audit RLS. Hosted compatibility remains unproved.",
  },
  "supabase/migrations/20261106140000_b020_tenant_account.sql": {
    addOnly: true,
    reason: "Seeds default-OFF tenant_account_settings; adds private app.b020_data_requests (one open request per kind) and tenant-scoped SECURITY DEFINER session list/revoke and data-request RPCs deriving user/org from auth.uid() and the pin; no existing-table change.",
  },
  "supabase/migrations/20261106130000_b019_tenant_thread_create.sql": {
    addOnly: true,
    reason: "Seeds default-OFF tenant_thread_create and adds a SECURITY DEFINER RPC letting an authorized lease tenant start the lease thread idempotently (existing one-per-lease index; first message id = request id); no table or grant change beyond the RPC.",
  },
  "supabase/migrations/20261106080000_prop04_consent_records.sql": {
    addOnly: true,
    reason: "Adds an authenticated-only SECURITY DEFINER reader of own consent evidence with pinned org/environment scope; no existing-table, writer, flag or backfill changes.",
  },
  "supabase/migrations/20261107060000_b005_unit_qr_signup.sql": {
    addOnly: false,
    reason: "New private unit QR contexts and pending applicants, constraints, RLS and service-only SECURITY DEFINER gateways with revoked direct access. Default OFF; no existing identity or lease entitlement changes.",
  },
  "supabase/migrations/20261106090000_b005_resend_results.sql": {
    addOnly: false,
    reason: "Private durable resend reservations, immutable terminal results, constrained SECURITY DEFINER gateways and revoked direct access; default-OFF simulation only. No existing invitation state is changed.",
  },
  "supabase/migrations/20261107070000_b030_usage_subscription_state.sql": {
    addOnly: false,
    reason: "Adds private plan/subscription/event/assignment tables with CHECK, foreign-key and uniqueness constraints, RLS and privilege revokes; grants role-specific gateway EXECUTE and installs an isolated assignment trigger on maintenance_tickets with audit-based recovery. Strict usage_subscriptions OFF; no real provider or restrictions.",
  },
  "supabase/migrations/20261106110000_b029_usage_events_flag.sql": {
    addOnly: true,
    reason: "Seeds default-OFF usage_events setting only; B-029 hooks use the existing PROP-07 recorder and store.",
  },
  "supabase/migrations/20261106100000_prop07_usage_source_ids.sql": {
    addOnly: true,
    reason: "Adds private append-only app.usage_events (source table/id, dedupe key, sandbox marker), an idempotent service-role SECURITY DEFINER recorder and an admin-only formal summary excluding sandbox; no hooks or callers, no flag (PROP-07 foundation for B-029).",
  },
  "supabase/migrations/20261106230000_b025_legacy_zero_history_seal.sql": {
    addOnly: false,
    reason: "Replaces the service-only legacy seal gateway so zero-history legacy business profiles read their seal from the live profile under the same grant/flag admission; versioned profiles are unchanged. No table, column, grant widening or flag activation.",
  },
  "supabase/migrations/20261106170000_b025_vendor_document_integrity.sql": {
    addOnly: false,
    reason: "Adds private immutable paper-scan siblings with RLS and service-only grant-scoped gateways; adds snapshot-reference guards without backfill or flag activation. Existing profile versions and PDF snapshots are reused.",
  },
  "supabase/migrations/20261106050000_b025_vendor_document_gate.sql": {
    addOnly: false,
    reason: "Adds private append-only vendor received marks, service-only grant-scoped gateways, a default-OFF flag and a receipt INSERT trigger enforcing full payment when enabled (changes legacy insert admission only while ON); no override, backfill or hosted activation.",
  },
  "supabase/migrations/20261106060000_b001_id_sign_gate_flag.sql": {
    addOnly: true,
    reason: "Seeds the default-OFF platform setting id_sign_gate_v2 for the two-level ID switches (B-001 / PROP-US-v03-01); no table, function or grant change; flag OFF keeps the existing ID hard gate.",
  },
  "supabase/migrations/20261107100000_b038_line_repair_pushes.sql": {
    addOnly: false,
    reason: "Additive private repair-push intent/cursor tables with CHECK constraints, RLS and full privilege revokes, service-only definer gateways and a default-OFF line_repair_push setting. Reads committed repair/approval rows only; no trigger, backfill or change to existing repair functions. Privilege revokes require Class B review.",
  },
  "supabase/migrations/20261107090000_b037_line_rent_pushes.sql": {
    addOnly: false,
    reason: "Adds private RLS/REVOKE ALL rent-push claim and evaluated-event tables with composite FKs and CHECK/UNIQUE constraints, seven service-only SECURITY DEFINER gateways plus four ungranted helpers, a same-body replacement of app.b033_push_expire (single-Email and suppression rules for B-037 claims) and a default-OFF line_rent_push setting. No backfill and no change to B-010 producers, B-028 claims or legacy email_log reminders; constraints, privilege revokes and the function replacement require Class B review.",
  },
  "supabase/migrations/20261107105000_b039_line_dispatch_pushes.sql": {
    addOnly: false,
    reason: "Additive private dispatch-event outbox (claim, announcement dependency, backoff) with constraints, RLS, six service-only pinned definer gateways plus an ungranted internal replay classifier (L2 decision pending Class B review); a validated CHECK on notifications constrains only the new vendor dispatch event types; default-OFF line_dispatch_push setting. No backfill or activation.",
  },
  "supabase/migrations/20261107085000_b035_line_vendor_claim.sql": {
    addOnly: false,
    reason: "Additive private job-flow extension with constraints, RLS, pinned definer guard and service-only grants; no existing identity/account data rewrite or activation.",
  },
  "supabase/migrations/20261107050000_b033_line_login_link.sql": {
    addOnly: false,
    reason: "Additive one-time flows, session provenance, private limits, portal gates and service-only LIFF/link gateways. Trusted links no longer require raw provider ids; configuration and privilege changes require Class B review.",
  },
  "supabase/migrations/20261107000000_b033_line_shared_foundation.sql": {
    addOnly: false,
    reason: "Additive LINE foundation with constrained private identity/flow/event/reservation tables, service-only quota usage and gateways, verified-link columns and guard, delivery dedupe, and default-OFF settings. No legacy identity backfill or live transport; constraints and privilege revokes require Class B review.",
  },
  "supabase/migrations/20261106235000_b028_notification_delivery_claims.sql": {
    addOnly: false,
    reason: "New private durable delivery tables with NOT NULL and CHECK constraints, append-only events, service-only gateways and privilege revokes. Existing producers unchanged; rollout defaults OFF.",
  },
  "supabase/migrations/20261106220000_b026_vendor_accounts.sql": {
    addOnly: true,
    reason: "Adds private vendor account invitations, links and immutable correction events, service-only gateways and default-OFF vendor_account setting. No backfill, public table/schema changes or existing function replacement.",
  },
  "supabase/migrations/20261106190000_b026_vendor_estimates.sql": {
    addOnly: false,
    reason: "Adds private immutable vendor estimate provenance, gateways and a default-OFF setting; guards on existing tables restrict scheduling/completion when a persisted estimate lacks approval. Code rollback is compatible for legacy tickets without estimates; persisted estimates remain guarded even with flags OFF, so rollback must preserve B-013 approval handling. No backfill or existing function replacement.",
  },
  "supabase/migrations/20261106231000_b026_closed_job_notification_read.sql": {
    addOnly: true,
    reason: "Adds a service-only sibling vendor notification gateway used only when the in-process vendor-link kill switch is ON; it delegates to app.b028_center_vendor unless the org is enhanced and the ticket closed, where reads are write-free and marks rejected. No table, column, existing function or flag change.",
  },
  "supabase/migrations/20261106070000_prop05_platform_settings_audit.sql": {
    addOnly: true,
    reason: "Adds an AFTER INSERT/UPDATE/DELETE audit trigger on platform_settings writing key/value/description changes to audit_log (PROP-05 override audit); no value, grant or behaviour change.",
  },
  "supabase/migrations/20261106232500_b027_ticket_photo_write_narrowing.sql": {
    addOnly: false,
    reason: "Narrows existing INSERT policies: photo-bucket file rows only for tickets.update roles; portal file/attachment inserts only for non-members; shared-photo id reads only for tickets.update roles. An old Accountant or staff-reporter insert of a ticket photo now fails.",
  },
  "supabase/migrations/20261106232000_b027_ticket_photo_member_read.sql": {
    addOnly: false,
    reason: "Narrows existing member SELECT policies: ticket-photo bucket files and ticket_attachments rows become readable only by tickets.update roles (admin/manager/maintenance); the tenant portal attachment policy keeps only its tenant half. Adds one authenticated definer count function. An old Accountant query reading photo rows now returns no rows.",
  },
  "supabase/migrations/20261106200000_b027_partner_consent_gate.sql": {
    addOnly: false,
    reason: "Adds an OFF consent gate and empty per-company approval setting, a private evidence validator and a guarded replacement of the existing partner-control writer; reuses append-only consents, no legal text/version or allowlist changes.",
  },
  "supabase/migrations/20261106180000_b027_partner_controls.sql": {
    addOnly: true,
    reason: "Adds private partner overrides and immutable events, scoped SECURITY DEFINER read/admin gateways, and two default-OFF settings; no existing grants or production allowlists change.",
  },
  "supabase/migrations/20261021150000_revoke_purge_execute.sql": {
    addOnly: false,
    reason: "REVOKE EXECUTE on purge_due_identity_documents. No column or constraint. service_role keeps EXECUTE.",
  },
  "supabase/migrations/20261022180000_tenant_id_check.sql": {
    addOnly: false,
    reason: "New ID tables, NOT NULL columns, CHECK constraints, a dropped column, triggers, and REVOKE EXECUTE on the six ID helpers. An old insert that omits the new columns or writes verified_by would fail.",
  },
  "supabase/migrations/20261022200000_tenant_id_check_upgrade.sql": {
    addOnly: false,
    reason: "Same ID shape for a database that already ran an earlier copy: NOT NULL, CHECK, dropped functions, a unique index, and the same EXECUTE revokes.",
  },
  "supabase/migrations/20261024100000_revoke_truncate.sql": {
    addOnly: false,
    reason: "REVOKE TRUNCATE from anon and authenticated. No column or constraint. Row DML grants stay.",
  },
  "supabase/migrations/20261025120000_id_consent_notice.sql": {
    addOnly: true,
    reason: "Adds nullable consent_notice_sha256. No default, NOT NULL, or constraint.",
  },
  "supabase/migrations/20261025140000_id_upload_slots.sql": {
    addOnly: false,
    reason: "New id_upload_slots table with NOT NULL columns and CHECK constraints. Old code does not write this table.",
  },
  "supabase/migrations/20261026150000_id_upload_slots_revoke_anon.sql": {
    addOnly: false,
    reason: "REVOKE ALL on id_upload_slots from anon. No column or constraint.",
  },
  "supabase/migrations/20261026160000_id_consent_display_sha.sql": {
    addOnly: true,
    reason: "Adds nullable consent_full_text_sha256 and consent_upload_text_sha256. No default or constraint.",
  },
  "supabase/migrations/20261027120000_id_consent_shown_sha.sql": {
    addOnly: true,
    reason: "Adds the same two nullable sha256 columns when the earlier filename was skipped. No default or constraint.",
  },
  "supabase/migrations/20261027140000_id_anon_revoke.sql": {
    addOnly: false,
    reason: "REVOKE table grants and EXECUTE on the mask and dedupe helpers from anon and authenticated. No column or constraint.",
  },
  "supabase/migrations/20261028120000_id_delete_after_consent.sql": {
    addOnly: false,
    reason: "Replaces id_document_delete_after and rewrites delete_after on live rows. No new NOT NULL or table constraint.",
  },
  "supabase/migrations/20261029130000_id_no_direct_mutate.sql": {
    addOnly: false,
    reason: "REVOKE UPDATE and DELETE on the id tables from PUBLIC, anon, and authenticated. Replaces iddoc_team with a SELECT-only policy. Adds SECURITY DEFINER photo functions and REVOKEs them from anon and authenticated. No new NOT NULL or constraint.",
  },
  "supabase/migrations/20261029140000_id_consent_shown_version.sql": {
    addOnly: true,
    reason: "Adds nullable consent_notice_sha and consented_at. No default, NOT NULL, or constraint. An old insert that omits them still works.",
  },
  "supabase/migrations/20261029150000_id_watermark_copy.sql": {
    addOnly: false,
    reason: "New id_document_wm_objects table uses NOT NULL columns. Replaces id_photo_open so a signed read returns the watermarked copy, and replaces purge_due_identity_documents so both ciphertext objects are deleted. No new constraint on existing tables. An old photo insert that omits the watermarked object still succeeds.",
  },
  "supabase/migrations/20261029160000_lease_close_end_date.sql": {
    addOnly: true,
    reason: "BEFORE trigger fills a null end_date when a lease becomes terminated or cancelled. An end date that is already set stays. No NOT NULL and no new constraint.",
  },
  "supabase/migrations/20261030100000_lock_public_function_execute.sql": {
    addOnly: false,
    reason: "Replaces post_reversal and fn_invoice_recalc with a caller-org check and REVOKEs EXECUTE on trigger and utility functions. Privilege change and a rewrite of existing function bodies.",
  },
  "supabase/migrations/20261030110000_gotrue_confirm_single_use.sql": {
    addOnly: false,
    reason: "New gotrue_confirm_uses table with a NOT NULL primary key, plus REVOKE ALL from PUBLIC, anon, and authenticated.",
  },
  "supabase/migrations/20261030120000_org_scoped_reversal_audit.sql": {
    addOnly: false,
    reason: "Replaces both post_reversal overloads so a cross-org call raises 42501, and replaces app.audit_event to record the session org. Rewrite of existing function bodies.",
  },
  "supabase/migrations/20261030130000_default_function_privileges.sql": {
    addOnly: false,
    reason: "ALTER DEFAULT PRIVILEGES revokes EXECUTE on future public functions from PUBLIC, anon, and authenticated. Privilege change. No existing function body changes.",
  },
  "supabase/migrations/20261030140500_revoke_app_is_member_execute.sql": {
    addOnly: false,
    reason: "REVOKE EXECUTE on app.is_member from PUBLIC and anon. authenticated and service_role keep EXECUTE. Privilege change.",
  },
  "supabase/migrations/20261030150000_revoke_id_photo_lease_close_execute.sql": {
    addOnly: false,
    reason: "REVOKE EXECUTE on fn_id_photo_drop_wm and fn_lease_close_end_date from PUBLIC, anon, and authenticated when those trigger functions exist. Privilege change. Trigger firing is unchanged.",
  },
  "supabase/migrations/20261030150200_vendor_repair.sql": {
    addOnly: false,
    reason: "Creates vendor job and secret tables with constraints and RLS, adds an attachment foreign key, and changes table and function privileges.",
  },
  "supabase/migrations/20261030150300_repair_owner_visibility.sql": {
    addOnly: false,
    reason: "Replaces ticket visibility and income-expense report functions and changes helper execution privileges.",
  },
  "supabase/migrations/20261030150400_ticket_job_type_reserve.sql": {
    addOnly: false,
    reason: "Adds nullable job_type_code and NOT NULL type_fields with a default to maintenance tickets.",
  },
  "supabase/migrations/20261030150500_revoke_public_function_execute.sql": {
    addOnly: false,
    reason: "Revokes PUBLIC execution and grants execution to authenticated and service_role on app helpers.",
  },
  "supabase/migrations/20261030150600_consents.sql": {
    addOnly: false,
    reason: "Creates a constrained consent table with RLS and restricted privileges, append-only triggers, and a consent backfill.",
  },
  "supabase/migrations/20261030150700_vendor_link_sharing_approval.sql": {
    addOnly: false,
    reason: "Adds a check constraint, unique indexes and a constrained shared-photo table with RLS and privilege changes.",
  },
  "supabase/migrations/20261030150800_vendor_onboarding_job_types_receipts.sql": {
    addOnly: false,
    reason: "Creates constrained vendor and job-type tables, seeds catalog data, adds and validates foreign-key and check constraints, and changes privileges.",
  },
  "supabase/migrations/20261030150801_vendor_document_service.sql": {
    addOnly: false,
    reason: "Creates constrained vendor-document grant and PDF tables, changes privileges, and installs immutability triggers.",
  },
  "supabase/migrations/20261030150802_vendor_job_assignment.sql": {
    addOnly: false,
    reason: "Creates a constrained sharing-history table and privileges, and adds triggers that revoke assignments and delete shared-photo projections.",
  },
  "supabase/migrations/20261030150900_esign_core.sql": {
    addOnly: false,
    reason: "Creates constrained e-sign tables with RLS and privilege changes, and adds guards including a lease retention trigger.",
  },
  "supabase/migrations/20261030151100_end_auth_sessions_varchar_fix.sql": {
    addOnly: false,
    reason: "Replaces the auth-session termination function and restricts its execution privileges.",
  },
  "supabase/migrations/20261030151200_id_purge_dry_run_guard.sql": {
    addOnly: false,
    reason: "Changes retention defaults and functions, updates existing document retention dates, and changes purge function privileges.",
  },
  "supabase/migrations/20261030151300_partner_agreement_consents.sql": {
    addOnly: false,
    reason: "Creates a constrained partner-consent table with RLS, restricted privileges and append-only triggers.",
  },
  "supabase/migrations/20261030151301_partner_consent_attestation.sql": {
    addOnly: false,
    reason: "Adds attestation columns and NOT VALID check constraints enforced on new writes.",
  },
  "supabase/migrations/20261030151400_tenant_signed_pdf_read.sql": {
    addOnly: false,
    reason: "Adds a tenant read policy and a gated helper with execution privileges restricted to selected roles. Re-run keeps that policy and helper.",
  },
  "supabase/migrations/20261030151500_paper_lease_versions.sql": {
    addOnly: false,
    reason: "Adds unique, check and foreign-key constraints to signed PDFs and restricts execution of the audit trigger helper. Re-run keeps those constraints and the helper.",
  },
  "supabase/migrations/20261030151600_esign_retention_lifecycle.sql": {
    addOnly: false,
    reason: "Creates constrained retention tables and privilege rules, replaces a retention guard and adds a gated disposal function.",
  },
  "supabase/migrations/20261031090000_id_delete_after_move_out.sql": {
    addOnly: false,
    reason: "Adds a move-out date, replaces the retention function and privileges, and updates existing document retention dates.",
  },
  "supabase/migrations/20261031100000_payee_details.sql": {
    addOnly: false,
    reason: "Adds payee columns, a protected account table, RLS policies, grants and triggers; requires catalog and compatibility review.",
  },
  "supabase/migrations/20261031100100_audit_action_select.sql": {
    addOnly: false,
    reason: "Extends an existing audit enum; requires a committed transaction before dependent migration and compatibility review.",
  },
  "supabase/migrations/20261031100200_tenant_payee_read.sql": {
    addOnly: false,
    reason: "Creates a security-definer function and grants execution; the following hardening migration revokes direct access.",
  },
  "supabase/migrations/20261031100201_b001_esign_internal_helpers.sql": {
    addOnly: false,
    reason: "Creates app-schema context, case, version and audit helpers with organization and environment scoping, repoints SELECT policies, and revokes public-helper execution from PUBLIC, anon, and authenticated.",
  },
  "supabase/migrations/20261031100202_b003_payee_gateway.sql": {
    addOnly: false,
    reason: "Revokes direct table and function privileges, adds assignment guard and service-only audited gateway; requires access and compatibility review.",
  },
  "supabase/migrations/20261031100203_b002_retention_boundary.sql": {
    addOnly: false,
    reason: "Adds nullable database-owned lease provenance and guards; replaces retention, protected photo access, preview and purge functions, and restricts privileges. Enforces fixed policy, transaction ordering and destructive mode boundary. No historical file, original dates, table, column or data is deleted.",
  },
  "supabase/migrations/20261031100204_b004_paper_delivery_boundary.sql": {
    addOnly: false,
    reason: "Replaces tenant PDF visibility helper and adds immutable-version mutation guards with controlled parent-cascade exceptions and privilege changes. Re-run keeps that helper and guard. No historical migration or contract text is changed.",
  },
  "supabase/migrations/20261031100205_b007_deposit_rules.sql": {
    addOnly: false,
    reason: "Ron authorized replacing only leases_deposit_over_cap_requires_override for local/staging. Replaces write enforcement with regional resolution and flag locks, adds metadata guards/functions/privileges and default-OFF rollout setting; no historical SQL, stored data or columns removed.",
  },
  "supabase/migrations/20261031100206_b002_legacy_open_moveout.sql": {
    addOnly: false,
    reason: "Replaces only the database-owned provenance trigger function to recognize a newly observed move-out on an older active open lease. Preserves unknown closed cases, ACLs and published SQL; no data/date backfill or columns removed.",
  },
  "supabase/migrations/20261031100207_b005_onboarding_progress.sql": {
    addOnly: false,
    reason: "Adds default-OFF rollout setting and server-owned onboarding metadata guard/trigger with privilege restrictions; changes authorization for a settings subtree without deleting data or columns.",
  },
  "supabase/migrations/20261031100208_b008_billing_previews.sql": {
    addOnly: false,
    reason: "Seeds a default-OFF guarded billing-preview rollout setting without changing stored invoice amounts or regional formulas.",
  },
  "supabase/migrations/20261031100209_b009_bank_match_decisions.sql": {
    addOnly: false,
    reason: "Adds exact-file source registry and immutable decision tables/constraints plus owner-only gated bank-link write guards, permissions and default-OFF setting. No historical rewrite or duplicate-data backfill.",
  },
  "supabase/migrations/20261031100210_b008_first_period_basis.sql": {
    addOnly: false,
    reason: "Adds nullable versioned first-period source with trusted capture and signing/actor guards, restricted execution and no historical backfill. Existing unknown sources remain legacy full-rent; no data or columns removed.",
  },
  "supabase/migrations/20261031100211_b001_esign_activation.sql": {
    addOnly: false,
    reason: "Adds private transaction-only completion requirements, early parent-lock guard triggers and deferred financial/actor postcondition; restricts helper/table privileges and checks duplicate first invoices. Index creation is moved to 20261031100216, applied outside a transaction; already-applied staging copies retain their index.",
  },
  "supabase/migrations/20261031100212_b010_b028_local_events.sql": {
    addOnly: false,
    reason: "Adds default-OFF private local notification and payment-transition tables with constraints, restricted gateways, deferred financial/event guards and legacy-writer fences; due-email personal preference alone defaults ON. No external delivery or historical backfill.",
  },
  "supabase/migrations/20261031100213_b001_zero_first_invoice.sql": {
    addOnly: false,
    reason: "Replaces only the deferred completion financial postcondition to support Ron-approved explicit zero-total first invoice with no ledger transaction, entries or payment allocations and actual-actor no_amount_due audit; preserves positive branch; has no dependency on the b001 move-in invoice index (built concurrently in 20261031100216).",
  },
  "supabase/migrations/20261031100214_b011_handover_records.sql": {
    addOnly: false,
    reason: "Adds default-OFF private versioned handover/evidence/reply/upload-intent and durable cleanup tables with composite constraints, restricted privileges and immutable guards. No historical migration or financial/retention date rewritten.",
  },
  "supabase/migrations/20261031100215_b028_center_foundation.sql": {
    addOnly: false,
    reason: "Adds independent default-OFF private typed notification center events/entitlements/read markers/cursors and restricted authorization gateways, immutable/source guards and deferred expiry checks; no producer grant or historical backfill.",
  },
  "supabase/migrations/20261031100216_b001_invoices_index_concurrently.sql": {
    addOnly: false,
    reason: "Enforces live move-in invoice uniqueness with a concurrent partial unique index, duplicate preflight and invalid-index retry cleanup. Requires psql without a transaction wrapper; preserves an existing valid staging index.",
  },
  "supabase/migrations/20261031100217_b010_b028_source_foundation.sql": {
    addOnly: false,
    reason: "Adds private typed-source/provenance/resolution tables, extends the exact center source constraint and replaces guards/read predicates with backward-compatible typed branches; changes owner-only functions and grants no new application source authority. Existing source bytes unchanged; no backfill or production activation.",
  },
  "supabase/migrations/20261031100218_b015_tenant_directory_edit.sql": {
    addOnly: false,
    reason: "Adds a default-OFF private hash-only contact-edit command table, scoped cascade constraints, immutable and deferred authorization guards, and fixed service-only edit/view/status/close/final-check gateways with restricted grants. No legacy contact, login identity, historical source or financial rows are rewritten.",
  },
  "supabase/migrations/20261031100220_b013_owner_repair_policy.sql": {
    addOnly: false,
    reason: "New private owner-policy roots, immutable revisions and command tables with NOT NULL/CHECK/FK constraints and restricted service-only functions. Existing property override values are retained unchanged; no public repair workflow trigger or estimate/dispatch authority. Default-OFF platform control and explicit authorized default-change audit only."
  },
  "supabase/migrations/20261031100221_b013_owner_repair_override.sql": {
    addOnly: false,
    reason: "Adds restricted service-only property-override change/status/close/final-check functions using the existing public column and private immutable revision/command tables. Changes restricted privileges and the explicit authorized write path; no historical values rewritten, new tables, public workflow triggers or estimate approval/dispatch authority."
  },
  "supabase/migrations/20261031100222_b004_reason_no_pii.sql": {
    addOnly: false,
    reason: "Rejects email-shaped and long digit-run replacement reasons and records only a safe reason on the replacement audit. Existing safe reasons stay. No column removed.",
  },
  "supabase/migrations/20261031100223_b004_reason_codes.sql": {
    addOnly: false,
    reason: "Restricts replacement reasons to a fixed code set and records only that code on the replacement audit. A non-code row stops the migration. The zero-row update to other changes nothing. No column removed.",
  },
  "supabase/migrations/20261104120300_b010_flag_first_locks.sql": {
    addOnly: false,
    reason: "Check B-010 rollout flags before locks and bound enabled-path lock retries.",
  },
  "supabase/migrations/20261031100224_b004_archived_lease_signed_pdf.sql": {
    addOnly: false,
    reason: "Rejects a new signed PDF when the lease property, unit, or room is archived. The check runs before insert, so no version row or replacement audit is written. Re-run keeps the same guard.",
  },
  "supabase/migrations/20261031100225_b009_decision_reason_codes.sql": {
    addOnly: false,
    reason: "Restricts bank-match decision reasons to a fixed code set and rewrites any other stored reason to other. The append-only trigger is restored after that rewrite. Re-run keeps the same check.",
  },
  "supabase/migrations/20261104120000_b007_deposit_fixes.sql": {
    addOnly: false,
    reason: "Replaces resolve_deposit_rule, fn_lease_deposit_check and app.b007_lock_deposit_policy to preserve legacy deposit compatibility and bound policy lock waits. No columns or constraints changed; old Worker compatible.",
  },
  "supabase/migrations/20261104120100_b002_retention_compat.sql": {
    addOnly: false,
    reason: "Restores legacy nullable photo-gate arguments with explicit scope checks, backfills known fixed-term retention origins, and extends origin capture for later end-date edits. Rewrites functions and existing rows; unknown closed origins remain held.",
  },
  "supabase/migrations/20261104120200_b005_invitations_audit_mask.sql": {
    addOnly: false,
    reason: "Replaces the invitations audit trigger function; no table/column change; old Worker compatible.",
  },
  "supabase/migrations/20261104120400_b009_bank_match_owner.sql": {
    addOnly: false,
    reason: "Bank-match direct-write guard trusts only the table-owner login without role switch; no table/column change; old Worker compatible.",
  },
  "supabase/migrations/20261105120500_prop09_deposit_settlement.sql": {
    addOnly: false,
    reason: "Adds private deposit settlement header/line/evidence/confirmation/payment tables with RLS, restricted service_role grants and composite FKs; no flag seed; no historical rewrite.",
  },
  "supabase/migrations/20261106010000_b009_bank_match_decisions.sql": {
    addOnly: true,
    reason: "Adds private row-identity registry for overlapping CSV re-import dedupe, request-id replay columns and one-effective-match unique indexes on bank decisions. Additive; no backfill; bank_matching stays OFF.",
  },
  "supabase/migrations/20261105140000_b011_deposit_settlement_writers.sql": {
    addOnly: false,
    reason: "Tightens deposit_settlement_* with same-lease charge FK, same-settlement evidence FK, payment request_id idempotency, revisions table, and deposit_settlement flag seed OFF; no historical rewrite.",
  },
  "supabase/migrations/20261105160000_prop11_repair_cost_foundation.sql": {
    addOnly: false,
    reason: "Adds six private repair cost and tenant due component tables with RLS, service_role SELECT/INSERT plus column-level UPDATE (no DELETE), and org-scoped FKs; statement-line reference is soft with consumer org checks required; no flag seed, existing-table changes or money movement.",
  },
  "supabase/migrations/20261105170000_b013_repair_approval_state.sql": {
    addOnly: false,
    reason: "Adds seven private app.b013_* repair approval state tables (immutable history, RLS, REVOKE ALL incl. service_role) and service-only SECURITY DEFINER gateways that fail closed while repair_approvals/vendor_dispatch are OFF; no flag seed, existing-table changes or money movement.",
  },
  "supabase/migrations/20261105180000_b021_repair_approval_reads.sql": {
    addOnly: false,
    reason: "Adds three service-only SECURITY DEFINER readers with org/environment/session scope and flag-OFF empty results, plus a private appointment-to-job org/ticket invariant trigger; no tables, table grants, flag seed or money movement.",
  },
  "supabase/migrations/20261105190000_b024_vendor_completion_reason.sql": {
    addOnly: false,
    reason: "Adds immutable appointment response_reason checks, replaces the staff signature with a trailing default, and adds a service-only token-scoped vendor gateway with replay and flag-OFF rejection; no table grants, flag seeds or ticket status changes.",
  },
  "supabase/migrations/20261107170000_s3_b026_photo_refs.sql": {
    addOnly: false,
    reason: "CREATE OR REPLACE of app.b026_submit_vendor_estimate (same signature, owner, SECURITY DEFINER, search_path, grants); the stored evidence check now calls the private B-028 app.b028_repair_photo_refs (same org/ticket, private-bucket file, not internal) instead of the shape-only app.b013_photo_refs. Vendor-job allowlist and its 42501 precedence unchanged; no table, column, flag or grant change; old Worker compatible.",
  },
  "supabase/migrations/20261107160000_s3_contacts_user_id_guard.sql": {
    addOnly: false,
    reason: "Adds a private SECURITY DEFINER trigger on contacts that refuses anon/authenticated changes to user_id except attaching a passwordless login created in the same transaction (createLease); no table, column, grant or flag change; old Worker compatible.",
  },
  "supabase/migrations/20261106000000_b008_monthly_rent_operation.sql": {
    addOnly: false,
    reason: "Adds private app.b008 monthly rent occurrence/command tables with RLS, revokes and service-only access; seeds a default-OFF platform setting, no feature-flag seed or existing-table schema changes; writer stays dual-gated OFF.",
  },
  "supabase/migrations/20261106120000_prop06_recipient_channels.sql": {
    addOnly: true,
    reason: "Adds a staff-only, pinned-scope SECURITY DEFINER read reporting a recipient contact's portal kind and channel availability (e-mail, in-app, LINE bound/friend) without addresses or LINE ids; no writes, flag or callers (PROP-06 foundation).",
  },
  "supabase/migrations/20261106040000_b022_owner_title_report_replies.sql": {
    addOnly: true,
    reason: "Adds private append-only owner receipt-title revisions and report replies, authenticated SECURITY DEFINER gateways and two default-OFF settings; no existing-table schema changes or backfill. Title RPC updates only the caller owner contact receipt_title.",
  },
  "supabase/migrations/20261106030000_b014_owner_net_ledger.sql": {
    addOnly: true,
    reason: "Adds private append-only statement versions and mock report delivery events, authenticated SECURITY DEFINER gateways and two default-OFF platform settings; no existing-table schema or function changes.",
  },
  "supabase/migrations/20261106160000_b028_legacy_claim_invoice_fence.sql": {
    addOnly: false,
    reason: "Replaces only the legacy email_log fence trigger function to take a leading invoice FOR KEY SHARE lock on rent-overdue claims (any rollout state), serializing them with the new-owner paths that lock the invoice FOR UPDATE; no table, column, grant, flag or data change; old Worker compatible.",
  },
  "supabase/migrations/20261106020000_b010_payment_result_events.sql": {
    addOnly: true,
    reason: "Adds private lease collector reserve and append-only one-per-payment confirmation audit (CAP-M-35 proxy-owner confirm), nullable source-event dedupe/source metadata, and context-checked SECURITY DEFINER collector/record/audit functions; no table grants, backfill or flag seed; payment_results_v2 stays OFF.",
  },
};

const functions = [
  ["dedupe_live_identity_documents", "()", "no", "migrations and service_role only", ""],
  ["fn_id_access_log_guard", "()", "no", "trigger; ID deletes run as service_role", "pg_catalog, public"],
  ["fn_id_document_allow_log_delete", "()", "no", "trigger on identity_documents delete", ""],
  ["fn_id_number_masked", "()", "no", "trigger; inserts run as service_role", ""],
  ["id_document_keep_days", "()", "no", "called by security-definer id_document_delete_after", ""],
  ["id_number_stored_mask", "(text)", "no", "masking in the request path is application code", ""],
];

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function hasCommit(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function livePrivileges() {
  const sql = `SELECT p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' ||
       has_function_privilege('public', p.oid, 'execute') || '|' ||
       has_function_privilege('anon', p.oid, 'execute') || '|' ||
       has_function_privilege('authenticated', p.oid, 'execute') || '|' ||
       has_function_privilege('service_role', p.oid, 'execute') || '|' ||
       coalesce((SELECT split_part(cfg, '=', 2) FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'), '')
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = ANY (ARRAY['dedupe_live_identity_documents','fn_id_access_log_guard','fn_id_document_allow_log_delete','fn_id_number_masked','id_document_keep_days','id_number_stored_mask'])
 ORDER BY 1`;
  try {
    const url = process.env.DATABASE_URL;
    if (!url) return "";
    return execFileSync("psql", ["-X", url, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

mkdirSync(outDir, { recursive: true });

const intended = [
  "# ID function EXECUTE",
  "",
  "Staging reported anon can execute all six. The revoke is in `20261022180000_tenant_id_check.sql` and `20261022200000_tenant_id_check_upgrade.sql`, the migration that creates the functions.",
  "`fn_id_access_log_guard` is SECURITY DEFINER with `SET search_path = pg_catalog, public`.",
  "authenticated is not needed: no request path calls these as `authenticated`.",
  "",
  "| function | signature | PUBLIC | anon | authenticated | service_role | authenticated needed | proconfig search_path |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...functions.map(([name, signature, needed, why, searchPath]) => `| ${name} | ${signature} | no | no | no | yes | ${needed} — ${why} | ${searchPath || "(none)"} |`),
  "",
].join("\n");

let liveNote = "Live database check was not run (no local functions, or no database).";
const live = livePrivileges();
if (live) {
  const rows = live.split("\n").filter(Boolean).map((line) => line.split("|"));
  const granted = (value) => value === "t" || value === "true";
  if (rows.length === 6) {
    const open = rows.filter((row) => granted(row[2]) || granted(row[3]) || granted(row[4]) || !granted(row[5]));
    if (open.length > 0) {
      console.error("id function execute grants are still open:");
      console.error(open.map((row) => row.join("|")).join("\n"));
      process.exit(1);
    }
    liveNote = [
      "Live `has_function_privilege` at pack time:",
      "",
      "| function | signature | PUBLIC | anon | authenticated | service_role | proconfig search_path |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map((row) => `| ${row[0]} | (${row[1]}) | ${granted(row[2]) ? "yes" : "no"} | ${granted(row[3]) ? "yes" : "no"} | ${granted(row[4]) ? "yes" : "no"} | ${granted(row[5]) ? "yes" : "no"} | ${row[6] || "(none)"} |`),
      "",
    ].join("\n");
  }
}
writeFileSync(path.join(outDir, "PERMISSIONS.md"), `${intended}\n${liveNote}\n`);

if (!hasCommit(base)) {
  writeFileSync(
    path.join(outDir, "MANIFEST.md"),
    `# PR migrations\n\nBase commit \`${base}\` is not in this clone, so the file list was not computed.\n\nadd-only: not computed.\n`,
  );
  process.exit(0);
}

const nameStatus = git(["diff", "--name-status", base, "HEAD", "--", "supabase/migrations"]);
const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "supabase/migrations"])
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".sql"));

const entries = [];
for (const line of nameStatus.split("\n")) {
  if (!line.trim()) continue;
  const parts = line.split("\t");
  const status = parts[0];
  const file = status.startsWith("R") ? parts[2] : parts[1];
  if (!file?.endsWith(".sql")) continue;
  entries.push({ status: status.startsWith("R") ? "R" : status, file });
}
for (const file of untracked) {
  if (!entries.some((entry) => entry.file === file)) entries.push({ status: "A", file });
}
entries.sort((a, b) => a.file.localeCompare(b.file));

const rows = [];
for (const entry of entries) {
  const baseName = path.basename(entry.file);
  if (entry.status !== "D") copyFileSync(path.join(root, entry.file), path.join(outDir, baseName));
  const diff = entry.status === "M" || entry.status === "R"
    ? git(["diff", "--unified=0", base, "HEAD", "--", entry.file]) : "";
  let classification;
  try {
    classification = classifyMigration(entry.status, diff, added[entry.file]);
  } catch (error) {
    console.error(`${error.message} for ${entry.file}`);
    process.exit(1);
  }
  rows.push({
    file: baseName,
    change: entry.status,
    addOnly: classification.addOnly ? "yes" : "no",
    reason: classification.reason,
  });
}

const head = git(["rev-parse", "HEAD"]).trim();
const manifest = [
  "# PR migrations vs main 2bedb895",
  "",
  `Head \`${head}\`. Base \`${base}\`.`,
  "",
  "Add-only means the change only adds columns, defaults, triggers, or functions. A NOT NULL, a new constraint old code would reject, a rewrite of existing rows or functions, or a privilege change is not add-only.",
  "",
  "| file | change | add-only | why |",
  "| --- | --- | --- | --- |",
  ...rows.map((row) => `| ${row.file} | ${row.change} | ${row.addOnly} | ${row.reason} |`),
  "",
  `${rows.length} files. ${rows.filter((row) => row.addOnly === "yes").length} add-only.`,
  "",
].join("\n");
writeFileSync(path.join(outDir, "MANIFEST.md"), manifest);
