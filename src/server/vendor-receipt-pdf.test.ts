import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
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
  const document = issueVendorDocument({
    id: "document-1",
    vendor_profile_id: "vendor-1",
    ticket_id: "ticket-1",
    vendor_code: "V001",
    vendor: business
      ? { kind: "business", tax_id: "24536806", qualification_attested: true }
      : { kind: "individual", qualification_attested: false },
    seq: 1,
    buyer: { kind: "owner", receipt_title: "測試抬頭" },
    items: [
      {
        name: "清潔",
        quantity: 2,
        unit: "次",
        unit_price_minor: 600,
        amount_minor: 1200,
        category: "service",
      },
    ],
    total_minor: 1200,
    ticket_actual_cost_minor: 1200,
  });
  return {
    document,
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
    ...(business
      ? {
          seal: {
            bytes: Uint8Array.from(
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                "base64",
              ),
            ),
            mimeType: "image/png" as const,
          },
        }
      : {}),
  };
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
    // Inspect persisted metadata without pdf-lib replacing ModDate on load.
    const parsed = await PDFDocument.load(first.bytes, { updateMetadata: false });
    assert.equal(parsed.getCreationDate()?.toISOString(), input.issuedAt);
    assert.equal(parsed.getModificationDate()?.toISOString(), input.issuedAt);
  }
});

test("document models contain required copy and exclude banned copy", () => {
  const completion = buildVendorReceiptPdf(fixture(false));
  const receipt = buildVendorReceiptPdf(fixture(true));
  assert.match(JSON.stringify(completion), /本文件非稅務憑證/);
  assert.equal(receipt.title, "免用統一發票收據");
  assert.match(JSON.stringify(receipt), /統編/);
  for (const word of BANNED) {
    assert.equal(JSON.stringify(completion).includes(word), false);
    assert.equal(JSON.stringify(receipt).includes(word), false);
  }
  assert.doesNotMatch(JSON.stringify(completion), /買受人地址|買受人統編/);
});

test("generated PDFs extract required Chinese text and contain no banned copy", async (t) => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  } catch {
    t.skip("pdftotext is required for independent PDF text extraction");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "vendor-receipt-pdf-"));
  try {
    for (const business of [false, true]) {
      const rendered = await renderVendorReceiptPdf(fixture(business), font);
      const path = join(directory, `${business}.pdf`);
      writeFileSync(path, rendered.bytes);
      const text = execFileSync("pdftotext", ["-layout", path, "-"], {
        encoding: "utf8",
      }).replace(/\s/g, "");
      assert.match(
        text,
        business ? /免用統一發票收據/ : /本文件非稅務憑證/,
      );
      if (business) assert.match(text, /統編/);
      for (const word of BANNED) {
        assert.equal(text.includes(word), false);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt rendering rejects a missing seal", async () => {
  const input = fixture(true);
  delete input.seal;
  await assert.rejects(
    renderVendorReceiptPdf(input, font),
    /missing_seal_image/,
  );
});

test("preview PDF carries the draft label", async () => {
  const input = { ...fixture(false), preview: true };
  const rendered = await renderVendorReceiptPdf(input, font);
  const parsed = await PDFDocument.load(rendered.bytes);
  assert.equal(parsed.getSubject(), "預覽，尚未開立");
});
