import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { depositCapSaveAllowed, depositExceedsCap, depositReasonEditorOpen, depositReasonOk, depositWarnFlag, isSignedPdf, LEASE_STATUSES, leaseTermsEditable, normalizeIdempotencyKey, normalizeLineId, normalizePhone, signedPdfName } from "./lease-rules";

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
  assert.equal(depositWarnFlag(3, "warn"), false);
  assert.equal(depositWarnFlag(1.5, "warn"), true);
  assert.equal(depositWarnFlag(2, "pass"), false);
  assert.equal(depositReasonEditorOpen("4", "4.00"), false);
  assert.equal(depositReasonEditorOpen("4", "3"), true);
  assert.equal(depositReasonEditorOpen("2", "4"), false);
  assert.equal(depositReasonEditorOpen("", "3"), false);
});

test("lease status has no signed state between pending_signature and active", () => {
  const schema = readFileSync(new URL("../../supabase/migrations/20261018120000_schema.sql", import.meta.url), "utf8");
  const declared = schema.match(/CREATE TYPE lease_status\s+AS ENUM \(([^)]+)\)/)?.[1] ?? "";
  const values = declared.split(",").map((item) => item.trim().replaceAll("'", ""));
  assert.equal(values.includes("signed"), false);
  assert.deepEqual(values, [...LEASE_STATUSES]);
  assert.match(schema, /CREATE TYPE esign_status\s+AS ENUM \('not_sent','sent','partially_signed','fully_signed','declined','voided'\)/);
  assert.match(schema, /CREATE TYPE signature_status\s+AS ENUM \('pending','viewed','signed','declined'\)/);
  const domain = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  assert.match(domain, /A lease never sits in a `signed` status/);
  assert.match(domain, /UPDATE leases SET esign_status = 'partially_signed' WHERE id = \$1/);
  assert.match(domain, /UPDATE leases SET status = 'active', esign_status = 'fully_signed', signed_at = now\(\)/);
  assert.match(domain, /status IN \('draft','pending_signature'\) THEN 'active'::lease_status/);
  const labels = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");
  assert.match(labels, /pending_signature: "i_st_pending"/);
  assert.match(labels, /active: "i_st_active"/);
  assert.equal(/^\s*signed:/m.test(labels), false);
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
  assert.match(wizard, /callSubmitAction\(submitGuard/);
  assert.match(wizard, /ensureIdempotencyKey\(idempotencyKey\)/);
  assert.match(wizard, /name="idempotencyKey"/);
  assert.match(wizard, /disabled=\{blocked \|\| pending\}/);
  assert.match(edit, /callSubmitAction\(guard/);
  assert.match(domain, /idempotency_key/);
  assert.match(domain, /leases_org_idempotency_key_uidx/);
  const idempotency = readFileSync(new URL("../../supabase/migrations/20261023140000_lease_idempotency_key.sql", import.meta.url), "utf8");
  assert.match(idempotency, /20261023090000/);
  assert.match(idempotency, /CREATE UNIQUE INDEX leases_org_idempotency_key_uidx/);
  assert.match(idempotency, /WHERE idempotency_key IS NOT NULL/);
  assert.match(edit, /router\.refresh\(\)/);
  assert.match(edit, /depositReasonEditorOpen/);
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

test("a Taiwan mobile becomes +886 and an international number stays", () => {
  assert.equal(normalizePhone("0911222333"), "+886911222333");
  assert.equal(normalizePhone("0911-222-333"), "+886911222333");
  assert.equal(normalizePhone("+886912345678"), "+886912345678");
  assert.equal(normalizePhone("  "), null);
  assert.equal(normalizePhone("0212345678"), null);
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
