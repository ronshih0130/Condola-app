import * as fontkitModule from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { contractVersionDigest } from "./document";

export type SignatureStamp = {
  signerDisplayName: string;
  signedAt: string;
  /** Digest of the exact contract bytes presented to this signer. */
  documentDigest: string;
  /** Required if the name cannot be encoded by Helvetica. */
  fontBytes?: Uint8Array;
};

export function taipeiIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("Signing timestamp needs timezone");
  }
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error("Invalid signing timestamp");
  return new Date(n + 8 * 60 * 60 * 1000).toISOString().replace(/Z$/, "+08:00");
}

/**
 * Appends a signature evidence page; does not alter existing pages.
 * The caller binds the PNG to accepted stroke evidence before calling.
 * Each call hashes its exact input, preventing a stamp from naming other bytes.
 */
export async function stampSignature(
  pdfBytes: Uint8Array,
  signaturePng: Uint8Array,
  input: SignatureStamp,
): Promise<{ bytes: Uint8Array; postSigningDigest: string }> {
  const name = input.signerDisplayName.trim();
  if (!name || /[\r\n\u0000-\u001f]/.test(name)) throw new Error("Invalid signer name");
  if (await contractVersionDigest(pdfBytes) !== input.documentDigest) {
    throw new Error("Document digest mismatch");
  }
  const signedAt = taipeiIso(input.signedAt);
  const pdf = await PDFDocument.load(pdfBytes);
  const latin = await pdf.embedFont(StandardFonts.Helvetica);
  let nameFont = latin;
  try {
    latin.encodeText(name);
  } catch {
    if (!input.fontBytes?.length) throw new Error("Font bytes required for signer name");
    const mod = fontkitModule as unknown as {
      create?: unknown;
      default?: Parameters<typeof pdf.registerFontkit>[0];
    };
    const fontkit = mod.default ?? (
      fontkitModule as unknown as Parameters<typeof pdf.registerFontkit>[0]
    );
    pdf.registerFontkit(fontkit);
    nameFont = await pdf.embedFont(input.fontBytes, { subset: false });
    const supported = new Set(nameFont.getCharacterSet());
    if (Array.from(name).some((ch) => !supported.has(ch.codePointAt(0)!))) {
      throw new Error("Signer name contains unsupported glyphs");
    }
    nameFont.encodeText(name);
  }
  const image = await pdf.embedPng(signaturePng);
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText("Signature record", { x: 48, y: 780, size: 18, font: latin });
  page.drawText("Signer:", { x: 48, y: 744, size: 11, font: latin });
  const nameSize = Math.min(14, 490 / Math.max(1, nameFont.widthOfTextAtSize(name, 1)));
  if (nameSize < 8) throw new Error("Signer name too long");
  page.drawText(name, { x: 48, y: 722, size: nameSize, font: nameFont });
  page.drawText(`Signed at: ${signedAt}`, { x: 48, y: 685, size: 11, font: latin });
  page.drawText("Document SHA-256:", { x: 48, y: 651, size: 11, font: latin });
  page.drawText(input.documentDigest, { x: 48, y: 632, size: 9, font: latin });
  const scale = Math.min(480 / image.width, 200 / image.height);
  page.drawImage(image, {
    x: 48,
    y: 380,
    width: image.width * scale,
    height: image.height * scale,
  });
  const bytes = await pdf.save();
  return { bytes, postSigningDigest: await contractVersionDigest(bytes) };
}
