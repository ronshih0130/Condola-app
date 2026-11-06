import { createHash } from "node:crypto";
import { stableStringify } from "@/idempotency";

const zero = BigInt(0);
export type OwnerNetInput = {
  opening: bigint; companyRent: bigint; directRent: bigint; otherIncome: bigint;
  managementFee: bigint; expenses: bigint; payouts: bigint; prepayDraws: bigint;
};
export function computeOwnerNet(input: OwnerNetInput) {
  const { opening, companyRent, directRent, otherIncome, managementFee, expenses, payouts, prepayDraws } = input;
  const net = companyRent + otherIncome - managementFee - expenses - payouts;
  const closing = opening + net;
  const lines = [
    { key: "opening", amountMinor: opening, affectsBalance: true },
    { key: "company_rent", amountMinor: companyRent, affectsBalance: true },
    { key: "direct_rent", amountMinor: directRent, affectsBalance: false },
    { key: "other_income", amountMinor: otherIncome, affectsBalance: true },
    { key: "management_fee", amountMinor: managementFee, affectsBalance: true },
    { key: "expenses", amountMinor: expenses, affectsBalance: true },
    { key: "prepay_draws", amountMinor: prepayDraws, affectsBalance: false },
    { key: "payouts", amountMinor: payouts, affectsBalance: true },
    { key: "closing", amountMinor: closing, affectsBalance: true },
  ] as const;
  return { closing, net, closingNegative: closing < zero, netNegative: net < zero, lines };
}

export const snapshotAmountKeys = ["opening_minor", "company_rent_minor", "direct_rent_minor", "other_income_minor",
  "management_fee_minor", "expenses_minor", "payouts_minor", "prepay_draws_minor", "closing_minor"] as const;
export type OwnerNetSnapshot = Record<typeof snapshotAmountKeys[number], string> & {
  currency: string; period_start: string; period_end: string; statement_id: string;
  schema: "b014-v1"; reserved_prepay: true; deposits_excluded: true; fingerprint: string;
};

export function reconcileSnapshot(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const s = snapshot as Record<string, unknown>;
  if (!snapshotAmountKeys.every(key => typeof s[key] === "string" && /^-?[0-9]{1,19}$/.test(s[key] as string))) return false;
  const n = (key: typeof snapshotAmountKeys[number]) => BigInt(s[key] as string);
  const closing = n("closing_minor");
  return s.prepay_draws_minor === "0" && closing >= BigInt("-9223372036854775808") && closing <= BigInt("9223372036854775807") &&
    closing === n("opening_minor") + n("company_rent_minor") + n("other_income_minor") -
      n("management_fee_minor") - n("expenses_minor") - n("payouts_minor");
}

export function buildSnapshot(input: OwnerNetInput, context: {
  currency: string; periodStart: string; periodEnd: string; statementId: string; calculationFingerprint: string;
}): OwnerNetSnapshot {
  const numeric = {
    opening_minor: input.opening.toString(), company_rent_minor: input.companyRent.toString(),
    direct_rent_minor: input.directRent.toString(), other_income_minor: input.otherIncome.toString(),
    management_fee_minor: input.managementFee.toString(), expenses_minor: input.expenses.toString(),
    payouts_minor: input.payouts.toString(), prepay_draws_minor: input.prepayDraws.toString(),
    closing_minor: computeOwnerNet(input).closing.toString(),
  };
  if (!reconcileSnapshot(numeric)) throw new Error("Report identity mismatch");
  return { ...numeric, currency: context.currency, period_start: context.periodStart, period_end: context.periodEnd,
    statement_id: context.statementId, schema: "b014-v1", reserved_prepay: true, deposits_excluded: true,
    fingerprint: createHash("sha256").update(stableStringify({ ...numeric, calculationFingerprint: context.calculationFingerprint })).digest("hex") };
}

// ---- BigInt ports of the statement attribution rules (src/server/money.ts) ----
// Same semantics as attributePayment / managementFeeMinor, but every amount is an
// integer minor-unit bigint so values beyond 2^53 stay exact.
export type BigChargeLine = { charge_type: string; amount_minor: bigint; description: string | null };
const PAYMENT_ORDER_BIG = ["rent", "add_on", "late_fee", "one_off", "maintenance", "utility", "deposit", "adjustment", "credit"];
const isElectricityCredit = (l: BigChargeLine) => l.charge_type === "credit" && (l.description ?? "").startsWith("沖銷電費");

function netElectricityCreditsBig(lines: BigChargeLine[]): BigChargeLine[] {
  let offset = lines.filter(isElectricityCredit).reduce((sum, l) => sum - l.amount_minor, zero);
  const netted: BigChargeLine[] = [];
  for (const line of lines) {
    if (isElectricityCredit(line)) continue;
    if (offset !== zero && line.charge_type === "utility" && offset > zero && line.amount_minor > zero) {
      const take = offset < line.amount_minor ? offset : line.amount_minor;
      offset -= take;
      netted.push({ ...line, amount_minor: line.amount_minor - take });
    } else netted.push(line);
  }
  return netted;
}

export function attributePaymentBig(lines: BigChargeLine[], paidMinor: bigint) {
  const buckets = { rent: zero, utility: zero, deposit: zero, other: zero };
  let left = paidMinor;
  const sorted = [...netElectricityCreditsBig(lines)].sort(
    (a, b) => PAYMENT_ORDER_BIG.indexOf(a.charge_type) - PAYMENT_ORDER_BIG.indexOf(b.charge_type),
  );
  for (const line of sorted) {
    if (left <= zero) break;
    const available = line.amount_minor > zero ? line.amount_minor : zero;
    const take = left < available ? left : available;
    left -= take;
    if (line.charge_type === "rent") buckets.rent += take;
    else if (line.charge_type === "utility") buckets.utility += take;
    else if (line.charge_type === "deposit") buckets.deposit += take;
    else buckets.other += take;
  }
  return buckets;
}

/** Math.round(n / d) for bigint (half rounds toward +infinity), d > 0. */
function roundDiv(n: bigint, d: bigint): bigint {
  const two = BigInt(2), num = n * two + d, den = d * two;
  const q = num / den;
  return num % den !== zero && num < zero ? q - BigInt(1) : q;
}

export type BigFeeRule = { kind: string; hybrid_mode: string | null; percent_bp: number | null; fixed_amount_minor: string | null; minimum_minor: string | null };
export function managementFeeBig(rule: BigFeeRule, rentMinor: bigint): bigint {
  const percent = roundDiv(rentMinor * BigInt(rule.percent_bp ?? 0), BigInt(10000));
  const fixed = BigInt(rule.fixed_amount_minor ?? "0"), minimum = BigInt(rule.minimum_minor ?? "0");
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  if (rule.kind === "fixed") return fixed;
  if (rule.kind === "percent") return percent;
  if (rule.kind === "hybrid" && rule.hybrid_mode === "percent_with_minimum") return max(percent, minimum);
  if (rule.kind === "hybrid" && rule.hybrid_mode === "greater_of") return max(percent, fixed);
  if (rule.kind === "hybrid" && rule.hybrid_mode === "fixed_plus_percent") return fixed + percent;
  return zero;
}
