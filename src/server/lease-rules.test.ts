import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { depositCapSaveAllowed, depositExceedsCap, depositReasonOk, depositWarnFlag, isSignedPdf, normalizeLineId, normalizePhone, signedPdfName } from "./lease-rules";

test("a deposit over two months of rent needs a typed reason", () => {
  assert.equal(depositExceedsCap(2), false);
  assert.equal(depositExceedsCap(2.01), true);
  assert.equal(depositExceedsCap(Number.NaN), false);
  assert.equal(depositReasonOk(2, ""), true);
  assert.equal(depositReasonOk(3, ""), false);
  assert.equal(depositReasonOk(3, "   "), false);
  assert.equal(depositReasonOk(3, "屋主同意兩個月以上押金"), true);
  assert.equal(depositCapSaveAllowed(3, "warn"), false);
  assert.equal(depositCapSaveAllowed(3, "block"), false);
  assert.equal(depositCapSaveAllowed(3, "overridden"), true);
  assert.equal(depositCapSaveAllowed(3, null), true);
  assert.equal(depositCapSaveAllowed(1.5, "warn"), true);
  assert.equal(depositWarnFlag(3, "warn"), false);
  assert.equal(depositWarnFlag(1.5, "warn"), true);
  assert.equal(depositWarnFlag(2, "pass"), false);
});

test("create and edit lease screens ask for a reason with lease_deposit_over", () => {
  const wizard = readFileSync(new URL("../components/lease-wizard.tsx", import.meta.url), "utf8");
  const edit = readFileSync(new URL("../components/lease-terms-form.tsx", import.meta.url), "utf8");
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
  assert.match(domain, /export async function createLease/);
  assert.match(domain, /export async function updateLease/);
  assert.match(domain, /savedDepositWarn/);
});

test("a Taiwan mobile becomes +886 and an international number stays", () => {
  assert.equal(normalizePhone("0911222333"), "+886911222333");
  assert.equal(normalizePhone("0911-222-333"), "+886911222333");
  assert.equal(normalizePhone("+886912345678"), "+886912345678");
  assert.equal(normalizePhone("  "), null);
  assert.equal(normalizePhone("0212345678"), null);
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
