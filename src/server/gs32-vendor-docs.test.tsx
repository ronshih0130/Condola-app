import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketDocumentsV3 } from "../components/v3/m/tickets/ticket-documents";
import { VendorDocsV3, money, sendOnce, type1IssueBody, type VendorDocsV3Props } from "../components/v3/vendor/vendor-docs-v3";
import { vendorDocsCopy } from "../i18n/lanes/brand-v3-vendor-docs";
import { orderTicketDocuments, vendorDocsV3FlagOn, vendorDocsV3Stage, type TicketDocument } from "./gs32-vendor-docs";

const read = (path: string) => readFileSync(path, "utf8");
const token = "t".repeat(43);
const brand = { name: "阿榮", company: "安居物業", property: "信義路 2 樓", status: "closed", ticketTitle: "浴室天花板滴水", currency: "TWD",
  buyerKind: "company" as const, buyerName: "安居物業" };
const view = (props: Partial<VendorDocsV3Props>) => renderToStaticMarkup(<VendorDocsV3 locale="zh-TW" token={token} brand={brand}
  stage={{ stage: "type1_preview" }} totalMinor="2800" remainingMinor="2800" mode="view" uploaded={false} {...props} />);
const solids = (html: string) => (html.match(/class="v-token-primary/g) ?? []).length;
const base = { profile: { kind: "individual" as const, display_name: "阿榮" }, eligibleKind: "completion_statement" as const,
  totalMinor: "2800", receivedMinor: "0", documents: [], history: [] };

test("P52 new words and approved vendor-frontend words are verbatim", () => {
  const zh = vendorDocsCopy("zh-TW");
  const expected: Record<string, string> = {
    previewTitle: "預覽簽收單", previewHeading: "簽收單／完工明細預覽", notTax: "本文件非稅務憑證", markStatement: "完工明細（非稅務憑證）",
    previewNote: "這是預覽，還沒開立，因此還沒有編號。", noNumber: "（預覽不占號）", signLine: "開立人：{name}（簽收單不蓋章）",
    withholding: "若付款方是管理公司：扣繳與列單是公司在系統外的義務，系統不代為處理，也不開扣繳憑單。我們不收、不印身分證。",
    issue: "確認已全額收款並開立", close: "關閉", receiptTitle: "普通收據", evidence: "已關聯的證據", markReceipt: "收據", billedTo: "開給",
    paperCard: "紙本收據", paperEntry: "上傳紙本收據", paperSibling: "紙本收據會和電子收據 {number} 放在一起，不會取代它，也不會多算一筆費用。",
    paperZone: "點這裡上傳收據照片或 PDF", upload: "上傳", cancel: "取消", paperDone: "已上傳紙本收據", markVoid: "已作廢",
    saveError: "沒有存成功，請再試一次。", retry: "再試一次",
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(zh[key as keyof typeof zh], value, key);
  assert.deepEqual(Object.keys(vendorDocsCopy("en")).sort(), Object.keys(zh).sort());
});

test("stage: type 1 without a valid statement previews; type 2 with an issued receipt shows evidence; anything else stays B-025", () => {
  assert.deepEqual(vendorDocsV3Stage(base), { stage: "type1_preview" });
  assert.equal(vendorDocsV3Stage({ ...base, itemsUnavailable: true }), null);
  assert.equal(vendorDocsV3Stage({ ...base, documents: [{ id: "a", kind: "completion_statement", doc_no: "CS-1", status: "issued" }] }), null);
  assert.deepEqual(vendorDocsV3Stage({ ...base, documents: [{ id: "a", kind: "completion_statement", doc_no: "CS-1", status: "voided" }] }), { stage: "type1_preview" });
  const business = { ...base, profile: { kind: "business" as const, display_name: "王師傅水電" }, eligibleKind: "receipt" as const };
  assert.equal(vendorDocsV3Stage(business), null, "no receipt yet: 開給誰 / path are VF-3");
  assert.equal(vendorDocsV3Stage({ ...business, documents: [{ id: "r0", kind: "receipt", doc_no: "RCP-18", status: "voided" }] }), null);
  assert.deepEqual(vendorDocsV3Stage({ ...business, documents: [{ id: "r0", kind: "receipt", doc_no: "RCP-18", status: "voided" }, { id: "r1", kind: "receipt", doc_no: "RCP-19", status: "issued" }],
    history: [{ id: "r1", scans: [{ id: "s1", mime_type: "image/jpeg" }] }, { id: "r0", scans: [{ id: "s0", mime_type: "application/pdf" }] }] }),
  { stage: "receipt_evidence", receipt: { id: "r1", docNo: "RCP-19" }, scans: [{ id: "s1", mime: "image/jpeg" }] });
});

test("rec-type1-preview: banner, heading + mark, no number, issuer only, one solid; withholding only for a company payer", () => {
  const html = view({});
  for (const text of ["預覽簽收單", "本文件非稅務憑證", "簽收單／完工明細預覽", "完工明細（非稅務憑證）", "這是預覽，還沒開立，因此還沒有編號。",
    "開立人", "阿榮", "買受人", "安居物業", "NT$2,800", "（預覽不占號）", "開立人：阿榮（簽收單不蓋章）", "扣繳與列單是公司在系統外的義務", ">確認已全額收款並開立<", ">關閉<"]) assert.ok(html.includes(text), text);
  assert.equal(solids(html), 1);
  assert.doesNotMatch(html, /蓋章範本|統一編號|身分證字號/);
  assert.doesNotMatch(view({ brand: { ...brand, buyerKind: "owner", buyerName: "林雅婷" } }), /扣繳/);
});

test("the type 1 issue body is fixed once: same idempotency key and payment mark on every retry; no mark when already paid", async () => {
  let n = 0;
  const body = type1IssueBody(token, "2800", () => `id-${++n}`, "2026-11-16");
  assert.deepEqual(body, { token, action: "issue", kind: "completion_statement", documentDate: "2026-11-16", idempotencyKey: "id-1", received: { requestId: "id-2", amountMinor: "2800" } });
  assert.deepEqual(type1IssueBody(token, "0", () => "x", "2026-11-16"), { token, action: "issue", kind: "completion_statement", documentDate: "2026-11-16", idempotencyKey: "x" });
  const sent: string[] = [];
  const fetch = async (_url: string, init: RequestInit) => { sent.push(String(init.body)); return new Response("{}", { status: sent.length < 2 ? 503 : 200 }); };
  assert.equal(await sendOnce(fetch, body), false);
  assert.equal(await sendOnce(fetch, body), true);
  assert.equal(sent[0], sent[1], "the retry is byte-identical");
});

test("rec-issued with paper receipts and rec-paper-upload", () => {
  const stage = { stage: "receipt_evidence" as const, receipt: { id: "r1", docNo: "RCP-2026-019" }, scans: [{ id: "s1", mime: "image/jpeg" }] };
  const page = view({ stage, brand: { ...brand, name: "王師傅水電" }, totalMinor: "5200", uploaded: true });
  for (const text of ["普通收據", "信義路 2 樓・浴室天花板滴水 › 收據", "已關聯的證據", "RCP-2026-019", "開給", "NT$5,200", "紙本收據", "已上傳紙本收據", ">上傳紙本收據<"]) assert.ok(page.includes(text), text);
  assert.equal((page.match(/data-testid="paper-receipt"/g) ?? []).length, 1);
  assert.equal(solids(page), 0, "作廢重開 is VF-4 and not built");
  assert.doesNotMatch(page, /作廢重開/);
  assert.ok(page.includes(`href="/v/documents/${token}?paper=1"`));
  const upload = view({ stage, mode: "paper" });
  for (const text of ["上傳紙本收據", "信義路 2 樓・浴室天花板滴水 › 上傳紙本收據", "紙本收據會和電子收據 RCP-2026-019 放在一起，不會取代它，也不會多算一筆費用。",
    "點這裡上傳收據照片或 PDF", ">上傳<", ">取消<"]) assert.ok(upload.includes(text), text);
  assert.match(upload, /<button type="button" class="v-token-primary v-docs-block" disabled=""[^>]*>上傳</, "disabled until a file");
  assert.match(upload, /accept="image\/jpeg,image\/png,application\/pdf"/);
  assert.equal(solids(upload), 1);
});

test("DOC-VOID m-docs: nature marks, voided last and muted with the amount struck; no PDF face mark, no buttons", () => {
  const rows: TicketDocument[] = [
    { id: "v", kind: "receipt", docNo: "RCP-2026-018", status: "voided", totalMinor: "5200", buyerName: "林雅婷", issuedAt: "2026-11-10" },
    { id: "s", kind: "completion_statement", docNo: "CS-2026-004", status: "issued", totalMinor: "5200", buyerName: null, issuedAt: "2026-11-12" },
    { id: "r", kind: "receipt", docNo: "RCP-2026-019", status: "issued", totalMinor: "5200", buyerName: "安居物業", issuedAt: "2026-11-11" },
  ];
  const ordered = orderTicketDocuments(rows);
  assert.deepEqual(ordered.map(d => d.id), ["r", "s", "v"]);
  const html = renderToStaticMarkup(<TicketDocumentsV3 locale="zh-TW" currency="TWD" documents={ordered} />);
  for (const text of [">文件<", "收據 RCP-2026-019", "完工明細 CS-2026-004", "完工明細（非稅務憑證）", "已作廢", "<s class=\"v3-doc-num\">NT$5,200</s>", "開給", "林雅婷"]) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf("RCP-2026-018") > html.indexOf("CS-2026-004"), "voided last");
  assert.match(html, /class="v3-doc v3-doc-void" data-status="voided"/);
  assert.doesNotMatch(html, /<button|<form|請款單|上傳之統一發票|href="\/api/);
  assert.equal(renderToStaticMarkup(<TicketDocumentsV3 locale="zh-TW" currency="TWD" documents={[]} />), "");
  assert.equal(money("USD", "1234567"), "USD 1,234,567");
});

test("vendor_docs_v3 flag: platform allowlist and org flag, strict booleans; absent row is OFF", async () => {
  const flag = (value: unknown, orgFlag: unknown) => vendorDocsV3FlagOn({ query: (async () => ({ rows: [{ value, flag: orgFlag }] })) as never }, "org-a");
  assert.equal(await flag({ enabled: true, allowed_org_ids: ["org-a"] }, true), true);
  for (const [value, orgFlag] of [[null, true], [{ enabled: true, allowed_org_ids: [] }, true], [{ enabled: "true", allowed_org_ids: ["org-a"] }, true],
    [{ enabled: true, allowed_org_ids: "org-a" }, true], [{ enabled: false, allowed_org_ids: ["org-a"] }, true], [{ enabled: true, allowed_org_ids: ["org-a"] }, "true"],
    [{ enabled: true, allowed_org_ids: ["org-a"] }, null]]) assert.equal(await flag(value, orgFlag), false, JSON.stringify([value, orgFlag]));
  assert.equal(await vendorDocsV3FlagOn({ query: (async () => ({ rows: [] })) as never }, "org-a"), false);
});

test("0 outbound and scoped styles", () => {
  for (const file of ["src/server/gs32-vendor-docs.ts", "src/components/v3/vendor/vendor-docs-v3.tsx", "src/components/v3/m/tickets/ticket-documents.tsx", "src/app/v/documents/[token]/page.tsx"]) {
    assert.doesNotMatch(read(file), /line\/(?:push|messaging)|sendSms|sendEmail|twilio|outbox|pushMessage|INSERT|UPDATE |DELETE /, file);
  }
  const css = read("public/brand/v3/vendor-docs.css");
  for (const line of css.split("\n").filter(line => line.includes("{"))) assert.match(line, /^\.(?:v-token-v3|v3-docs) /, line);
  assert.match(css, /\.v-docs-text \{[^}]*min-height: 44px/);
  assert.match(css, /\.v-docs-zone \{[^}]*min-height: 88px/);
});
