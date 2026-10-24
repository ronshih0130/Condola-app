export function toMinor(major: number): number {
  if (!Number.isFinite(major)) return NaN;
  return Math.round(major * 100);
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampRatio(value: number): number {
  const rounded = Math.round(value * 1e10) / 1e10;
  if (rounded < 0) return 0;
  if (rounded > 1) return 1;
  return rounded;
}

export type Share = {
  key: string;
  usage: number;
  amount: number;
  ratio: number;
  days?: number;
  sub?: number;
};

export function splitWeighted(
  totalUsage: number,
  totalAmount: number,
  parts: { key: string; weight: number; days?: number; sub?: number }[],
): Share[] {
  const weightSum = parts.reduce((sum, part) => sum + part.weight, 0);
  if (parts.length === 0) return [];
  if (weightSum <= 0) {
    return splitWeighted(
      totalUsage,
      totalAmount,
      parts.map((part) => ({ ...part, weight: 1 })),
    );
  }
  let usedAmount = 0;
  let usedUsage = 0;
  let usedRatio = 0;
  return parts.map((part, index) => {
    const last = index === parts.length - 1;
    const ratio = last ? clampRatio(1 - usedRatio) : clampRatio(part.weight / weightSum);
    const amount = last ? totalAmount - usedAmount : Math.round((totalAmount * part.weight) / weightSum);
    const usage = last ? round3(totalUsage - usedUsage) : round3((totalUsage * part.weight) / weightSum);
    if (!last) {
      usedAmount += amount;
      usedUsage += usage;
      usedRatio += ratio;
    }
    return { key: part.key, amount, usage, ratio, days: part.days, sub: part.sub };
  });
}

export function inclusiveDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (end < start) return 0;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

export function monthBounds(month: string): { start: string; end: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  const endDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(endDay).padStart(2, "0")}`,
  };
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addCalendarMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

export function addYears(iso: string, years: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return addDays(date.toISOString().slice(0, 10), -1);
}

type FeeRule = {
  kind: string;
  hybrid_mode: string | null;
  percent_bp: number | null;
  fixed_amount_minor: string | number | null;
  minimum_minor: string | number | null;
};

export function managementFeeMinor(rule: FeeRule, rentReceivedMinor: number): number {
  const percent = Math.round((rentReceivedMinor * (rule.percent_bp ?? 0)) / 10000);
  const fixed = Number(rule.fixed_amount_minor ?? 0);
  const minimum = Number(rule.minimum_minor ?? 0);
  if (rule.kind === "fixed") return fixed;
  if (rule.kind === "percent") return percent;
  if (rule.kind === "hybrid" && rule.hybrid_mode === "percent_with_minimum") return Math.max(percent, minimum);
  if (rule.kind === "hybrid" && rule.hybrid_mode === "greater_of") return Math.max(percent, fixed);
  if (rule.kind === "hybrid" && rule.hybrid_mode === "fixed_plus_percent") return fixed + percent;
  return 0;
}

export type ChargeLine = { charge_type: string; amount_minor: number; description?: string; period_start?: string | null };

/** Existing allocation order. Late fees and similar charges sit between rent and utility. */
const PAYMENT_ORDER = ["rent", "add_on", "late_fee", "one_off", "maintenance", "utility", "deposit", "adjustment", "credit"];

const BILL_DISPLAY_ORDER = ["rent", "deposit", "utility"];

/** A reversed 電費 line stays on the invoice. Its credit reduces what the tenant still owes. */
function netElectricityCredits(lines: ChargeLine[]): ChargeLine[] {
  let offset = lines
    .filter((line) => line.charge_type === "credit" && (line.description ?? "").startsWith("沖銷電費"))
    .reduce((sum, line) => sum - line.amount_minor, 0);
  if (offset === 0) {
    return lines.filter((line) => !(line.charge_type === "credit" && (line.description ?? "").startsWith("沖銷電費")));
  }
  const netted: ChargeLine[] = [];
  for (const line of lines) {
    if (line.charge_type === "credit" && (line.description ?? "").startsWith("沖銷電費")) continue;
    if (line.charge_type === "utility" && offset > 0 && line.amount_minor > 0) {
      const take = Math.min(offset, line.amount_minor);
      offset -= take;
      netted.push({ ...line, amount_minor: line.amount_minor - take });
    } else {
      netted.push(line);
    }
  }
  return netted;
}

/** Staff payment default: outstanding rent plus billed utilities. Deposit stays off this default. */
export function rentUtilityDueMinor(lines: ChargeLine[], paidMinor: number) {
  const netted = netElectricityCredits(lines);
  const rent = netted.filter((line) => line.charge_type === "rent").reduce((sum, line) => sum + line.amount_minor, 0);
  const utility = netted.filter((line) => line.charge_type === "utility").reduce((sum, line) => sum + line.amount_minor, 0);
  const applied = attributePayment(netted, paidMinor);
  return Math.max(0, rent - applied.rent) + Math.max(0, utility - applied.utility);
}

export type TenantBillLine = { chargeType: string; description: string; amountMinor: number; periodStart?: string | null };

function toBillLine(line: ChargeLine, amountMinor: number): TenantBillLine {
  return {
    chargeType: line.charge_type,
    description: line.description ?? "",
    amountMinor,
    periodStart: line.period_start ?? null,
  };
}

function paymentRank(chargeType: string) {
  return PAYMENT_ORDER.indexOf(chargeType);
}

/**
 * One row per remaining charge. Deposit outstanding is max(0, deposit − allocated deposit).
 * Any other charge type is included so the rows sum to the open invoice balance.
 */
export function tenantBillLines(lines: ChargeLine[], paidMinor: number): TenantBillLine[] {
  const netted = netElectricityCredits(lines);
  const applied = attributePayment(netted, paidMinor);
  const remaining = { rent: applied.rent, utility: applied.utility, deposit: applied.deposit, other: applied.other };
  const sorted = [...netted].sort((a, b) => paymentRank(a.charge_type) - paymentRank(b.charge_type));
  const outstanding: TenantBillLine[] = [];
  for (const line of sorted) {
    if (line.amount_minor < 0) {
      outstanding.push(toBillLine(line, line.amount_minor));
      continue;
    }
    if (line.amount_minor === 0) continue;
    const bucket = line.charge_type === "rent" || line.charge_type === "utility" || line.charge_type === "deposit" ? line.charge_type : "other";
    const take = Math.min(remaining[bucket], line.amount_minor);
    remaining[bucket] -= take;
    const left = line.amount_minor - take;
    if (left > 0) {
      outstanding.push(toBillLine(line, left));
    }
  }
  outstanding.sort((a, b) => {
    const ar = BILL_DISPLAY_ORDER.indexOf(a.chargeType);
    const br = BILL_DISPLAY_ORDER.indexOf(b.chargeType);
    const aRank = ar === -1 ? BILL_DISPLAY_ORDER.length : ar;
    const bRank = br === -1 ? BILL_DISPLAY_ORDER.length : br;
    if (aRank !== bRank) return aRank - bRank;
    const aPay = paymentRank(a.chargeType);
    const bPay = paymentRank(b.chargeType);
    return (aPay === -1 ? PAYMENT_ORDER.length : aPay) - (bPay === -1 ? PAYMENT_ORDER.length : bPay);
  });
  return outstanding;
}

/** Amount due on the tenant bill, including deposit and every other open charge. */
export function tenantBillDueMinor(lines: ChargeLine[], paidMinor: number) {
  return tenantBillLines(lines, paidMinor).reduce((sum, line) => sum + line.amountMinor, 0);
}

export function attributePayment(lines: ChargeLine[], paidMinor: number) {
  const order = PAYMENT_ORDER;
  const buckets = { rent: 0, utility: 0, deposit: 0, other: 0 };
  let left = paidMinor;
  const sorted = netElectricityCredits(lines).sort(
    (a, b) => order.indexOf(a.charge_type) - order.indexOf(b.charge_type),
  );
  for (const line of sorted) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, line.amount_minor));
    left -= take;
    if (line.charge_type === "rent") buckets.rent += take;
    else if (line.charge_type === "utility") buckets.utility += take;
    else if (line.charge_type === "deposit") buckets.deposit += take;
    else buckets.other += take;
  }
  return buckets;
}

export function dateDeltaDays(a: string, b: string): number {
  const ms = Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function scoreMatch(input: {
  payAmount: number;
  bankAmount: number;
  payLast5: string | null;
  bankLast5: string | null;
  payDate: string;
  bankDate: string;
}) {
  let score = 0;
  const reasons: Record<string, string | number | boolean> = {};
  if (input.payAmount === input.bankAmount) {
    score += 0.5;
    reasons.amount_exact = true;
  }
  if (input.payLast5 && input.bankLast5 && input.payLast5 === input.bankLast5) {
    score += 0.4;
    reasons.last5 = input.bankLast5;
  }
  const delta = Math.abs(dateDeltaDays(input.payDate, input.bankDate));
  reasons.date_delta_days = delta;
  if (delta <= 5) score += 0.1;
  return { score: Math.round(score * 10000) / 10000, reasons };
}
