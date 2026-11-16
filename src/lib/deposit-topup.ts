/**
 * MF-3 / MGT-151 (MO-TOPUP) pure helpers, shared by the server reader/writer and the client sheet.
 * Money stays exact: integer minor-unit strings, never floats.
 */
const ZERO = BigInt(0);
/**
 * The one cap (minor units) on a single entry AND on a settlement's total paid. app.mf3_topup_record
 * enforces the same number, so every committed total stays readable by parseTopupView.
 */
export const TOPUP_MAX_MINOR = "1000000000000000";
const MAX = BigInt(TOPUP_MAX_MINOR);
const BIGINT_MAX = BigInt("9223372036854775807");

/** An entry or a paid total: a non-negative integer string no larger than TOPUP_MAX_MINOR. */
export function topupMinorWithinCap(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,16}$/.test(value) && BigInt(value) <= MAX;
}
/** A settlement figure (deposit, deductions, owed): any non-negative PostgreSQL bigint. */
export function bigintMinor(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,19}$/.test(value) && BigInt(value) <= BIGINT_MAX;
}

/** 「NT$3,000」 for TWD, 「USD 12.50」 otherwise; the fraction is shown in full only when it is non-zero (as ownerEstimateAmount). */
export function topupMoney(minor: string, currency: string, minorUnit: number): string {
  const code = currency.trim();
  const digits = /^[0-9]+$/.test(minor) ? minor.replace(/^0+(?=\d)/, "") : "0";
  const padded = digits.padStart(minorUnit + 1, "0");
  const whole = minorUnit ? padded.slice(0, -minorUnit) : padded;
  const fraction = minorUnit ? padded.slice(-minorUnit) : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (code === "TWD" ? "NT$" : code + " ") + grouped + (/[1-9]/.test(fraction) ? "." + fraction : "");
}

export type TopupAmountCheck = { ok: true; minor: string } | { ok: false; reason: "format" | "range" };
/**
 * The sheet's 金額 field in major units («2,500», «2500.5») to a minor-unit string. `format`: not a positive
 * amount with at most `minorUnit` decimals; `range`: a well-formed amount above TOPUP_MAX_MINOR.
 */
export function checkTopupAmount(text: string, minorUnit: number): TopupAmountCheck {
  const raw = text.trim().replace(/[,，\s]/g, "");
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(raw);
  if (!match) return { ok: false, reason: "format" };
  const fraction = match[2] ?? "";
  if (fraction.length > minorUnit) return { ok: false, reason: "format" };
  const minor = BigInt(match[1] + fraction.padEnd(minorUnit, "0"));
  if (minor <= ZERO) return { ok: false, reason: "format" };
  if (minor > MAX) return { ok: false, reason: "range" };
  return { ok: true, minor: minor.toString() };
}
export function parseTopupAmount(text: string, minorUnit: number): string | null {
  const checked = checkTopupAmount(text, minorUnit);
  return checked.ok ? checked.minor : null;
}

/** MGT-151-AC3: how much 已補 would exceed 應補 after this entry, as a minor-unit string ("0" when not over). */
export function topupOver(owedMinor: string, paidMinor: string, entryMinor: string | null): string {
  if (!entryMinor) return "0";
  const over = BigInt(paidMinor) + BigInt(entryMinor) - BigInt(owedMinor);
  return over > ZERO ? over.toString() : "0";
}

/** The frames' entry date, «11/20» (month/day, no leading zeros) from an ISO date. */
export function topupDay(iso: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${Number(match[1])}/${Number(match[2])}` : "";
}

/** ISO date check for the 日期 field (a real calendar day between 2000 and 2100, as the gateway allows). */
export function validTopupDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The calendar date (YYYY-MM-DD) in `timeZone` at `now`. */
export function dateIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
/**
 * The latest calendar date anywhere on Earth (UTC+14). The server helper rejects a received date after it
 * without knowing the org's zone; app.mf3_topup_record then applies the exact org-local today.
 */
export function latestLocalToday(now: Date = new Date()): string {
  return dateIn("Etc/GMT-14", now);
}
/** A received date is a valid day and not later than `today`. */
export function topupDateAllowed(value: string, today: string): boolean {
  return validTopupDate(value) && value <= today;
}

export const TOPUP_NOTE_MAX = 500;
