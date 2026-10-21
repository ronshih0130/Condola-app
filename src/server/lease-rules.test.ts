import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { depositCapSaveAllowed, depositExceedsCap, depositReasonEditorOpen, depositReasonOk, depositWarnFlag, isSignedPdf, leaseTermsEditable, normalizeIdempotencyKey, normalizeLineId, normalizePhone, signedPdfName } from "./lease-rules";

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
  assert.match(actions, /redirect\(`\/m\/leases\/\$\{created\.leaseId\}\?created=1`\)/);
  assert.doesNotMatch(wizard, /router\.push/);
  assert.match(wizard, /i_lease_slow/);
  assert.match(wizard, /setTimeout\(\(\) => setSlowSubmit\(true\), 8000\)/);
  assert.match(wizard, /href="\/m\/leases"/);
  assert.match(wizard, /confirmSpaceFromSnapshot/);
  assert.match(wizard, /disabled=\{blocked \|\| pending \|\| !submitReady\}/);
  assert.match(wizard, /key="wizard-next"/);
  assert.match(wizard, /key="submit-lease"/);
  assert.match(wizard, /type="button"/);
  assert.match(wizard, /setTimeout\(\(\) => setSubmitReady\(true\), 600\)/);
  assert.match(wizard, /blockImplicitEnter/);
  assert.match(wizard, /ImplicitSubmitSink/);
  assert.match(wizard, /submitter\.dataset\.testid !== "submit-lease"/);
  assert.match(edit, /callSubmitAction\(guard/);
  assert.match(edit, /router\.refresh\(\)/);
  assert.match(edit, /depositReasonEditorOpen/);
  assert.match(domain, /idempotency_key/);
  assert.match(domain, /leases_org_idempotency_key_uidx/);
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
  const latestOther = names.filter((name) => name !== ours[0]).map((name) => name.slice(0, 14)).sort().at(-1);
  assert.ok(latestOther);
  assert.ok(stamp > latestOther);
  const sql = readFileSync(new URL(ours[0], dir), "utf8");
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
