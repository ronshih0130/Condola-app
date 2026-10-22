import { createHash, randomBytes } from "node:crypto";
import { parseAmountCents } from "./expenses";
import { FlowError } from "./errors";
import { normalizePhone } from "./lease-rules";
import { cleanVendorName } from "./repair-rules";

/** How long a vendor link works. The manager can turn it off sooner. */
export const VENDOR_LINK_DAYS = 14;

/** feature_flags key. False turns the flow off. Absent stays on for beta and the sample company. */
export const VENDOR_FLAG = "vendor_dispatch";

const TOKEN = /^[A-Za-z0-9_-]{43,}$/;

const DISPATCHABLE = new Set(["open", "triaged", "assigned", "in_progress", "on_hold"]);

export function vendorDispatchEnabled(input: { environment: string; planTier: string; featureFlags: unknown }) {
  const flags =
    input.featureFlags && typeof input.featureFlags === "object"
      ? (input.featureFlags as Record<string, unknown>)
      : {};
  if (flags[VENDOR_FLAG] === false || flags[VENDOR_FLAG] === "false") return false;
  return input.environment === "sandbox" || input.planTier === "beta";
}

export function newVendorToken() {
  return randomBytes(32).toString("base64url");
}

export function vendorTokenAcceptable(token: string) {
  const value = token.trim();
  if (!TOKEN.test(value)) return false;
  return Buffer.from(value, "base64url").length >= 32;
}

export function hashVendorToken(token: string) {
  return createHash("sha256").update(token.trim()).digest("hex");
}

export function vendorJobPath(token: string) {
  return `/v/${encodeURIComponent(token.trim())}`;
}

/** Same fail-closed rule as app.open_vendor_job. Expired, revoked, inactive, or flag off is closed. */
export function vendorLinkOpen(input: { active: boolean; revoked: boolean; expiresAt: Date; now: Date; enabled: boolean }) {
  if (!input.enabled || !input.active || input.revoked) return false;
  return input.expiresAt.getTime() > input.now.getTime();
}

export function dispatchableTicket(status: string) {
  return DISPATCHABLE.has(status);
}

export function reportableTicket(status: string) {
  return DISPATCHABLE.has(status) || status === "resolved";
}

export function vendorPhone(raw: string, callingCode: string) {
  const phone = normalizePhone(raw, callingCode);
  if (!phone) throw new FlowError("errors.phone");
  return phone;
}

/** Taiwan mobiles are shown as 09. Anything else stays E.164. */
export function displayVendorPhone(e164: string) {
  if (/^\+8869\d{8}$/.test(e164)) return `0${e164.slice(4)}`;
  return e164;
}

export function cleanContactWindow(raw: string) {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value || [...value].length > 160) throw new FlowError("errors.required");
  return value;
}

export function vendorCostMinor(raw: string) {
  const cents = parseAmountCents(raw);
  if (!Number.isInteger(cents)) throw new FlowError("errors.expenseAmount");
  return cents;
}

export function vendorName(raw: string) {
  const name = cleanVendorName(raw);
  if (!name) throw new FlowError("errors.required");
  return name;
}

/** M04b categories. Stored as codes; the labels are i18n. */
export const VENDOR_CATEGORIES = ["water", "climate", "lock", "leak", "other"] as const;

export const VENDOR_CATEGORY_KEY: Record<(typeof VENDOR_CATEGORIES)[number], string> = {
  water: "i_vendor_cat_water",
  climate: "i_vendor_cat_climate",
  lock: "i_vendor_cat_lock",
  leak: "i_vendor_cat_leak",
  other: "i_vendor_cat_other",
};

export function vendorCategory(raw: string) {
  const value = raw.trim();
  if (!VENDOR_CATEGORIES.includes(value as (typeof VENDOR_CATEGORIES)[number])) throw new FlowError("errors.required");
  return value;
}

/** Latest cooperation month from a YYYY-MM-DD repair date. No stored column. */
export function lastCooperationParts(iso: string | null | undefined) {
  const match = /^(\d{4})-(\d{2})-\d{2}/.exec(iso ?? "");
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year: match[1], month: String(month) };
}

/** Keep the schedule check happy when the visit date is still in the future. */
export function vendorCompletedOn(scheduled: string | null, today: string) {
  if (scheduled && scheduled > today) return scheduled;
  return today;
}
