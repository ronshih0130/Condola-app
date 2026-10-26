import { createLease, type LeaseInput } from "./domain";
import { normalizePhone } from "./lease-rules";
import { addCalendarMonths, monthBounds, taipeiToday } from "./money";
import type { Session } from "./types";

function num(value: FormDataEntryValue | null) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : NaN;
}

function text(value: FormDataEntryValue | null) {
  return String(value ?? "");
}

function optionalNum(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function tenantContactFromForm(formData: FormData) {
  const mode = text(formData.get("tenantMode")).trim();
  if (!mode || mode === "new") return "";
  return mode;
}

export function leaseInputFromForm(formData: FormData): LeaseInput {
  const start = text(formData.get("startDate")).trim() || taipeiToday();
  const months = num(formData.get("months"));
  const end = addCalendarMonths(start, Number.isFinite(months) && months > 0 ? months : 12);
  const bounds = monthBounds(/^\d{4}-\d{2}/.test(start) ? start.slice(0, 7) : taipeiToday().slice(0, 7));
  const split = text(formData.get("splitMethod"));
  return {
    roomId: text(formData.get("roomId")),
    tenantName: text(formData.get("tenantName")),
    tenantPhone: (() => {
      const raw = text(formData.get("tenantPhone"));
      if (!raw.trim()) return "";
      const calling = text(formData.get("tenantPhoneCountry")) || text(formData.get("phoneCountry")) || "+886";
      return normalizePhone(raw, calling) ?? raw;
    })(),
    tenantEmail: text(formData.get("tenantEmail")),
    tenantContactId: tenantContactFromForm(formData),
    lineUserId: text(formData.get("lineUserId")),
    startDate: start,
    endDate: end,
    rentMajor: optionalNum(formData.get("rent")),
    depositMonths: optionalNum(formData.get("depositMonths")),
    depositReason: text(formData.get("depositReason")),
    dueDay: optionalNum(formData.get("dueDay")),
    splitMethod: (split === "days_occupied" || split === "sub_meter" ? split : "even") as LeaseInput["splitMethod"],
    periodStart: bounds.start,
    periodEnd: bounds.end,
    billTotalMajor: optionalNum(formData.get("billTotal")),
    usageKwh: optionalNum(formData.get("usage")),
    rateMajor: optionalNum(formData.get("rate")),
    rateSource: "fixed_rate",
    overrideReason: text(formData.get("overrideReason")),
    subUsages: [],
    idempotencyKey: text(formData.get("idempotencyKey")),
  };
}

/** The lease wizard's server action calls this, then the database. */
export async function createLeaseFromForm(session: Session, formData: FormData) {
  return createLease(session, leaseInputFromForm(formData));
}
