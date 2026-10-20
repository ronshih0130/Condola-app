import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { depositExceedsCap, depositReasonOk, isSignedPdf, normalizeLineId, signedPdfName } from "./lease-rules";

test("a deposit over two months of rent needs a typed reason", () => {
  assert.equal(depositExceedsCap(2), false);
  assert.equal(depositExceedsCap(2.01), true);
  assert.equal(depositExceedsCap(Number.NaN), false);
  assert.equal(depositReasonOk(2, ""), true);
  assert.equal(depositReasonOk(3, ""), false);
  assert.equal(depositReasonOk(3, "   "), false);
  assert.equal(depositReasonOk(3, "屋主同意兩個月以上押金"), true);
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

test("traditional Chinese copy says 屋主 and never 房東", () => {
  const zh = readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8");
  assert.equal(zh.includes("房東"), false);
  assert.equal(zh.includes("屋主"), true);
});
