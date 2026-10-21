/** Product rule: a deposit above this many months of rent needs a typed reason. */
export const DEPOSIT_CAP_MONTHS = 2;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
export const MAX_SIGNED_PDF_BYTES = 8 * 1024 * 1024;

export function depositExceedsCap(depositMonths: number) {
  return Number.isFinite(depositMonths) && depositMonths > DEPOSIT_CAP_MONTHS;
}

/** True when the lease may be saved. Over-cap deposits need a non-blank reason. */
export function depositReasonOk(depositMonths: number, reason: string) {
  if (!depositExceedsCap(depositMonths)) return true;
  return reason.trim().length > 0;
}

/** +E.164 as typed, or a Taiwan mobile 09xxxxxxxx (spaces and dashes allowed) as +886. */
export function normalizePhone(phone: string): string | null {
  const value = phone.trim();
  if (!value) return null;
  if (/^\+[1-9]\d{6,14}$/.test(value)) return value;
  const digits = value.replace(/\D/g, "");
  if (/^09\d{8}$/.test(digits)) return `+886${digits.slice(1)}`;
  return null;
}

export function normalizeLineId(value: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > 64 || /[\u0000-\u001f]/.test(trimmed)) return { ok: false };
  return { ok: true, value: trimmed };
}

export function isSignedPdf(bytes: Uint8Array) {
  if (bytes.length < 5 || bytes.length > MAX_SIGNED_PDF_BYTES) return false;
  return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

export function signedPdfName(name: string) {
  const base = name.split(/[/\\]/).pop()?.trim() || "signed.pdf";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").slice(0, 120);
  if (!cleaned) return "signed.pdf";
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}
