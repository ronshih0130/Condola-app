/** Integer money for the rent-settlement flow. Amounts stay in minor units (TWD exponent 2). */

export const RENT_SETTLEMENT_FLAG = "rent_settlement";

export const SETTLEMENT_METHODS = ["bank_transfer", "cash", "check", "other"] as const;

export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

const TAIPEI = "Asia/Taipei";

export type FeeRuleExact = {
  kind: string;
  hybridMode: string | null;
  percentBp: bigint;
  fixedMinor: bigint;
  minimumMinor: bigint;
};

export type ChargeMinor = {
  charge_type: string;
  amount_minor: bigint;
  description: string;
};

export type AttributedMinor = {
  rent: bigint;
  utility: bigint;
  deposit: bigint;
  other: bigint;
};

export type SettlementPayment = {
  status: string;
  paidOn: string;
  rentMinor: bigint;
  utilityMinor: bigint;
  otherMinor: bigint;
  depositMinor: bigint;
};

export type MonthSettlement = {
  rentMinor: bigint;
  otherMinor: bigint;
  feeMinor: bigint;
  expenseMinor: bigint;
  netMinor: bigint;
  owesMinor: bigint;
  payableMinor: bigint;
};

type FlagInput = {
  environment: string;
  planTier: string | null | undefined;
  featureFlags: unknown;
};

function flagRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * On only when the flag is stored true and the org is the sample company (sandbox)
 * or a beta plan. A pro, free, or business firm stays off even if the key is set.
 */
export function rentSettlementEnabled(input: FlagInput): boolean {
  const flags = flagRecord(input.featureFlags);
  if (flags[RENT_SETTLEMENT_FLAG] !== true) return false;
  return input.environment === "sandbox" || input.planTier === "beta";
}

export function isSettlementMethod(value: string): value is SettlementMethod {
  return (SETTLEMENT_METHODS as readonly string[]).includes(value);
}

/** Whole NT$ for TWD. Other currencies accept at most two decimal digits, parsed as text. */
export function parseAmountToMinor(raw: string, currency: string): bigint | null {
  const code = currency.trim().toUpperCase();
  const cleaned = raw.trim().replace(/,/g, "").replace(/^NT\$/i, "").replace(/^\$/, "");
  if (!cleaned || cleaned.length > 14) return null;
  if (code === "TWD") {
    if (!/^[0-9]+$/.test(cleaned)) return null;
    const dollars = BigInt(cleaned);
    if (dollars <= BigInt(0)) return null;
    return dollars * BigInt(100);
  }
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const minor = BigInt(whole) * BigInt(100) + BigInt((frac + "00").slice(0, 2));
  if (minor <= BigInt(0)) return null;
  return minor;
}

/** Calendar date in Asia/Taipei. Used before a timestamp is stored as paid_on. */
export function taipeiCalendarDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TAIPEI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return "";
  return `${year}-${month}-${day}`;
}

export function parseCivilDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

export function parseMonth(value: string | undefined, today: string): string {
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  return today.slice(0, 7);
}

export function monthLastDay(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(end).padStart(2, "0")}`;
}

export function monthWindow(month: string): { start: string; end: string } {
  return { start: `${month}-01`, end: monthLastDay(month) };
}

/** Inclusive civil-date window. 2026-03-31 is March; 2026-04-01 is not. */
export function inCivilMonth(paidOn: string, month: string): boolean {
  const day = parseCivilDate(paidOn);
  if (!day || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
  const bounds = monthWindow(month);
  return day >= bounds.start && day <= bounds.end;
}

/**
 * Month of an instant in Asia/Taipei.
 * 2026-03-31T15:59:59Z is still March; 2026-03-31T16:00:00Z is April.
 */
export function instantSettlementMonth(iso: string): string | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const day = taipeiCalendarDate(instant);
  return day ? day.slice(0, 7) : null;
}

export function defaultPaidOn(month: string, today: string): string {
  if (today.slice(0, 7) === month && parseCivilDate(today)) return today;
  return `${month}-15`;
}

function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0) || numerator <= BigInt(0)) return BigInt(0);
  return (numerator + denominator / BigInt(2)) / denominator;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Fee on the month's rent, once. Half-up basis points, no binary float. */
export function managementFeeExact(rule: FeeRuleExact, rentMinor: bigint): bigint {
  const rent = rentMinor > BigInt(0) ? rentMinor : BigInt(0);
  const percent = divRoundHalfUp(rent * (rule.percentBp > BigInt(0) ? rule.percentBp : BigInt(0)), BigInt(10_000));
  const fixed = rule.fixedMinor > BigInt(0) ? rule.fixedMinor : BigInt(0);
  const minimum = rule.minimumMinor > BigInt(0) ? rule.minimumMinor : BigInt(0);
  if (rule.kind === "fixed") return fixed;
  if (rule.kind === "percent") return percent;
  if (rule.kind === "hybrid" && rule.hybridMode === "percent_with_minimum") return maxBig(percent, minimum);
  if (rule.kind === "hybrid" && rule.hybridMode === "greater_of") return maxBig(percent, fixed);
  if (rule.kind === "hybrid" && rule.hybridMode === "fixed_plus_percent") return fixed + percent;
  return BigInt(0);
}

function netElectricity(lines: ChargeMinor[]): ChargeMinor[] {
  let offset = BigInt(0);
  for (const line of lines) {
    if (line.charge_type === "credit" && line.description.startsWith("沖銷電費")) offset -= line.amount_minor;
  }
  if (offset === BigInt(0)) {
    return lines.filter((line) => !(line.charge_type === "credit" && line.description.startsWith("沖銷電費")));
  }
  const netted: ChargeMinor[] = [];
  for (const line of lines) {
    if (line.charge_type === "credit" && line.description.startsWith("沖銷電費")) continue;
    if (line.charge_type === "utility" && offset > BigInt(0) && line.amount_minor > BigInt(0)) {
      const take = offset < line.amount_minor ? offset : line.amount_minor;
      offset -= take;
      netted.push({ ...line, amount_minor: line.amount_minor - take });
    } else {
      netted.push(line);
    }
  }
  return netted;
}

const PAYMENT_ORDER = ["rent", "add_on", "late_fee", "one_off", "maintenance", "utility", "deposit", "adjustment", "credit"];

/** Same waterfall as attributePayment, in bigint minor units. Deposit stays out of rent. */
export function attributeMinor(lines: ChargeMinor[], paidMinor: bigint): AttributedMinor {
  const buckets: AttributedMinor = { rent: BigInt(0), utility: BigInt(0), deposit: BigInt(0), other: BigInt(0) };
  let left = paidMinor > BigInt(0) ? paidMinor : BigInt(0);
  const sorted = netElectricity(lines).slice().sort((a, b) => {
    const ar = PAYMENT_ORDER.indexOf(a.charge_type);
    const br = PAYMENT_ORDER.indexOf(b.charge_type);
    return (ar === -1 ? PAYMENT_ORDER.length : ar) - (br === -1 ? PAYMENT_ORDER.length : br);
  });
  for (const line of sorted) {
    if (left <= BigInt(0)) break;
    const room = line.amount_minor > BigInt(0) ? line.amount_minor : BigInt(0);
    const take = left < room ? left : room;
    left -= take;
    if (line.charge_type === "rent") buckets.rent += take;
    else if (line.charge_type === "utility") buckets.utility += take;
    else if (line.charge_type === "deposit") buckets.deposit += take;
    else buckets.other += take;
  }
  return buckets;
}

export function projectMonth(payments: SettlementPayment[], month: string, fee: FeeRuleExact, expenseMinor: bigint): MonthSettlement {
  let rent = BigInt(0);
  let utility = BigInt(0);
  let other = BigInt(0);
  for (const payment of payments) {
    if (payment.status !== "confirmed") continue;
    if (!inCivilMonth(payment.paidOn, month)) continue;
    rent += payment.rentMinor;
    utility += payment.utilityMinor;
    other += payment.otherMinor;
  }
  const expenses = expenseMinor > BigInt(0) ? expenseMinor : BigInt(0);
  const feeMinor = managementFeeExact(fee, rent);
  const otherMinor = utility + other;
  const netMinor = rent + otherMinor - feeMinor - expenses;
  return {
    rentMinor: rent,
    otherMinor,
    feeMinor,
    expenseMinor: expenses,
    netMinor,
    owesMinor: netMinor < BigInt(0) ? -netMinor : BigInt(0),
    payableMinor: netMinor > BigInt(0) ? netMinor : BigInt(0),
  };
}

export function minorToAmountText(minor: bigint, currency: string): string {
  const code = currency.trim().toUpperCase();
  const negative = minor < BigInt(0);
  const abs = negative ? -minor : minor;
  const whole = abs / BigInt(100);
  const frac = abs % BigInt(100);
  const body =
    code === "TWD"
      ? (frac >= BigInt(50) ? whole + BigInt(1) : whole).toString()
      : frac === BigInt(0)
        ? whole.toString()
        : `${whole}.${frac.toString().padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

export function minorNumber(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max || value < -max) throw new Error("amount exceeds exact integer range");
  return Number(value);
}

function csvQuote(value: string) {
  const safe = /^[\s]*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export type CsvSettlementRow = {
  ownerName: string;
  month: string;
  currency: string;
  rentMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
};

export function settlementCsv(
  rows: CsvSettlementRow[],
  labels: { owner: string; month: string; currency: string; rent: string; fee: string; net: string },
): string {
  const header = [labels.owner, labels.month, labels.currency, labels.rent, labels.fee, labels.net].map(csvQuote).join(",");
  const lines = rows.map((row) =>
    [
      csvQuote(row.ownerName),
      csvQuote(row.month),
      csvQuote(row.currency),
      csvQuote(minorToAmountText(row.rentMinor, row.currency)),
      csvQuote(minorToAmountText(row.feeMinor, row.currency)),
      csvQuote(minorToAmountText(row.netMinor, row.currency)),
    ].join(","),
  );
  return `\uFEFF${[header, ...lines].join("\n")}\n`;
}
