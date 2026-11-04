import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { depositCapSaveAllowed, depositExceedsCap, depositReasonEditorOpen, depositReasonOk, depositWarnFlag, isSignedPdf, leaseTermEnd, leaseTermsEditable, normalizeIdempotencyKey, normalizeLineId, normalizePhone, overlappingLease, signedPdfName } from "./lease-rules";

test("a deposit over two months of rent needs a typed reason", () => {
  assert.equal(depositExceedsCap(2), false);
  assert.equal(depositExceedsCap(2.01), true);
  assert.equal(depositExceedsCap(Number.NaN), false);
  assert.equal(depositReasonOk(2, ""), true);
  assert.equal(depositReasonOk(3, ""), false);
  assert.equal(depositReasonOk(3, "   "), false);
  assert.equal(depositReasonOk(3, "屋主同意兩個月以上押金"), true);
  assert.equal(depositCapSaveAllowed(3, "warn", true), true);
  assert.equal(depositCapSaveAllowed(3, "warn", false), false);
  assert.equal(depositCapSaveAllowed(3, "block", true), false);
  assert.equal(depositCapSaveAllowed(3, "overridden", true), true);
  assert.equal(depositCapSaveAllowed(3, "overridden", false), false);
  assert.equal(depositCapSaveAllowed(3, "pass", true), false);
  assert.equal(depositCapSaveAllowed(3, null, true), false);
  assert.equal(depositCapSaveAllowed(1.5, "warn", false), true);
  assert.equal(leaseTermsEditable({ status: "pending_signature", esign: "sent", signed: false }), true);
  assert.equal(leaseTermsEditable({ status: "active", esign: "fully_signed", signed: true }), false);
  assert.equal(leaseTermsEditable({ status: "pending_signature", esign: "partially_signed", signed: false }), false);
  assert.equal(leaseTermsEditable({ status: "draft", esign: "imported", signed: false }), false);
  assert.equal(leaseTermsEditable({ status: "active", esign: "imported", signed: false }), false);
  assert.equal(depositWarnFlag(3, "warn"), false);
  assert.equal(depositWarnFlag(1.5, "warn"), true);
  assert.equal(depositWarnFlag(2, "pass"), false);
  assert.equal(depositReasonEditorOpen("4", "4.00"), false);
  assert.equal(depositReasonEditorOpen("4", "3"), true);
  assert.equal(depositReasonEditorOpen("2", "4"), false);
  assert.equal(depositReasonEditorOpen("", "3"), false);
});

test("create and edit lease screens ask for a reason with lease_deposit_over", () => {
  const wizard = readFileSync(new URL("../components/lease-wizard.tsx", import.meta.url), "utf8");
  const edit = readFileSync(new URL("../components/lease-terms-form.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/m/leases/[id]/page.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/flows/[action]/route.ts", import.meta.url), "utf8");
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  const domain = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  for (const source of [wizard, edit]) {
    assert.match(source, /lease_deposit_over/);
    assert.match(source, /<textarea/);
    assert.match(source, /data-testid="deposit-reason"/);
    assert.equal(source.includes("房東"), false);
  }
  assert.match(route, /createLease: \(session, body\) => createLease\(session, body as never\)/);
  assert.match(route, /updateLease: \(session, body\) => updateLease\(session, body as never\)/);
  assert.match(actions, /createLeaseFromForm\(session, formData\)/);
  assert.match(actions, /updateLease\(session,/);
  assert.match(actions, /revalidatePath\(`\/m\/leases\/\$\{leaseId\}`\)/);
  assert.match(wizard, /claimFormSubmit\(submitGuard\)/);
  assert.match(wizard, /callSubmitAction\(\s*submitGuard/);
  assert.match(wizard, /errors\.leaseNetwork/);
  assert.match(wizard, /ensureIdempotencyKey\(idempotencyKey\)/);
  assert.match(wizard, /name="idempotencyKey"/);
  assert.match(wizard, /overlappingLease\(room\?\.leases, start, termEnd\)/);
  assert.match(wizard, /data-testid="lease-error"/);
  assert.match(wizard, /role="alert"/);
  assert.match(actions, /leaseHref: `\/m\/leases\/\$\{created\.leaseId\}\?created=1/);
  assert.match(actions, /notice\.set\("utility", "kept"\)/);
  assert.match(actions, /notice\.set\("bill", "kept"\)/);
  const leasePage = readFileSync(new URL("../app/m/leases/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(leasePage, /data-testid="utility-run-kept"/);
  assert.match(leasePage, /data-testid="utility-bill-kept"/);
  assert.match(domain, /\$\{openRunSql\} FOR UPDATE/);
  assert.match(domain, /ON CONFLICT \(meter_id, period_start, period_end\) WHERE status <> 'void' DO NOTHING/);
  assert.match(domain, /utilityKept = true/);
  assert.match(domain, /billKept = Number\(existingBill\.amount\) !== billMinor/);
  assert.match(wizard, /router\.push\(state\.leaseHref!\)/);
  assert.match(wizard, /2_000/);
  assert.match(wizard, /i_lease_creating/);
  assert.match(wizard, /i_lease_created_sent/);
  assert.match(wizard, /data-testid="lease-created-toast"/);
  assert.match(wizard, /i_lease_slow/);
  assert.match(wizard, /setTimeout\(\(\) => setSlowSubmit\(true\), 8000\)/);
  assert.match(wizard, /href="\/m\/leases"/);
  assert.match(wizard, /confirmSpaceFromSnapshot/);
  assert.match(wizard, /disabled=\{blocked \|\| creating \|\| !submitReady\}/);
  assert.match(wizard, /key="wizard-next"/);
  assert.match(wizard, /key="submit-lease"/);
  assert.match(wizard, /type="button"/);
  assert.match(wizard, /setTimeout\(\(\) => setSubmitReady\(true\), 600\)/);
  assert.match(wizard, /blockImplicitEnter/);
  assert.match(wizard, /ImplicitSubmitSink/);
  assert.match(wizard, /submitter\.dataset\.testid !== "submit-lease"/);
  assert.match(edit, /callSubmitAction\(\s*guard/);
  assert.match(edit, /errors\.leaseFailed/);
  assert.match(edit, /router\.refresh\(\)/);
  assert.match(edit, /depositPolicyState/);
  assert.match(wizard, /actionDepositPolicy/);
  assert.match(domain, /idempotency_key/);
  assert.match(domain, /leases_org_idempotency_key_uidx/);
  assert.match(actions, /redirect\(`\/m\/leases\/\$\{leaseId\}\?saved=rent`\)/);
  assert.match(page, /query\.saved === "rent"/);
  assert.match(page, /data-testid="rent-updated"/);
  assert.match(page, /i_rent_updated/);
  assert.match(edit, /disabled=\{blocked \|\| pending\}/);
  assert.match(edit, /pending \? t\("i_portal_working"\)/);
  assert.match(page, /data-testid="summary-deposit"/);
  assert.match(page, /data-testid="deposit-override-reason"/);
  assert.match(page, /key=\{lease\.updated_at\}/);
  assert.match(domain, /export async function createLease/);
  assert.match(domain, /export async function updateLease/);
  assert.match(domain, /savedDepositWarn/);
  assert.match(domain, /rule_key = 'deposit.max_months'/);
  assert.match(domain, /errors\.leaseLocked/);
  assert.match(domain, /errors\.staleLease/);
  assert.match(domain, /async function noteChange/);
  assert.equal(domain.includes("set_config('app.change_reason', $1, true)`, [override.reason ?? \"\"]"), false);
  assert.equal(domain.includes("set_config('app.change_reason', $1, true)`, [\"\"]"), false);
  assert.match(edit, /lease_terms_locked|updatedAt/);
  assert.match(page, /lease_terms_locked/);
  const guard = readFileSync(new URL("../../supabase/migrations/20261023090000_lease_deposit_override_check.sql", import.meta.url), "utf8");
  const earlier = readFileSync(new URL("../../supabase/migrations/20261021140000_basic_leases.sql", import.meta.url), "utf8");
  assert.match(earlier, /CREATE TRIGGER trg_lease_deposit_check/);
  assert.match(earlier, /fn_lease_deposit_check/);
  assert.match(guard, /leases_deposit_over_cap_requires_override/);
  assert.match(guard, /trg_lease_deposit_check/);
  assert.match(guard, /20261021140000_basic_leases/);
});

test("a lease idempotency key is a UUID or absent", () => {
  assert.deepEqual(normalizeIdempotencyKey("  "), { ok: true, value: null });
  assert.deepEqual(normalizeIdempotencyKey(null), { ok: true, value: null });
  assert.deepEqual(normalizeIdempotencyKey("00000000-0000-4000-8000-000000000001"), {
    ok: true,
    value: "00000000-0000-4000-8000-000000000001",
  });
  assert.deepEqual(normalizeIdempotencyKey("00000000-0000-4000-8000-00000000000G"), { ok: false });
  assert.deepEqual(normalizeIdempotencyKey("retry-1"), { ok: false });
});

test("the lease idempotency migration is additive and later than shared staging history", () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  const ours = names.filter((name) => name.includes("lease_idempotency_key"));
  assert.deepEqual(ours, ["20261027130000_lease_idempotency_key.sql"]);
  const stamp = ours[0].slice(0, 14);
  assert.ok(stamp > "20261023180000");
  assert.ok(stamp > "20261026120000");
  const previous = names.filter((name) => name < ours[0]).map((name) => name.slice(0, 14)).sort().at(-1);
  assert.equal(previous, "20261027120000");
  const later = names.filter((name) => name.slice(0, 14) > stamp);
  assert.deepEqual(later, [
    "20261027140000_id_anon_revoke.sql",
    "20261028120000_id_delete_after_consent.sql",
    "20261028130000_utility_charge_posting.sql",
    "20261028140000_utility_runs_unit_id_default.sql",
    "20261028150000_utility_vacant_expense.sql",
    "20261028160000_utility_run_draft_reuse.sql",
    "20261028180000_utility_owner_lines.sql",
    "20261029130000_id_no_direct_mutate.sql",
    "20261029140000_id_consent_shown_version.sql",
    "20261029150000_id_watermark_copy.sql",
    "20261029160000_lease_close_end_date.sql",
    "20261030100000_lock_public_function_execute.sql",
    "20261030110000_gotrue_confirm_single_use.sql",
    "20261030120000_org_scoped_reversal_audit.sql",
    "20261030130000_default_function_privileges.sql",
    "20261030140500_revoke_app_is_member_execute.sql",
    "20261030150000_revoke_id_photo_lease_close_execute.sql",
    "20261030150200_vendor_repair.sql",
    "20261030150300_repair_owner_visibility.sql",
    "20261030150400_ticket_job_type_reserve.sql",
    "20261030150500_revoke_public_function_execute.sql",
    "20261030150600_consents.sql",
    "20261030150700_vendor_link_sharing_approval.sql",
    "20261030150800_vendor_onboarding_job_types_receipts.sql",
    "20261030150801_vendor_document_service.sql",
    "20261030150802_vendor_job_assignment.sql",
    "20261030150900_esign_core.sql",
    "20261030151100_end_auth_sessions_varchar_fix.sql",
    "20261030151200_id_purge_dry_run_guard.sql",
    "20261030151300_partner_agreement_consents.sql",
    "20261030151301_partner_consent_attestation.sql",
    "20261030151400_tenant_signed_pdf_read.sql",
    "20261030151500_paper_lease_versions.sql",
    "20261030151600_esign_retention_lifecycle.sql",
    "20261031090000_id_delete_after_move_out.sql",
    "20261031100000_payee_details.sql",
    "20261031100100_audit_action_select.sql",
    "20261031100200_tenant_payee_read.sql",
    "20261031100201_b001_esign_internal_helpers.sql",
    "20261031100202_b003_payee_gateway.sql",
    "20261031100203_b002_retention_boundary.sql",
    "20261031100204_b004_paper_delivery_boundary.sql",
    "20261031100205_b007_deposit_rules.sql",
    "20261031100206_b002_legacy_open_moveout.sql",
    "20261031100207_b005_onboarding_progress.sql",
    "20261031100208_b008_billing_previews.sql",
    "20261031100209_b009_bank_match_decisions.sql",
    "20261031100210_b008_first_period_basis.sql",
    "20261031100211_b001_esign_activation.sql",
    "20261031100212_b010_b028_local_events.sql",
    "20261031100213_b001_zero_first_invoice.sql",
    "20261031100214_b011_handover_records.sql",
    "20261031100215_b028_center_foundation.sql",
    "20261031100216_b001_invoices_index_concurrently.sql",
    "20261031100217_b010_b028_source_foundation.sql",
    "20261031100218_b015_tenant_directory_edit.sql",
    "20261031100220_b013_owner_repair_policy.sql",
    "20261031100221_b013_owner_repair_override.sql",
    "20261031100222_b004_reason_no_pii.sql",
    "20261031100223_b004_reason_codes.sql",
    "20261031100224_b004_archived_lease_signed_pdf.sql",
    "20261104120300_b010_flag_first_locks.sql",
  ]);
  const sql = readFileSync(new URL(ours[0], dir), "utf8");
  assert.match(sql, /Version 20261027130000/);
  assert.doesNotMatch(sql, /Version 20261027120000/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS idempotency_key text/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS leases_org_idempotency_key_uidx/);
  assert.match(sql, /ON leases \(org_id, idempotency_key\)/);
  assert.match(sql, /WHERE idempotency_key IS NOT NULL/);
  assert.doesNotMatch(sql, /idempotency_key\s+text\s+NOT NULL/);
  assert.doesNotMatch(sql, /SET NOT NULL/);
  assert.doesNotMatch(sql, /ADD CONSTRAINT/);
  assert.doesNotMatch(sql, /CHECK \(/);
  assert.equal(sql.includes("房東"), false);
  assert.equal(sql.includes("房客"), false);
  assert.equal(sql.includes("收款"), false);
  assert.equal(sql.includes("收租"), false);
  assert.equal(sql.includes("即將推出"), false);
  assert.equal(sql.includes("測試模式"), false);
  assert.equal(sql.includes("範例沙盒"), false);
  assert.equal(sql.includes("示範"), false);
});

test("a later term is allowed and an overlapping term names the existing dates", () => {
  const current = { start: "2026-11-01", end: "2027-10-31" };
  assert.equal(leaseTermEnd("2027-11-01", "12"), "2028-10-31");
  assert.equal(overlappingLease([current], "2027-11-01", "2028-10-31"), null);
  assert.deepEqual(overlappingLease([current], "2026-11-01", "2027-10-31"), current);
  assert.deepEqual(overlappingLease([current], "2027-10-31", "2028-10-30"), current);
  assert.equal(overlappingLease([current], "2027-11-01", "2027-10-31"), null);
});

test("a Taiwan mobile becomes +886 and an international number stays", () => {
  assert.equal(normalizePhone("0911222333"), "+886911222333");
  assert.equal(normalizePhone("0911-222-333"), "+886911222333");
  assert.equal(normalizePhone("+886912345678"), "+886912345678");
  assert.equal(normalizePhone("  "), null);
  assert.equal(normalizePhone("0212345678"), null);
  assert.equal(normalizePhone("0912345678", "+886"), "+886912345678");
  assert.equal(normalizePhone("4155552671", "+1"), "+14155552671");
});

test("LINE id is optional and bounded", () => {
  assert.deepEqual(normalizeLineId("  "), { ok: true, value: null });
  assert.deepEqual(normalizeLineId(" Uabc123 "), { ok: true, value: "Uabc123" });
  assert.deepEqual(normalizeLineId("x".repeat(65)), { ok: false });
  assert.deepEqual(normalizeLineId("bad\nid"), { ok: false });
});

test("only a PDF header within the size cap is a signed lease", () => {
  assert.equal(isSignedPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), true);
  assert.equal(isSignedPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46])), false);
  assert.equal(isSignedPdf(new TextEncoder().encode("%PDF-1.4\n")), true);
  assert.equal(isSignedPdf(new TextEncoder().encode("not a pdf")), false);
  assert.equal(signedPdfName("../signed lease.PDF"), "signed lease.PDF");
  assert.equal(signedPdfName("scan"), "scan.pdf");
});

test("traditional Chinese copy says 屋主", () => {
  const zh = readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8");
  assert.equal(zh.includes("房東"), false);
  assert.equal(zh.includes("屋主"), true);
});
