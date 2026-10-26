import { FlowError } from "./errors";

/** Status values stored on maintenance_tickets. The timeline is ticket_comments. */
export const TICKET_STATUSES = [
  "open",
  "triaged",
  "assigned",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
  "cancelled",
] as const;

export const COST_BEARERS = ["owner", "tenant", "manager", "split", "undecided"] as const;

export const PHOTO_BUCKET = "ticket-photos-private";
/** 5 MB. Same cap as the private bucket and files_ticket_photo_cap. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_LIMIT = 8;
/** Bytes read to identify JPEG, PNG, or WEBP. GIF is not accepted. */
export const PHOTO_HEADER_BYTES = 16;
export const PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

const PHOTO_EXT: Record<(typeof PHOTO_MIMES)[number], string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_PATH =
  /^org\/([0-9a-f-]{36})\/tickets\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpg|png|webp)$/i;

/** Existing public.expense_status values. Repair records must not add one. */
export const EXPENSE_STATUSES = ["draft", "submitted", "approved", "rejected", "posted", "void"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
/**
 * Nullable draft link only. The expense screen moves the row through the
 * other existing statuses and posts the ledger.
 */
export const REPAIR_EXPENSE_STATUS: ExpenseStatus = "draft";

export type PhotoMime = (typeof PHOTO_MIMES)[number];

export function isUuid(value: string) {
  return UUID.test(value);
}

export function assertTicketStatus(status: string) {
  if (!TICKET_STATUSES.includes(status as (typeof TICKET_STATUSES)[number])) throw new FlowError("errors.required");
}

export function assertCostBearer(bearer: string) {
  if (!COST_BEARERS.includes(bearer as (typeof COST_BEARERS)[number])) throw new FlowError("errors.required");
}

export function normalizePhotoMime(mime: string): PhotoMime | null {
  const value = mime === "image/jpg" ? "image/jpeg" : mime;
  return PHOTO_MIMES.includes(value as PhotoMime) ? (value as PhotoMime) : null;
}

/** File signature only. A matching extension or MIME is not enough. GIF returns null. */
export function sniffPhotoMime(bytes: Uint8Array): PhotoMime | null {
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
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function assertPhotoMeta(input: { fileName: string; mime: string; size: number }) {
  const fileName = input.fileName.trim().replace(/[/\\]/g, "_");
  if (!fileName || fileName.length > 180) throw new FlowError("errors.required");
  const mime = normalizePhotoMime(input.mime);
  if (!mime) throw new FlowError("errors.photoType");
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > PHOTO_MAX_BYTES) {
    throw new FlowError("errors.photoSize");
  }
  return { fileName, mime, size: input.size };
}

/**
 * Header signature decides the type. Declared MIME must agree with it.
 * Storage may omit a type or echo application/octet-stream; a different image type does not pass.
 */
export function acceptPhotoObject(info: { size: number; mime: string; header: Uint8Array }, declaredMime: string) {
  const sniffed = sniffPhotoMime(info.header);
  const declared = normalizePhotoMime(declaredMime);
  if (!sniffed || !declared || sniffed !== declared) throw new FlowError("errors.photoType");
  const stored = info.mime ? normalizePhotoMime(info.mime) : null;
  const untyped = !info.mime || info.mime === "application/octet-stream" || info.mime === "binary/octet-stream";
  if (!untyped && stored !== sniffed) throw new FlowError("errors.photoType");
  if (!Number.isInteger(info.size) || info.size <= 0 || info.size > PHOTO_MAX_BYTES) {
    throw new FlowError("errors.photoSize");
  }
  return { size: info.size, mime: sniffed };
}

export function ticketPhotoPath(orgId: string, ticketId: string, fileId: string, mime: PhotoMime) {
  return `org/${orgId}/tickets/${ticketId}/${fileId}${PHOTO_EXT[mime]}`;
}

export function isTicketPhotoPath(path: string, orgId: string, ticketId: string) {
  const match = PHOTO_PATH.exec(path);
  if (!match) return false;
  return match[1].toLowerCase() === orgId.toLowerCase() && match[2].toLowerCase() === ticketId.toLowerCase();
}

export function photoFileId(path: string) {
  const match = PHOTO_PATH.exec(path);
  return match ? match[3].toLowerCase() : null;
}

/** Paths the service key may sign. Anything outside this ticket is dropped. */
export function ticketPhotoPaths(orgId: string, ticketId: string, paths: string[]) {
  return [...new Set(paths.filter((path) => isTicketPhotoPath(path, orgId, ticketId)))];
}

/** A voided expense does not block a new draft. Every other existing status does. */
export function liveExpenseId(row: { id: string; status: string } | null) {
  if (!row || row.status === "void") return null;
  return row.id;
}

export function parseOptionalDate(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new FlowError("errors.date");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new FlowError("errors.date");
  }
  return value;
}

export function datesInOrder(scheduled: string | null, completed: string | null) {
  if (scheduled && completed && completed < scheduled) throw new FlowError("errors.date");
}

/** Blank clears the amount. Values are major units (TWD dollars) stored as minor. */
export function parseOptionalMoney(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  const major = Number(value);
  if (!Number.isFinite(major) || major < 0) throw new FlowError("errors.amount");
  const minor = Math.round(major * 100);
  if (!Number.isSafeInteger(minor)) throw new FlowError("errors.amount");
  return minor;
}

export function minorToInput(minor: string | null) {
  if (!minor) return "";
  const value = Number(minor);
  if (!Number.isFinite(value)) return "";
  if (value % 100 === 0) return String(value / 100);
  return (value / 100).toFixed(2);
}

export function cleanVendorName(raw: string) {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return null;
  if ([...value].length > 80) throw new FlowError("errors.required");
  return value;
}

/** Vendor master category. Required when adding a vendor. */
export function cleanVendorTrade(raw: string) {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value || [...value].length > 40) throw new FlowError("errors.required");
  return value;
}

/** A tenant may cancel only while the ticket is still 新進 (open). */
export function tenantCancelAllowed(status: string) {
  return status === "open";
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "heif", "mif1", "msf1", "heim", "heis"]);

/** ISO-BMFF ftyp brand. The browser uploads these bytes unchanged. */
export function sniffHeic(bytes: Uint8Array) {
  if (bytes.length < 12) return false;
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return false;
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
  return HEIC_BRANDS.has(brand);
}

export type ExpenseLink = "skip" | "keep" | "create";

/**
 * Opt-in only. An existing expense id is left as-is so the expense screen
 * owns later edits. No link is written when the box is unchecked.
 */
export function expenseLinkPlan(input: {
  post: boolean;
  finalMinor: number | null;
  expenseId: string | null;
  canPost: boolean;
}): ExpenseLink {
  if (!input.post) return "skip";
  if (!input.canPost) throw new FlowError("errors.forbidden");
  if (input.expenseId) return "keep";
  if (!(input.finalMinor && input.finalMinor > 0)) throw new FlowError("errors.amount");
  return "create";
}

/** Resolved or closed stamps a completion date when the form left it blank. */
export function completionDate(status: string, requested: string | null, today: string) {
  if (requested) return requested;
  if (status === "resolved" || status === "closed") return today;
  return null;
}
