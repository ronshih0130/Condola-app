/**
 * Whole-NT$ electricity shares.
 * Integer arithmetic only: a unit has a handful of rooms, so this stays cheap on a Workers request.
 *
 * Split mode (分表) rounds the unit total half-up, then gives leftover NT$1 to the largest
 * fractional parts. Ties break by key ascending, so the same inputs always post the same dollars.
 * Each mode (依電表度數) rounds that meter on its own.
 */

export type ElectricityMethod = "submeter" | "by_reading" | "shared" | "tenant_direct";

const KWH_SCALE = 1000;
const RATE_SCALE = 10000;
export const MAX_RATE_MAJOR = 10000;
export const MAX_KWH = 1_000_000;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const HUNDRED_THOUSAND = BigInt(100000);
const TEN_MILLION = BigInt(10000000);

export function isPostableMethod(method: string | null | undefined): method is "submeter" | "by_reading" {
  return method === "submeter" || method === "by_reading";
}

export function kwhMilli(kwh: number): number {
  if (!Number.isFinite(kwh) || kwh < 0 || kwh > MAX_KWH) return NaN;
  const milli = Math.round(kwh * KWH_SCALE);
  if (!Number.isSafeInteger(milli)) return NaN;
  return milli;
}

/** One rate for allocation, the invoice text, the cap check, and the stored numeric. Four decimal places. */
export function normalizeRateMajor(rateMajor: number): number | null {
  if (!Number.isFinite(rateMajor) || rateMajor <= 0 || rateMajor > MAX_RATE_MAJOR) return null;
  const scaled = Math.round(rateMajor * RATE_SCALE);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) return null;
  return scaled / RATE_SCALE;
}

export function rateMinorText(rateMajor: number): string {
  const normalized = normalizeRateMajor(rateMajor);
  if (normalized == null) return "";
  return (normalized * 100).toFixed(6);
}

/** rate_minor_per_unit is major × 100, stored as numeric(18,6). */
export function rateMajorFromStored(minorText: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(minorText.trim());
  if (!match) return NaN;
  const frac = (match[3] ?? "").padEnd(3, "0");
  let scaled = Number(match[2]) * 100 + Number(frac.slice(0, 2));
  if (frac[2] >= "5") scaled += 1;
  if (!Number.isSafeInteger(scaled)) return NaN;
  return (match[1] ? -scaled : scaled) / RATE_SCALE;
}

/** Parse a numeric(14,3) kWh string without binary float error. */
export function usageMilliFromText(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return NaN;
  const digits = match[3] ?? "";
  let milli = Number(match[2]) * KWH_SCALE + Number(digits.padEnd(3, "0").slice(0, 3));
  if (digits.length > 3 && digits[3] >= "5") milli += 1;
  return match[1] ? -milli : milli;
}

/** True when the charged rate is above the bill average. Integer compare, same boundary as the cap trigger. */
export function chargedRateExceedsBill(usageMilli: number, rateMajor: number, billMinor: number): boolean {
  const scaled = rateScaled(rateMajor);
  if (!Number.isFinite(scaled) || !Number.isInteger(usageMilli) || !Number.isFinite(billMinor)) return true;
  return BigInt(scaled) * BigInt(usageMilli) > BigInt(Math.trunc(billMinor)) * HUNDRED_THOUSAND;
}

export function rateScaled(rateMajor: number): number {
  if (!Number.isFinite(rateMajor) || rateMajor < 0) return NaN;
  return Math.round(rateMajor * RATE_SCALE);
}

function divRoundHalfUp(numer: bigint, denom: bigint): bigint {
  if (denom <= ZERO) return ZERO;
  const negative = numer < ZERO;
  const abs = negative ? -numer : numer;
  const rounded = (abs + denom / BigInt(2)) / denom;
  return negative ? -rounded : rounded;
}

function moneySpec(currency: string) {
  if (currency === "TWD") return { denom: TEN_MILLION, minorPerUnit: 100 };
  return { denom: HUNDRED_THOUSAND, minorPerUnit: 1 };
}

export function formatKwhMilli(milli: number): string {
  const abs = Math.abs(Math.trunc(milli));
  const whole = Math.floor(abs / KWH_SCALE);
  const frac = String(abs % KWH_SCALE).padStart(3, "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : String(whole);
  return milli < 0 ? `-${text}` : text;
}

export function formatRateScaled(scaled: number): string {
  const abs = Math.abs(Math.trunc(scaled));
  const whole = Math.floor(abs / RATE_SCALE);
  const frac = String(abs % RATE_SCALE).padStart(4, "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : String(whole);
  return scaled < 0 ? `-${text}` : text;
}

/** Invoice line copy. Traditional Chinese, with the kWh and the rate on the line. */
export function utilityLineDescription(kwhMilliValue: number, rateMajor: number): string {
  return `電費 ${formatKwhMilli(kwhMilliValue)} 度 × ${formatRateScaled(rateScaled(rateMajor))} 元`;
}

/** Smallest bill total (cents) whose average is at least the charged rate. */
export function billMinorCeil(totalKwhMilli: number, rateMajor: number): number {
  const numer = BigInt(totalKwhMilli) * BigInt(rateScaled(rateMajor));
  const denom = HUNDRED_THOUSAND;
  if (numer <= ZERO) return 0;
  return Number((numer + denom - ONE) / denom);
}

/**
 * One occupant keeps the reading the manager entered.
 * Two or more split that reading by occupancy days. Leftover milli-kWh goes to the largest fraction, then key.
 * A zero day total cannot be split.
 */
export function prorateMilli(
  parts: { key: string; days: number }[],
  totalMilli: number,
): { key: string; kwhMilli: number }[] | null {
  if (!Number.isInteger(totalMilli) || totalMilli < 0 || parts.length === 0) return null;
  if (parts.some((part) => !Number.isInteger(part.days) || part.days < 0)) return null;
  if (parts.length === 1) return [{ key: parts[0].key, kwhMilli: totalMilli }];
  const daysSum = parts.reduce((total, part) => total + part.days, 0);
  if (daysSum <= 0) return null;
  const drafted = parts.map((part) => {
    const numer = totalMilli * part.days;
    return { key: part.key, floor: Math.floor(numer / daysSum), frac: numer % daysSum };
  });
  let remainder = totalMilli - drafted.reduce((total, row) => total + row.floor, 0);
  const order = [...drafted].sort((a, b) => {
    if (a.frac !== b.frac) return a.frac > b.frac ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const bonus = new Map<string, number>();
  for (const row of order) {
    if (remainder <= 0) break;
    bonus.set(row.key, 1);
    remainder -= 1;
  }
  return parts.map((part) => ({
    key: part.key,
    kwhMilli: (drafted.find((row) => row.key === part.key)?.floor ?? 0) + (bonus.get(part.key) ?? 0),
  }));
}

export function spreadCommonMilli(
  parts: { key: string; kwhMilli: number }[],
  totalMilli: number,
): { key: string; kwhMilli: number }[] | null {
  const sum = parts.reduce((total, part) => total + part.kwhMilli, 0);
  if (!Number.isInteger(totalMilli) || totalMilli < sum || parts.length === 0) return null;
  const common = totalMilli - sum;
  const order = [...parts].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const base = Math.floor(common / order.length);
  let extra = common - base * order.length;
  const add = new Map<string, number>();
  for (const part of order) {
    const bonus = extra > 0 ? 1 : 0;
    if (extra > 0) extra -= 1;
    add.set(part.key, base + bonus);
  }
  return parts.map((part) => ({ key: part.key, kwhMilli: part.kwhMilli + (add.get(part.key) ?? 0) }));
}

export type UtilityShare = { key: string; kwhMilli: number; amountMinor: number };

/**
 * `split` shares one rounded total. `each` rounds every meter alone.
 * Amounts are minor units. TWD amounts are whole NT$ (multiples of 100).
 */
export function allocateUtilityMinor(input: {
  currency: string;
  rateMajor: number;
  mode: "split" | "each";
  parts: { key: string; kwhMilli: number }[];
}): UtilityShare[] {
  const rate = BigInt(rateScaled(input.rateMajor));
  const spec = moneySpec(input.currency);
  const rows = input.parts.map((part) => ({ key: part.key, kwhMilli: part.kwhMilli }));
  if (input.mode === "each") {
    return rows.map((row) => ({
      key: row.key,
      kwhMilli: row.kwhMilli,
      amountMinor: Number(divRoundHalfUp(BigInt(row.kwhMilli) * rate, spec.denom)) * spec.minorPerUnit,
    }));
  }
  const weightSum = rows.reduce((total, row) => total + row.kwhMilli, 0);
  if (rows.length === 0 || weightSum <= 0) {
    return rows.map((row) => ({ ...row, amountMinor: 0 }));
  }
  const totalUnits = divRoundHalfUp(BigInt(weightSum) * rate, spec.denom);
  const drafted = rows.map((row) => {
    const numer = totalUnits * BigInt(row.kwhMilli);
    return { ...row, floor: numer / BigInt(weightSum), frac: numer % BigInt(weightSum) };
  });
  let remainder = totalUnits - drafted.reduce((total, row) => total + row.floor, ZERO);
  const order = [...drafted].sort((a, b) => {
    if (a.frac !== b.frac) return a.frac > b.frac ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const bonus = new Map<string, bigint>();
  for (const row of order) {
    if (remainder <= ZERO) break;
    bonus.set(row.key, ONE);
    remainder -= ONE;
  }
  return drafted.map((row) => ({
    key: row.key,
    kwhMilli: row.kwhMilli,
    amountMinor: Number(row.floor + (bonus.get(row.key) ?? ZERO)) * spec.minorPerUnit,
  }));
}
