import { PDFDocument } from "pdf-lib";
import type { PdfDocument } from "../lib/pdf-document";
import { renderPdf } from "../lib/pdf-render";
import type { VendorDocument } from "./vendor-receipt-rules";

export interface VendorPdfIssuer {
  display_name: string;
  business_name: string | null;
  representative_name: string | null;
  tax_id: string | null;
  phone_e164: string;
  address: string | null;
}

export interface VendorReceiptPdfInput {
  document: VendorDocument;
  issuer: VendorPdfIssuer;
  documentDate: string;
  issuedAt: string;
  workAddress: string;
  preview?: boolean;
  seal?: { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Uses the same lazy, bundled Traditional Chinese font as pdf-client.ts.
 * An absolute trusted application origin is required on the server.
 * Tests and asset-binding callers can instead pass font bytes directly.
 */
export async function loadVendorPdfFont(origin: string): Promise<Uint8Array> {
  const url = new URL("/fonts/DroidSansFallback-subset.ttf", origin);
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error("vendor_pdf_font_unavailable");
  return new Uint8Array(await response.arrayBuffer());
}

export function buildVendorReceiptPdf(input: VendorReceiptPdfInput): PdfDocument {
  const { document, issuer } = input;
  const buyerRows =
    document.buyer.kind === "owner"
      ? [{ label: "收據抬頭", value: document.buyer.receipt_title }]
      : [
          { label: "買受人名稱", value: document.buyer.name },
          { label: "買受人地址", value: document.buyer.address },
          { label: "買受人統編", value: document.buyer.tax_id },
        ];
  const issuerRows = [
    {
      label: "廠商名稱",
      value: issuer.business_name || issuer.display_name,
    },
    { label: "電話", value: issuer.phone_e164 },
  ];
  if (document.kind === "receipt") {
    if (!issuer.tax_id || !issuer.address || !issuer.representative_name) {
      throw new Error("vendor_profile_incomplete");
    }
    issuerRows.push(
      { label: "統編", value: issuer.tax_id },
      { label: "營業地址", value: issuer.address },
      { label: "負責人", value: issuer.representative_name },
    );
  }
  return {
    filename: "vendor-document.pdf",
    title: document.title,
    subtitle: input.preview ? "預覽，尚未開立" : document.doc_no,
    footerLabel: "",
    footerHash: "",
    blocks: [
      {
        kind: "rows",
        heading: "",
        rows: [
          { label: "日期", value: input.documentDate },
          { label: "維修地點", value: input.workAddress },
          ...buyerRows,
        ],
      },
      {
        kind: "text",
        heading: "品項／服務內容　數量　單位　單價　金額",
        lines: document.items.map(
          (item) =>
            `${item.name}　${item.quantity}　${item.unit}　` +
            `NT$${item.unit_price_minor}　NT$${item.amount_minor}`,
        ),
      },
      {
        kind: "rows",
        heading: "",
        rows: [
          { label: "合計", value: `NT$${document.total_minor}` },
          { label: "國字大寫", value: document.uppercase_total },
          ...issuerRows,
        ],
      },
      {
        kind: "text",
        heading: "",
        lines: [...document.notices],
      },
    ],
  };
}

/** Final artifact metadata uses only the injected issue time. */
export async function renderVendorReceiptPdf(
  input: VendorReceiptPdfInput,
  fontBytes: Uint8Array,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const timestamp = new Date(input.issuedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("invalid_issue_time");
  const model = buildVendorReceiptPdf(input);
  const rendered = await renderPdf(model, fontBytes);
  const pdf = await PDFDocument.load(rendered, { updateMetadata: false });

  // Replace renderPdf's wall-clock metadata before saving the final artifact.
  pdf.setCreationDate(timestamp);
  pdf.setModificationDate(timestamp);
  pdf.setCreator("Condola");
  pdf.setProducer("Condola");
  pdf.setTitle(model.title);
  pdf.setSubject(input.preview ? "預覽，尚未開立" : input.document.doc_no);

  if (input.document.kind === "receipt") {
    if (!input.seal) throw new Error("missing_seal_image");
    const image =
      input.seal.mimeType === "image/png"
        ? await pdf.embedPng(input.seal.bytes)
        : await pdf.embedJpg(input.seal.bytes);
    const scale = Math.min(110 / image.width, 80 / image.height);
    const page = pdf.addPage([595.28, 841.89]);
    page.drawImage(image, {
      x: 437 - (image.width * scale) / 2,
      y: 650,
      width: image.width * scale,
      height: image.height * scale,
    });
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, sha256: await sha256(bytes) };
}
