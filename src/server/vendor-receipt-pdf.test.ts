import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument, PDFName } from "pdf-lib";
import { issueVendorDocument } from "./vendor-receipt-rules";
import {
  buildVendorReceiptPdf,
  renderVendorReceiptPdf,
  sha256,
  type VendorReceiptPdfInput,
} from "./vendor-receipt-pdf";

const BANNED = [
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
];

const font = readFileSync(
  new URL("../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url),
);

function fixture(business: boolean): VendorReceiptPdfInput {
  return {
    document: issueVendorDocument({
      id: "document-1",
      vendor_profile_id: "vendor-1",
      ticket_id: "ticket-1",
      vendor_code: "V001",
      vendor: business
        ? { kind: "business", tax_id: "24536806", qualification_attested: true }
        : { kind: "individual", qualification_attested: false },
      seq: 1,
      buyer: { kind: "owner", receipt_title: "測試抬頭" },
      items: [{
        name: "清潔", quantity: 3, unit: "次",
        unit_price_minor: 33, amount_minor: 100, category: "service",
      }],
      total_minor: 100,
      ticket_actual_cost_minor: 100,
    }),
    issuer: {
      display_name: "測試師傅",
      business_name: business ? "測試商號" : null,
      representative_name: business ? "測試代表" : null,
      tax_id: business ? "24536806" : null,
      phone_e164: "+886912000111",
      address: business ? "測試地址" : null,
    },
    documentDate: "2026-10-26",
    issuedAt: "2026-10-26T04:00:00.000Z",
    workAddress: "測試維修地點",
    ticketNumber: "1027",
    ...(business ? {
      seal: {
        bytes: Uint8Array.from(Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        )),
        mimeType: "image/png" as const,
      },
    } : {}),
  };
}

function longFixture(business: boolean, count = 90): VendorReceiptPdfInput {
  const input = fixture(business);
  const items = Array.from({ length: count }, (_, index) => ({
    ...input.document.items[0],
    name: `服務${index + 1} ${"測試內容".repeat(index % 3 === 0 ? 18 : 1)}`,
  }));
  return {
    ...input,
    document: {
      ...input.document,
      items,
      total_minor: count * 100,
      uppercase_total: "新臺幣玖仟元整",
    },
  };
}

function imageCount(pdf: PDFDocument, index: number): number {
  const resources = pdf.getPage(index).node.Resources();
  const objects = resources?.lookup(PDFName.of("XObject"));
  if (!objects || !("keys" in objects)) return 0;
  return (objects as { keys(): PDFName[] }).keys().length;
}

test("fixed input and timestamp produce identical bytes and SHA-256", async () => {
  for (const business of [false, true]) {
    const input = fixture(business);
    const first = await renderVendorReceiptPdf(input, font);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await renderVendorReceiptPdf(input, font);
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.sha256, await sha256(first.bytes));
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    const parsed = await PDFDocument.load(first.bytes, { updateMetadata: false });
    assert.equal(parsed.getCreationDate()?.toISOString(), input.issuedAt);
    assert.equal(parsed.getModificationDate()?.toISOString(), input.issuedAt);
    assert.equal(parsed.getPageCount(), 1);
    assert.equal(imageCount(parsed, 0), business ? 1 : 0);
  }
});

test("document models contain required copy, ticket number and rounded prices", () => {
  const completion = buildVendorReceiptPdf(fixture(false));
  const receipt = buildVendorReceiptPdf(fixture(true));
  assert.match(JSON.stringify(completion), /本文件非稅務憑證/);
  assert.equal(receipt.title, "免用統一發票收據");
  assert.match(JSON.stringify(receipt), /統編/);
  assert.match(JSON.stringify(receipt), /工單編號/);
  assert.match(JSON.stringify(receipt), /1027/);
  assert.match(JSON.stringify(receipt), /NT\$33　NT\$100/);
  for (const word of BANNED) {
    assert.equal(JSON.stringify(completion).includes(word), false);
    assert.equal(JSON.stringify(receipt).includes(word), false);
  }
  for (const model of [completion, receipt]) {
    const header = model.blocks[0];
    assert.equal(header.kind, "rows");
    if (header.kind !== "rows") throw new Error("expected_header_rows");
    assert.deepEqual(header.rows.slice(3), [
      { label: "收據抬頭", value: "測試抬頭" },
    ]);
    assert.doesNotMatch(JSON.stringify(model), /買受人名稱|買受人地址|買受人統編|買受人統一編號|身分證/);
  }
});

test("company buyer uses the exact PDF tax label with no other banned copy", () => {
  for (const business of [false, true]) {
    const input = fixture(business);
    input.document = {
      ...input.document,
      buyer: { kind: "company", name: "測試公司", address: "測試公司地址", tax_id: "24536806" },
    };
    const model = buildVendorReceiptPdf(input);
    const header = model.blocks[0];
    assert.equal(header.kind, "rows");
    if (header.kind !== "rows") throw new Error("expected_header_rows");
    assert.deepEqual(header.rows.slice(3), [
      { label: "買受人名稱", value: "測試公司" },
      { label: "買受人地址", value: "測試公司地址" },
      { label: "買受人統一編號", value: "24536806" },
    ]);
    assert.doesNotMatch(JSON.stringify(model), /買受人統編|收據抬頭/);
    // Only this exact company-buyer field label is exempt under spec §3/B16.
    const guarded = JSON.stringify({
      ...model,
      blocks: [
        {
          ...header,
          rows: header.rows.map((row) =>
            row.label === "買受人統一編號" ? { ...row, label: "統編" } : row,
          ),
        },
        ...model.blocks.slice(1),
      ],
    });
    for (const word of BANNED) assert.equal(guarded.includes(word), false);
  }
});

test("multi-page PDFs put the seal only on the final page and remain deterministic", async () => {
  for (const business of [false, true]) {
    const input = longFixture(business);
    const first = await renderVendorReceiptPdf(input, font);
    const second = await renderVendorReceiptPdf(input, font);
    assert.deepEqual(first.bytes, second.bytes);
    const parsed = await PDFDocument.load(first.bytes);
    assert.ok(parsed.getPageCount() > 1);
    for (let index = 0; index < parsed.getPageCount(); index += 1) {
      assert.equal(
        imageCount(parsed, index),
        business && index === parsed.getPageCount() - 1 ? 1 : 0,
      );
    }
  }
});

test("PDF extraction verifies per-page identifiers and the indivisible final group", async (t) => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  } catch {
    t.skip("pdftotext is required for independent PDF text extraction");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "vendor-receipt-pdf-"));
  try {
    for (const business of [false, true]) {
      for (const count of [1, 28, 35, 90]) {
        const input = count === 1 ? fixture(business) : longFixture(business, count);
        const rendered = await renderVendorReceiptPdf(input, font);
        const path = join(directory, `${business}-${count}.pdf`);
        writeFileSync(path, rendered.bytes);
        const extracted = execFileSync("pdftotext", ["-layout", path, "-"], {
          encoding: "utf8",
        });
        const parsed = await PDFDocument.load(rendered.bytes);
        const pages = extracted.split("\f").filter((page) => page.trim());
        assert.equal(pages.length, parsed.getPageCount());
        for (let index = 0; index < pages.length; index += 1) {
          const text = pages[index].replace(/\s/g, "");
          assert.ok(text.includes(input.document.doc_no));
          assert.ok(text.includes(`page${index + 1}/${pages.length}`));
          assert.match(text, business ? /免用統一發票收據/ : /本文件非稅務憑證/);
          for (const word of BANNED) assert.equal(text.includes(word), false);
          if (index < pages.length - 1) {
            assert.doesNotMatch(text, /合計|國字大寫|廠商名稱|測試商號|測試師傅/);
          } else {
            assert.match(text, /合計/);
            assert.match(text, /國字大寫/);
            assert.match(text, business ? /測試商號/ : /測試師傅/);
            if (business) {
              assert.match(text, /測試代表/);
              assert.equal(imageCount(parsed, index), 1);
            }
          }
        }
        assert.match(pages[0].replace(/\s/g, ""), /工單編號：1027/);
        assert.match(extracted.replace(/\s/g, ""), /NT\$33NT\$100/);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt rendering rejects a missing seal", async () => {
  const input = fixture(true);
  delete input.seal;
  await assert.rejects(renderVendorReceiptPdf(input, font), /missing_seal_image/);
});

test("preview PDF carries the draft label", async () => {
  const input = { ...fixture(false), preview: true };
  const rendered = await renderVendorReceiptPdf(input, font);
  const parsed = await PDFDocument.load(rendered.bytes);
  assert.equal(parsed.getSubject(), "預覽，尚未開立");
});
