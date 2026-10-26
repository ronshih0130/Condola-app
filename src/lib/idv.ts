export const ID_DOC_TYPES = ["tw_national_id", "arc_resident_cert", "passport"] as const;
export type IdDocType = (typeof ID_DOC_TYPES)[number];
export const ID_SLOTS = ["front", "back", "selfie"] as const;
export type IdSlot = (typeof ID_SLOTS)[number];
export type IdReviewStatus = "pending_review" | "checked" | "returned";

export type IdCheckView = {
  documentId: string | null;
  status: "missing" | IdReviewStatus;
  docType: IdDocType | null;
  numberMasked: string | null;
  uploadedAt: string | null;
  returnReason: string | null;
  isSample: boolean;
  ready: boolean;
  retentionDays: number;
  tenantName: string;
  firmName: string;
  leaseId: string;
  contactId: string;
  slots: IdSlot[];
};

export const GLARE_SHARE = 0.18;
export const PRIVATE_BUCKET = "id-documents-private";
export const SIGNED_URL_TTL_SECONDS = 60;
/**
 * Days until a live ID photo is deleted. A lease that took effect is deleted
 * this many days after it ends. A lease that never took effect is deleted this
 * many days after the upload date. Must match id_document_keep_days().
 */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Backup copies of a deleted ID photo must be gone within this many days.
 * Supabase daily backups and point-in-time recovery are outside the app.
 * Ops sets those windows to at most this many days. See docs/STAGING.md.
 */
export const ID_BACKUP_PURGE_DAYS = 14;

/** Small baseline JPEG used for the demo sample and for tests. Not a real identity document. */
export const SAMPLE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSgBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIAAgACAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APNq988U/wD/2Q==";

const LETTER: Record<string, number> = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21, N: 22,
  O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
};
const WEIGHTS = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];

export function isIdDocType(value: string): value is IdDocType {
  return (ID_DOC_TYPES as readonly string[]).includes(value);
}

export function isIdSlot(value: string): value is IdSlot {
  return (ID_SLOTS as readonly string[]).includes(value);
}

/**
 * First character and at least three stars. Length 8 or more also keeps the last
 * three. Shorter values, including a short passport, keep only the last two.
 * A 10-character id is A******789. A 7-character passport is A****D7.
 */
export function maskIdNumber(raw: string) {
  const value = raw.trim().toUpperCase();
  const tailCap = value.length < 8 ? 2 : 3;
  const stars = Math.max(3, value.length - 1 - tailCap);
  const room = Math.max(0, value.length - stars);
  const head = Math.min(1, room);
  const tail = Math.min(tailCap, Math.max(0, room - head));
  if (head === 0) return "*".repeat(stars);
  return `${value.slice(0, head)}${"*".repeat(stars)}${tail > 0 ? value.slice(-tail) : ""}`;
}

function nationalDigits(value: string) {
  const code = LETTER[value[0] ?? ""];
  if (code === undefined) return null;
  const digits = [Math.floor(code / 10), code % 10];
  for (const char of value.slice(1)) digits.push(Number(char));
  return digits;
}

function checksumOk(digits: number[]) {
  const sum = digits.reduce((total, digit, index) => total + digit * WEIGHTS[index], 0);
  return sum % 10 === 0;
}

export function isValidIdNumber(docType: IdDocType, raw: string) {
  const value = raw.trim().toUpperCase();
  if (docType === "passport") return /^[A-Z0-9]{6,12}$/.test(value);
  if (docType === "tw_national_id") {
    if (!/^[A-Z][12]\d{8}$/.test(value)) return false;
    const digits = nationalDigits(value);
    return Boolean(digits && checksumOk(digits));
  }
  if (/^[A-Z][89]\d{8}$/.test(value)) {
    const digits = nationalDigits(value);
    return Boolean(digits && checksumOk(digits));
  }
  return /^[A-Z]{2}\d{8}$/.test(value);
}

export function requiredSlots(docType: IdDocType): IdSlot[] {
  return docType === "passport" ? ["front", "selfie"] : ["front", "back", "selfie"];
}

/** Retention is stated in days. Ninety days stays "{n} days", not one year. */
export function keepPhrase(days: number, yearLabel: string, dayLabel: string) {
  void days;
  void yearLabel;
  return dayLabel;
}

export function nearWhiteShare(pixels: ArrayLike<number>, white = 245) {
  const count = Math.floor(pixels.length / 4);
  if (!count) return 0;
  let near = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    if (pixels[offset] >= white && pixels[offset + 1] >= white && pixels[offset + 2] >= white) near += 1;
  }
  return near / count;
}

export function showsGlare(share: number) {
  return share >= GLARE_SHARE;
}

export function sampleDataUrl() {
  return `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64}`;
}

const IDENTITY_FIELD = /identity_document|id_document|number_masked|number_hash|^ciphertext$|^storage_path$|^idv$/i;

/** Photos and ID numbers stay out of every export payload. */
export function withoutIdentityFields<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const copy = { ...row };
    for (const key of Object.keys(copy)) {
      if (IDENTITY_FIELD.test(key)) delete copy[key];
    }
    return copy;
  });
}
