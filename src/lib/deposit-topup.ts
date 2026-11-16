/**
 * MF-3 / MGT-151 (MO-TOPUP) pure helpers, shared by the server reader and the client sheet.
 * Money stays exact: integer minor-unit strings, never floats.
 */
const ZERO = BigInt(0);
const MAX_MINOR = BigInt("1000000000000000");

/** 「NT$3,000」 for TWD, 「USD 12.50」 otherwise; fractional digits only when non-zero (as ownerEstimateAmount). */
export function topupMoney(minor: string, currency: string, minorUnit: number): string {
  const code = currency.trim();
  const digits = /^[0-9]+$/.test(minor) ? minor.replace(/^0+(?=\d)/, "") : "0";
  const padded = digits.padStart(minorUnit + 1, "0");
  const whole = minorUnit ? padded.slice(0, -minorUnit) : padded;
  const fraction = minorUnit ? padded.slice(-minorUnit) : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const value = grouped + (/[1-9]/.test(fraction) ? "." + fraction.replace(/0+$/, "") : "");
  return (code === "TWD" ? "NT$" : code + " ") + value;
}

/**
 * The sheet's 金額 field in major units («2,500», «2500.5») to a minor-unit string. Null when it is
 * not a positive amount with at most `minorUnit` decimals.
 */
export function parseTopupAmount(text: string, minorUnit: number): string | null {
  const raw = text.trim().replace(/[,，\s]/g, "");
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(raw);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > minorUnit) return null;
  const minor = BigInt(match[1] + fraction.padEnd(minorUnit, "0"));
  if (minor <= ZERO || minor > MAX_MINOR) return null;
  return minor.toString();
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

export const TOPUP_NOTE_MAX = 500;
