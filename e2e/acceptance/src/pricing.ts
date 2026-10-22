import { monthlyAmount, seatLimit as seatCap, yearlyAmount } from "../../../src/server/billing";
import { trialOffer, type TrialLength } from "../../../src/server/trial-length";

const LIST = { std: 30, pro: 40 } as const;

/** Public list price. A partner flag is accepted and does not change the amount. */
export function monthlyPrice(plan: "free" | "std" | "pro", units: number, context?: { partner?: boolean }): number {
  if (plan === "free") return 0;
  const listed = LIST[plan];
  const rate = context?.partner ? listed : listed;
  return monthlyAmount({ units, rate });
}

export function annualQuote(plan: "free" | "std" | "pro", units: number): { amount: number; discountApplied: boolean } {
  const monthly = monthlyPrice(plan, units);
  if (plan === "free" || monthly === 0) return { amount: 0, discountApplied: false };
  return { amount: yearlyAmount(monthly), discountApplied: true };
}

/** The length is the caller's parameter. Free stays zero either way. */
export function trialOfferMonths(plan: "free" | "std" | "pro", length: TrialLength): number {
  const offer = trialOffer(plan, length);
  return offer.count;
}

export function seatLimit(plan: "free" | "std" | "pro"): number {
  if (plan === "pro") return Infinity;
  const cap = seatCap(plan === "std" ? "standard" : plan);
  if (cap == null) return Infinity;
  return cap;
}

export function canInvite(plan: "free" | "std" | "pro", count: number): boolean {
  const limit = seatLimit(plan);
  return count < limit;
}

export function unitChange(input: { oldUnits: number; newUnits: number; currentAmount: number; nextPeriod: string }) {
  return {
    currentAmount: input.currentAmount,
    effectiveDate: input.nextPeriod,
    usableUnitsNow: Math.max(input.oldUnits, input.newUnits),
    refund: 0,
  };
}

export function trialReminders(input: {
  trialEnd: string;
  today: string;
  activatedAt: string;
  sent: number[];
  lineLaunched: boolean;
  lineConnected: boolean;
}): { days: number; channels: string[] }[] {
  const end = Date.parse(`${input.trialEnd}T00:00:00Z`);
  const today = Date.parse(`${input.today}T00:00:00Z`);
  const activated = Date.parse(`${input.activatedAt}T00:00:00Z`);
  const daysBeforeEnd = Math.round((end - activated) / 86_400_000);
  const todayOffset = Math.round((end - today) / 86_400_000);
  const due: number[] = [];
  if (daysBeforeEnd >= 14 && todayOffset <= 14 && !input.sent.includes(14)) due.push(14);
  if (todayOffset <= 7 && !input.sent.includes(7) && (daysBeforeEnd < 14 || input.sent.includes(14) || todayOffset < 14)) {
    if (!input.sent.includes(7) && todayOffset <= 7) due.push(7);
  }
  const channels = ["email", "in-app"];
  if (input.lineLaunched && input.lineConnected) channels.push("line");
  return due.map((days) => ({ days, channels }));
}

export function annualWindow(trialEnd: string): { start: string; end: string; trialCharge: number } {
  const end = new Date(`${trialEnd}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = end.toISOString().slice(0, 10);
  const finish = new Date(`${start}T00:00:00Z`);
  finish.setUTCFullYear(finish.getUTCFullYear() + 1);
  finish.setUTCDate(finish.getUTCDate() - 1);
  return { start, end: finish.toISOString().slice(0, 10), trialCharge: 0 };
}

export function switchSubscription(
  current: { trialUsed: boolean; trialEnd: string; plan: string; billing: string },
  next: { plan: string; billing: string },
) {
  return {
    trialUsed: current.trialUsed,
    trialEnd: current.trialEnd,
    plan: next.plan,
    billing: next.billing,
    annualStart: annualWindow(current.trialEnd).start,
    trialRestarted: false,
  };
}

export function effectiveLeaseCount(leases: { start: string; end: string | null }[], day: string): number {
  return leases.filter((lease) => lease.start <= day && (lease.end == null || lease.end >= day)).length;
}
