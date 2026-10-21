import { FlowError } from "./errors";

/** Private bucket. The old placeholder rows use the bucket name `receipts` and are left alone. */
export const RECEIPT_BUCKET = "receipts-private";
/** 10 MB, matching the receipt upload control. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
export const RECEIPT_HEADER_BYTES = 16;
export const RECEIPT_MIMES = ["image/jpeg", "image/png", "application/pdf"] as const;

const RECEIPT_EXT: Record<(typeof RECEIPT_MIMES)[number], string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

const RECEIPT_PATH =
  /^org\/([0-9a-f-]{36})\/receipts\/([0-9a-f-]{36})\.(jpg|png|pdf)$/i;

export type ReceiptMime = (typeof RECEIPT_MIMES)[number];

export type ReceiptClaim = {
  path: string;
  token: string;
  fileName: string;
  mime: string;
  size: number;
};

export function normalizeReceiptMime(mime: string): ReceiptMime | null {
  const value = mime === "image/jpg" ? "image/jpeg" : mime;
  return RECEIPT_MIMES.includes(value as ReceiptMime) ? (value as ReceiptMime) : null;
}

/** JPEG, PNG, or a PDF that starts with %PDF. WEBP and GIF are not receipts. */
export function sniffReceiptMime(bytes: Uint8Array): ReceiptMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  return null;
}

export function assertReceiptMeta(input: { fileName: string; mime: string; size: number }) {
  const fileName = input.fileName.trim().replace(/[/\\]/g, "_");
  if (!fileName || fileName.length > 180) throw new FlowError("errors.required");
  const mime = normalizeReceiptMime(input.mime);
  if (!mime) throw new FlowError("errors.receiptType");
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > RECEIPT_MAX_BYTES) {
    throw new FlowError("errors.receiptSize");
  }
  return { fileName, mime, size: input.size };
}

/**
 * Header signature decides the type. Declared MIME must agree with it.
 * Storage may omit a type or echo application/octet-stream.
 */
export function acceptReceiptObject(info: { size: number; mime: string; header: Uint8Array }, declaredMime: string) {
  const sniffed = sniffReceiptMime(info.header);
  const declared = normalizeReceiptMime(declaredMime);
  if (!sniffed || !declared || sniffed !== declared) throw new FlowError("errors.receiptType");
  const stored = info.mime ? normalizeReceiptMime(info.mime) : null;
  const untyped = !info.mime || info.mime === "application/octet-stream" || info.mime === "binary/octet-stream";
  if (!untyped && stored !== sniffed) throw new FlowError("errors.receiptType");
  if (!Number.isInteger(info.size) || info.size <= 0 || info.size > RECEIPT_MAX_BYTES) {
    throw new FlowError("errors.receiptSize");
  }
  return { size: info.size, mime: sniffed };
}

export function receiptPath(orgId: string, fileId: string, mime: ReceiptMime) {
  return `org/${orgId}/receipts/${fileId}${RECEIPT_EXT[mime]}`;
}

export function isReceiptPath(path: string, orgId: string) {
  const match = RECEIPT_PATH.exec(path);
  if (!match) return false;
  return match[1].toLowerCase() === orgId.toLowerCase();
}

export function receiptFileId(path: string) {
  const match = RECEIPT_PATH.exec(path);
  return match ? match[2].toLowerCase() : null;
}

export function receiptPaths(orgId: string, paths: string[]) {
  return [...new Set(paths.filter((path) => isReceiptPath(path, orgId)))];
}
