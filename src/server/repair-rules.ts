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
export const PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const PHOTO_EXT: Record<(typeof PHOTO_MIMES)[number], string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_PATH =
  /^org\/([0-9a-f-]{36})\/tickets\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpg|png|webp|gif)$/i;

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

/** Object metadata only. Callers must not download or re-encode the bytes. */
export function acceptPhotoObject(info: { size: number; mime: string }, declaredMime: string) {
  const stored = normalizePhotoMime(info.mime);
  const declared = normalizePhotoMime(declaredMime);
  if (!stored || !declared || stored !== declared) throw new FlowError("errors.photoType");
  if (!Number.isInteger(info.size) || info.size <= 0 || info.size > PHOTO_MAX_BYTES) {
    throw new FlowError("errors.photoSize");
  }
  return { size: info.size, mime: stored };
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
