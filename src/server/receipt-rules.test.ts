import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RECEIPT_MAX_BYTES,
  acceptReceiptObject,
  assertReceiptMeta,
  isReceiptPath,
  receiptFileId,
  receiptPath,
  sniffReceiptMime,
} from "./receipt-rules";

const ORG = "10000000-0000-4000-8000-000000000001";
const FILE = "40000000-0000-4000-8000-0000000000aa";
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34);
const WEBP = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
const GIF = Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);

test("a receipt is a JPEG, PNG, or PDF of at most 10MB on an org path", () => {
  assert.equal(RECEIPT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(sniffReceiptMime(JPEG), "image/jpeg");
  assert.equal(sniffReceiptMime(PNG), "image/png");
  assert.equal(sniffReceiptMime(PDF), "application/pdf");
  assert.equal(sniffReceiptMime(WEBP), null);
  assert.equal(sniffReceiptMime(GIF), null);
  assert.equal(receiptPath(ORG, FILE, "image/jpeg"), `org/${ORG}/receipts/${FILE}.jpg`);
  assert.equal(receiptPath(ORG, FILE, "image/png"), `org/${ORG}/receipts/${FILE}.png`);
  assert.equal(receiptPath(ORG, FILE, "application/pdf"), `org/${ORG}/receipts/${FILE}.pdf`);
  assert.equal(isReceiptPath(receiptPath(ORG, FILE, "application/pdf"), ORG), true);
  assert.equal(isReceiptPath(receiptPath(ORG, FILE, "image/jpeg"), "20000000-0000-4000-8000-000000000002"), false);
  assert.equal(isReceiptPath(`demo/${FILE}.txt`, ORG), false);
  assert.equal(receiptFileId(receiptPath(ORG, FILE, "image/png")), FILE);
  assert.deepEqual(assertReceiptMeta({ fileName: " 收據_水電行.jpg ", mime: "image/jpg", size: 820 * 1024 }), {
    fileName: "收據_水電行.jpg",
    mime: "image/jpeg",
    size: 820 * 1024,
  });
  assert.equal(assertReceiptMeta({ fileName: "scan.pdf", mime: "application/pdf", size: RECEIPT_MAX_BYTES }).size, RECEIPT_MAX_BYTES);
  assert.throws(() => assertReceiptMeta({ fileName: "scan.pdf", mime: "application/pdf", size: RECEIPT_MAX_BYTES + 1 }));
  assert.throws(() => assertReceiptMeta({ fileName: "anim.webp", mime: "image/webp", size: 100 }));
  assert.deepEqual(acceptReceiptObject({ size: 120, mime: "application/octet-stream", header: PDF }, "application/pdf"), {
    size: 120,
    mime: "application/pdf",
  });
  assert.throws(() => acceptReceiptObject({ size: 120, mime: "image/jpeg", header: JPEG }, "application/pdf"));
  assert.throws(() => acceptReceiptObject({ size: 120, mime: "image/webp", header: WEBP }, "image/webp"));
});

test("the receipt migration only adds a private bucket and checks that older placeholder rows skip", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261026110000_receipts_private.sql", import.meta.url), "utf8");
  assert.match(sql, /^-- Version 20261026110000\./);
  assert.match(sql, /storage_bucket <> 'receipts-private'/);
  assert.match(sql, /10485760/);
  assert.match(sql, /image\/jpeg/);
  assert.match(sql, /image\/png/);
  assert.match(sql, /application\/pdf/);
  assert.equal(sql.includes("image/webp"), false);
  assert.doesNotMatch(sql, /DROP TABLE/i);
  assert.doesNotMatch(sql, /DROP COLUMN/i);
  assert.doesNotMatch(sql, /RENAME /i);
  assert.doesNotMatch(sql, /SET NOT NULL/i);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX/i);
  assert.match(sql, /demo\/<uuid>\.txt/);
  const expenses = readFileSync(new URL("./expenses.ts", import.meta.url), "utf8");
  assert.equal(expenses.includes("demo/"), false);
  assert.equal(expenses.includes("text/plain"), false);
});

test("receipt, closed-month, sample, repair, and tenant-name screens use the agreed copy", () => {
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_receipt_drop, "拖曳或點選上傳（JPG、PNG、PDF，10MB 內）");
  assert.equal(zh.i_receipt_uploading, "上傳中 {pct}%");
  assert.equal(zh.i_receipt_too_big, "檔案超過 10MB");
  assert.equal(zh.i_receipt_view, "檢視");
  assert.equal(zh.i_receipt_remove, "移除");
  assert.equal(zh.i_receipt_cancel, "取消");
  assert.equal(zh.i_expense_view, "檢視");
  assert.equal(zh.i_sample_tag, "範例資料");
  const upload = readFileSync(new URL("../components/receipt-upload.tsx", import.meta.url), "utf8");
  for (const id of ["receipt-drop", "receipt-uploading", "receipt-progress", "receipt-error", "receipt-file", "receipt-view", "receipt-remove", "receipt-cancel"]) {
    assert.match(upload, new RegExp(`data-testid="${id}"`));
  }
  assert.equal(upload.includes("expense-receipt"), false);
  assert.equal(upload.includes("webp"), false);
  assert.match(upload, /RECEIPT_MAX_BYTES/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.receipt-file\.bad\{border-color:#C62828;background:#FFF6F5\}/);
  assert.match(css, /\.receipt-thumb\{[^}]*background:#F2E5D8/);
  assert.match(css, /\.receipt-bar i\{[^}]*var\(--cd-accent\)/);
  const list = readFileSync(new URL("../app/m/expenses/page.tsx", import.meta.url), "utf8");
  assert.match(list, /i_expense_view/);
  assert.match(list, /data-mode=\{row\.month_closed \? "view" : "edit"\}/);
  const wizard = readFileSync(new URL("../components/lease-wizard.tsx", import.meta.url), "utf8");
  assert.match(wizard, /tenantsByName/);
  assert.match(wizard, /data-testid="tenant-name-exists"/);
  assert.match(wizard, /i_tenant_name_exists/);
  assert.equal(wizard.includes("if (nameMatches"), false);
  const form = readFileSync(new URL("../components/repair-create-form.tsx", import.meta.url), "utf8");
  assert.match(form, /data-testid="repair-create-photo"/);
  assert.match(readFileSync(new URL("../app/t/repair/page.tsx", import.meta.url), "utf8"), /data-testid="repair-sent"/);
  assert.match(readFileSync(new URL("../app/m/tickets/[id]/page.tsx", import.meta.url), "utf8"), /data-testid="repair-sent"/);
  for (const path of [
    "../app/m/leases/page.tsx",
    "../app/m/tenants/page.tsx",
    "../app/m/owners/page.tsx",
    "../app/m/units/page.tsx",
    "../app/m/page.tsx",
    "../app/m/properties/[id]/page.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /displaySampleName/, path);
    assert.equal(source.includes("SampleTag"), false, path);
  }
});
