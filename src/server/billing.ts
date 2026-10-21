/** Whole NT$ prices. Subscription invoices, estimates, and the pricing calculator all call quoteMonthly. */

export const LIST_STANDARD = 30;
export const LIST_PRO = 40;
export const FREE_UNITS = 4;

export type PaidTier = "standard" | "pro";
export type PriceSource = "override" | "code" | "list";

export type PriceOverride = { rate: number; lockedUntil: string | null };
export type PriceSnapshot = {
  standardPrice: number;
  proPrice: number;
  freeUnits: number;
  lockedUntil: string | null;
};

function inForce(until: string | null | undefined, now: Date) {
  if (!until) return true;
  const time = Date.parse(until);
  return Number.isFinite(time) && time > now.getTime();
}

/** Billable units are those past the free allowance, each at the same rate. */
export function monthlyAmount(input: { units: number; rate: number; freeUnits?: number }) {
  const units = Math.max(0, Math.floor(input.units));
  const free = Math.max(0, input.freeUnits ?? FREE_UNITS);
  const rate = Math.max(0, input.rate);
  return Math.max(0, units - free) * rate;
}

/** Yearly is 11 × monthly: one month free. */
export function yearlyAmount(monthly: number) {
  return monthly * 11;
}

export function seatLimit(tier: string | null | undefined): number | null {
  if (tier === "free") return 1;
  if (tier === "standard") return 5;
  return null;
}

/** Override rate wins over the code snapshot. The snapshot wins over list price while its lock is in force. */
export function resolveCommercialPrice(input: {
  tier: PaidTier;
  now: Date;
  override?: PriceOverride | null;
  snapshot?: PriceSnapshot | null;
}): { rate: number; freeUnits: number; source: PriceSource } {
  const overrideOn = Boolean(input.override && inForce(input.override.lockedUntil, input.now));
  const codeOn = Boolean(input.snapshot && inForce(input.snapshot.lockedUntil, input.now));
  const freeUnits = codeOn ? input.snapshot!.freeUnits : FREE_UNITS;
  if (overrideOn) return { rate: input.override!.rate, freeUnits, source: "override" };
  if (codeOn) {
    const rate = input.tier === "pro" ? input.snapshot!.proPrice : input.snapshot!.standardPrice;
    return { rate, freeUnits, source: "code" };
  }
  return { rate: input.tier === "pro" ? LIST_PRO : LIST_STANDARD, freeUnits: FREE_UNITS, source: "list" };
}

export function quoteMonthly(input: {
  units: number;
  tier: PaidTier;
  cycle: "month" | "year";
  now: Date;
  override?: PriceOverride | null;
  snapshot?: PriceSnapshot | null;
}) {
  const price = resolveCommercialPrice(input);
  const monthly = monthlyAmount({ units: input.units, rate: price.rate, freeUnits: price.freeUnits });
  const yearly = yearlyAmount(monthly);
  return { ...price, monthly, yearly, due: input.cycle === "year" ? yearly : monthly };
}

export function formatNt(amount: number) {
  return `NT$${Math.round(amount).toLocaleString("en-US")}`;
}

export function firmDisplayName(kind: "firm" | "self", name: string, email: string) {
  const trimmed = name.trim();
  if (kind === "firm") return trimmed;
  const local = email.split("@")[0]?.trim() || "我";
  return trimmed || `${local} 的租屋`;
}

export function normalizePartnerCode(value: string) {
  const code = value.trim().toUpperCase();
  if (!code) return "";
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) return null;
  return code;
}
