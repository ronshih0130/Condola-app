/** Product rule: a deposit above this many months of rent needs a typed reason. */
export const DEPOSIT_CAP_MONTHS = 2;

/**
 * `lease_status` in the schema. There is no `signed` lease status between
 * `pending_signature` and `active`. `signed` is `lease_signatures.status`.
 * `esign_status` is separate: not_sent, sent, partially_signed, fully_signed,
 * declined, voided.
 *
 * One signature left keeps the lease at draft or pending_signature and sets
 * esign_status to partially_signed. The last signature (`signLease`) and a
 * stored paper PDF (`uploadSignedLeasePdf`) move draft or pending_signature
 * straight to active, with esign_status fully_signed and signed_at set.
 */
export const LEASE_STATUSES = ["draft", "pending_signature", "active", "ended", "terminated", "cancelled"] as const;

export type LeaseStatus = (typeof LEASE_STATUSES)[number];

/** The warning and reason box open only while the edited months are over the cap and differ from the saved months. */
export function depositReasonEditorOpen(editedMonths: string, savedMonths: string) {
  const edited = Number(editedMonths);
  if (!Number.isFinite(edited) || edited <= DEPOSIT_CAP_MONTHS) return false;
  const saved = Number(savedMonths);
  if (Number.isFinite(saved) && edited === saved) return false;
  return true;
}

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

/**
 * Fail closed above the product cap. Missing deposit-rule result and block
 * reject the save. A typed reason is not rejected just because the latest
 * deposit result is warn. Under the cap, a jurisdiction warn stays a warning.
 */
export function depositCapSaveAllowed(depositMonths: number, outcome: string | null, reasonOk = false) {
  if (!depositExceedsCap(depositMonths)) return true;
  if (!reasonOk || outcome == null || outcome === "block") return false;
  return outcome === "overridden" || outcome === "warn";
}

/**
 * Rent and deposit are part of document_sha256, the bytes the parties sign.
 * There is no amendment document, so a signed or active lease cannot be edited in place.
 */
export function leaseTermsEditable(input: { status: string; esign: string; signed: boolean }) {
  if (input.signed) return false;
  if (input.status !== "draft" && input.status !== "pending_signature") return false;
  return input.esign === "not_sent" || input.esign === "sent";
}

/** Soft warning only when the deposit is still within two months of rent. */
export function depositWarnFlag(depositMonths: number, outcome: string | null) {
  return !depositExceedsCap(depositMonths) && outcome === "warn";
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

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Blank means this create has no retry key. Anything else must be a UUID. */
export function normalizeIdempotencyKey(value: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return { ok: true, value: null };
  if (!IDEMPOTENCY_KEY.test(trimmed)) return { ok: false };
  return { ok: true, value: trimmed.toLowerCase() };
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
