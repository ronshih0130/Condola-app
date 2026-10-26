import * as fontkitModule from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { PdfBlock, PdfDocument } from "../lib/pdf-document";
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
  /** Human-facing maintenance ticket number; legacy callers fall back to ID. */
  ticketNumber?: string;
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

export async function loadVendorPdfFont(origin: string): Promise<Uint8Array> {
  const url = new URL("/fonts/DroidSansFallback-subset.ttf", origin);
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error("vendor_pdf_font_unavailable");
  return new Uint8Array(await response.arrayBuffer());
}

export function buildVendorReceiptPdf(input: VendorReceiptPdfInput): PdfDocument {
  const { document, issuer } = input;
  // TODO: CEO decision pending on the company-buyer PDF label exception to the
  // banned-copy policy; retain 買受人統編 until that decision is approved.
  const buyerRows =
    document.buyer.kind === "owner"
      ? [{ label: "收據抬頭", value: document.buyer.receipt_title }]
      : [
          { label: "買受人名稱", value: document.buyer.name },
          { label: "買受人地址", value: document.buyer.address },
          { label: "買受人統編", value: document.buyer.tax_id },
        ];
  const issuerRows = [
    { label: "廠商名稱", value: issuer.business_name || issuer.display_name },
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
          { label: "工單編號", value: input.ticketNumber ?? document.ticket_id },
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
            `NT$${Math.round(item.amount_minor / item.quantity)}　NT$${item.amount_minor}`,
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
      { kind: "text", heading: "", lines: [...document.notices] },
    ],
  };
}

function blockLines(block: PdfBlock): string[] {
  const lines = block.kind === "rows"
    ? block.rows.map((row) => `${row.label}：${row.value}`)
    : block.lines;
  return block.heading ? [block.heading, ...lines] : lines;
}

/**
 * Paginate document content before rendering. Every page has a repeated title,
 * document identifier and page count. Work-detail pages also repeat the non-tax
 * statement in the footer. The final group is indivisible, including wrapped
 * issuer details, notices and the reserved seal rectangle.
 */
export async function renderVendorReceiptPdf(
  input: VendorReceiptPdfInput,
  fontBytes: Uint8Array,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const timestamp = new Date(input.issuedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("invalid_issue_time");
  if (input.document.kind === "receipt" && !input.seal) {
    throw new Error("missing_seal_image");
  }
  const model = buildVendorReceiptPdf(input);
  const pdf = await PDFDocument.create();
  type Fontkit = Parameters<PDFDocument["registerFontkit"]>[0];
  const fontkit = fontkitModule as unknown as Fontkit & { default?: Fontkit };
  pdf.registerFontkit(fontkit.default ?? fontkit);
  const cjk = await pdf.embedFont(fontBytes, { subset: false });
  const latin = await pdf.embedFont(StandardFonts.Helvetica);

  // Measure conservatively using both faces: renderPdf selects its face per
  // glyph. Keeping a small width margin also avoids floating-point rewrapping.
  const width = (ch: string, size: number) => {
    let latinWidth = 0;
    try {
      latinWidth = latin.widthOfTextAtSize(ch, size);
    } catch {
      // Chinese text uses the bundled font.
    }
    return Math.max(cjk.widthOfTextAtSize(ch, size), latinWidth);
  };
  const wrap = (text: string, size: number): string[] => {
    const lines: string[] = [];
    for (const paragraph of text.replaceAll("\r", "").split("\n")) {
      let line = "";
      let used = 0;
      for (const ch of paragraph) {
        const next = width(ch, size);
        if (line && used + next > 495) {
          lines.push(line);
          line = "";
          used = 0;
        }
        line += ch;
        used += next;
      }
      lines.push(line);
    }
    return lines;
  };
  const flatten = (blocks: PdfBlock[]) =>
    blocks.flatMap(blockLines).flatMap((line) => wrap(line, 11));

  const body = flatten(model.blocks.slice(0, 2));
  const finalGroup = flatten(model.blocks.slice(2));
  const titleHeight = wrap(model.title, 18).length * 24;
  const subtitleHeight = model.subtitle.trim()
    ? wrap(model.subtitle, 11).length * 16
    : 0;
  // renderPdf starts at 783.89, then consumes title, subtitle and a six-point gap.
  const contentTop = 841.89 - 58 - titleHeight - subtitleHeight - 6;
  const capacity = Math.floor((contentTop - 68) / 16);
  const sealLines = input.document.kind === "receipt" ? 6 : 0;
  const finalHeight = finalGroup.length + sealLines;
  if (capacity < 1 || finalHeight > capacity) {
    throw new Error("vendor_pdf_final_group_too_large");
  }

  const pages: string[][] = [];
  let remaining = body.slice();
  while (remaining.length + finalHeight > capacity) {
    pages.push(remaining.slice(0, capacity));
    remaining = remaining.slice(capacity);
  }
  pages.push([...remaining, ...finalGroup]);
  const sealTop = contentTop - pages[pages.length - 1].length * 16;
  const footerLabel = [
    input.preview ? "預覽，尚未開立" : "",
    input.document.kind !== "receipt" ? "本文件非稅務憑證" : "",
  ].filter(Boolean).join(" | ");

  for (let index = 0; index < pages.length; index += 1) {
    const identifier = input.document.doc_no;
    const trailer = `${identifier ? `${identifier} | ` : ""}page ${index + 1}/${pages.length}`;
    const rendered = await renderPdf(
      {
        ...model,
        footerLabel,
        footerHash: trailer,
        blocks: [{ kind: "text", heading: "", lines: pages[index] }],
      },
      fontBytes,
    );
    const source = await PDFDocument.load(rendered, { updateMetadata: false });
    if (source.getPageCount() !== 1) throw new Error("vendor_pdf_pagination_overflow");
    const [page] = await pdf.copyPages(source, [0]);
    pdf.addPage(page);
  }

  if (input.document.kind === "receipt" && input.seal) {
    const image = input.seal.mimeType === "image/png"
      ? await pdf.embedPng(input.seal.bytes)
      : await pdf.embedJpg(input.seal.bytes);
    const scale = Math.min(110 / image.width, 80 / image.height);
    pdf.getPages()[pages.length - 1].drawImage(image, {
      x: 437 - (image.width * scale) / 2,
      y: sealTop - 80,
      width: image.width * scale,
      height: image.height * scale,
    });
  }

  pdf.setCreationDate(timestamp);
  pdf.setModificationDate(timestamp);
  pdf.setCreator("Condola");
  pdf.setProducer("Condola");
  pdf.setTitle(model.title);
  pdf.setSubject(input.preview ? "預覽，尚未開立" : input.document.doc_no);
  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, sha256: await sha256(bytes) };
}
