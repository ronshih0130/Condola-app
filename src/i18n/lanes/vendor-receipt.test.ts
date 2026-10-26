import assert from "node:assert/strict";
import test from "node:test";
import {
  getVendorReceiptCopy,
  VENDOR_RECEIPT_COPY,
} from "./vendor-receipt";

const BANNED_VENDOR_RECEIPT_TERMS: readonly string[] = [
  "收租",
  "收款",
  "欠租",
  "已收",
  "入帳",
  "房東",
  "代收",
  "轉付",
  "統一編號",
  "含稅",
  "本公司",
  "事務所",
  "已驗證",
  "保證可報帳",
] as const;

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStrings(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      collectStrings(entry),
    );
  }
  return [];
}

test("vendor-receipt copy contains no banned terms in zh-TW or en", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const copy = getVendorReceiptCopy(locale);
    const allStrings = collectStrings(copy);
    assert.ok(allStrings.length > 0);
    for (const text of allStrings) {
      for (const banned of BANNED_VENDOR_RECEIPT_TERMS) {
        assert.equal(
          text.includes(banned),
          false,
          `Locale ${locale} text "${text}" must not contain banned term "${banned}"`,
        );
      }
    }
  }
});

test("vendor-receipt zh-TW copy uses approved terminology and labels", () => {
  const zh = VENDOR_RECEIPT_COPY["zh-TW"];
  assert.equal(zh.labels.receiptTitle, "免用統一發票收據");
  assert.equal(zh.labels.completionStatementTitle, "維修完工單／費用明細");
  assert.equal(zh.labels.nonTaxVoucherNotice, "本文件非稅務憑證");
  assert.equal(zh.labels.vendorTaxId, "統編");
  assert.equal(zh.labels.buyerTaxId, "買受人統編");
  assert.equal(zh.labels.ownerReceiptTitle, "收據抬頭");
  assert.equal(zh.labels.previewWatermark, "預覽，尚未開立");
  assert.equal(zh.labels.currencyPrefix, "NT$");
  assert.match(zh.errors.ownerReceiptTitleMissing, /屋主/);
  assert.match(zh.labels.receiptDisclaimer, /Condola 只提供管理軟體，不經手任何款項/);
  assert.match(
    zh.labels.completionStatementDisclaimer,
    /本文件僅供記錄維修完成情形與費用明細，非稅務憑證/,
  );
});

test("vendor-receipt en copy mirrors all keys of zh-TW", () => {
  const zh = VENDOR_RECEIPT_COPY["zh-TW"];
  const en = VENDOR_RECEIPT_COPY.en;
  assert.deepEqual(
    Object.keys(zh.labels).sort(),
    Object.keys(en.labels).sort(),
  );
  assert.deepEqual(
    Object.keys(zh.errors).sort(),
    Object.keys(en.errors).sort(),
  );
});
