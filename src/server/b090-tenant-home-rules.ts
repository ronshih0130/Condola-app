import type { BillState } from "./tenant-payment-history-rules";

/**
 * Brand 3.0 B-090 slice 1, RT-HOME (TEN-54-AC1): which one sentence the tenant 首頁 shows.
 * Pure: reads only the tenant's own bill summary (tenantPaymentHistory, view 'current', home: true).
 * Nothing is stored and no database object is added.
 */

/** Invoice facts the reader already loads, reduced to what the headline needs. */
export type HomeInvoice = { status: string; balance: number; dueOn: string; periodStart: string | null };
export type TenantHomeFacts = {
  /** Sum of the tenant's own reports still waiting for the company (status submitted). */
  pendingMinor: number;
  /** Earliest invoice with an open balance: its billing month and due date. */
  nextDue: { month: string; dueOn: string } | null;
  /** Earliest open invoice already past its due date (property's own date): its billing month and days past. */
  overdue: { month: string; days: number } | null;
  /** Billing month of the latest fully paid invoice (staff-confirmed), if any. */
  paidMonth: string | null;
};

const month = (i: HomeInvoice) => (i.periodStart ?? i.dueOn).slice(0, 7);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

/** `today` is the property's local date (YYYY-MM-DD), as used for the bill's own overdue flag. */
export function tenantHomeFacts(invoices: HomeInvoice[], today: string, pendingMinor: number): TenantHomeFacts {
  if (!DATE.test(today) || !Number.isSafeInteger(pendingMinor) || pendingMinor < 0) throw new Error("Invalid home facts");
  const open = invoices.filter(i => (i.status === "open" || i.status === "partially_paid") && i.balance > 0)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const late = open.find(i => i.dueOn < today);
  const paid = invoices.filter(i => i.status === "paid").sort((a, b) => b.dueOn.localeCompare(a.dueOn))[0];
  return {
    pendingMinor,
    nextDue: open[0] ? { month: month(open[0]), dueOn: open[0].dueOn } : null,
    overdue: late ? { month: month(late), days: dayNumber(today) - dayNumber(late.dueOn) } : null,
    paidMonth: paid ? month(paid) : null,
  };
}

export type TenantHomeBill = { state: BillState; overdue: boolean; balanceMinor: number; paidMinor: number; currency: string };
export type TenantHomeHeadline =
  | { kind: "due"; month: string; amountMinor: number; dueOn: string }
  | { kind: "reported"; amountMinor: number }
  | { kind: "paid"; month: string }
  | { kind: "overdue"; month: string; days: number }
  | { kind: "partial"; month: string; restMinor: number }
  /** Nothing to pay and nothing confirmed to celebrate: the bill's own state label shows, never a tick. */
  | { kind: "none"; state: BillState };

/**
 * TEN-54-AC1, first match wins:
 *  1. nothing owed: 已繳清 with the tick only when the bill is settled by confirmed payments (PLT-51); otherwise none;
 *  2. the tenant's own waiting reports cover what is owed: 已回報 (clock);
 *  3. past due and nothing paid or reported yet: 逾期;
 *  4. something paid or reported, something still owed: 還差 (owed minus what is waiting);
 *  5. otherwise 待繳.
 */
export function tenantHomeHeadline(bill: TenantHomeBill, facts: TenantHomeFacts): TenantHomeHeadline {
  if (bill.balanceMinor <= 0 || !facts.nextDue) {
    return bill.state === "paid" && facts.paidMonth ? { kind: "paid", month: facts.paidMonth } : { kind: "none", state: bill.state };
  }
  if (facts.pendingMinor >= bill.balanceMinor) return { kind: "reported", amountMinor: facts.pendingMinor };
  if (bill.overdue && facts.overdue && facts.pendingMinor === 0 && bill.paidMinor === 0) {
    return { kind: "overdue", month: facts.overdue.month, days: facts.overdue.days };
  }
  if (facts.pendingMinor > 0 || bill.paidMinor > 0) {
    return { kind: "partial", month: facts.nextDue.month, restMinor: bill.balanceMinor - facts.pendingMinor };
  }
  return { kind: "due", month: facts.nextDue.month, amountMinor: bill.balanceMinor, dueOn: facts.nextDue.dueOn };
}

/** The clock line under the headline: shown whenever one of the tenant's own reports is waiting. */
export function tenantHomeWaiting(headline: TenantHomeHeadline, facts: TenantHomeFacts): boolean {
  return facts.pendingMinor > 0 && (headline.kind === "reported" || headline.kind === "partial");
}

/** Repairs the 首頁 shows a card for: open ones only, newest first, at most three (TEN-54-AC2). */
export type HomeRepairStep = "reported" | "dispatched" | "working";
export const HOME_REPAIR_LIMIT = 3;
export function homeRepairStep(status: string): HomeRepairStep | null {
  if (status === "open" || status === "triaged") return "reported";
  if (status === "assigned") return "dispatched";
  if (status === "in_progress" || status === "on_hold") return "working";
  return null; // resolved, closed, cancelled or unknown: no card
}
export function homeRepairs<T extends { status: string; created_at: string }>(rows: T[]): (T & { step: HomeRepairStep })[] {
  return rows.flatMap(r => { const step = homeRepairStep(r.status); return step ? [{ ...r, step }] : []; })
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, HOME_REPAIR_LIMIT);
}
