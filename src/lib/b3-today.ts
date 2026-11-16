import type { StaffRepairTurns } from "../server/b3-repair-turns";
import type { StaffPaymentTurns } from "../server/b3-payment-turns";
import type { StaffRentalTurns } from "../server/b3-rental-turns";
import type { StaffOverdueTurns } from "../server/b3-overdue-turns";

export type TodayTurns = { repairs?: StaffRepairTurns; payments: StaffPaymentTurns; rentals: StaffRentalTurns; overdue: StaffOverdueTurns; roomUnits: Record<string, string> };
export type TodayRow =
  | { type: "payment"; row: Extract<StaffPaymentTurns, { state: "ready" }>["mine"][number] }
  | { type: "rental"; row: Extract<StaffRentalTurns, { state: "ready" }>["mine"][number] }
  | { type: "overdue"; row: Extract<StaffOverdueTurns, { state: "ready" }>["others"][number] };
export type TodayMore = { href: string; count: number; kind: "payments" | "vacant" | "renewal" | "early" | "overdue" };
export function rowKey(item: TodayRow): string {
  return item.type === "payment" ? `payment:${item.row.id}` : item.type === "overdue" ? `overdue:${item.row.leaseId}:${item.row.currency}`
    : `rental:${item.row.kind}:${item.row.targetKind}:${item.row.targetId}`;
}
function rowDate(item: TodayRow): string | null {
  return item.type === "payment" ? item.row.since : item.type === "overdue" ? item.row.oldestDueDate : item.row.date;
}
/** R6 (accepted by Ron, PR-011): within a group, kind first, then the oldest/nearest date, then a stable key.
 * 輪到你: 確認已繳款 → 詢問續約意願 → 提早找租客 → 找新租客; 等別人: 重新回報 → 逾期. Each reader already returns its
 * first 50 in this order, so the first 50 of the merged group are exactly the group's first 50 (T-MORE). */
export function kindRank(item: TodayRow): number {
  if (item.type === "payment") return 0;
  if (item.type === "overdue") return 1;
  return { renewal_ask: 1, early_vacancy: 2, vacant: 3 }[item.row.kind] ?? 9;
}
export function oldestFirst(rows: TodayRow[]): TodayRow[] {
  return [...rows].sort((a, b) => {
    const rank = kindRank(a) - kindRank(b);
    if (rank) return rank;
    const left = rowDate(a), right = rowDate(b);
    const difference = (left ? Date.parse(left) : Infinity) - (right ? Date.parse(right) : Infinity);
    return (Number.isNaN(difference) ? 0 : difference) || rowKey(a).localeCompare(rowKey(b));
  }).slice(0, 50);
}
export function todayOverview({ payments, rentals, overdue, repairs }: TodayTurns) {
  if (repairs?.state === "unavailable" || [payments, rentals, overdue].some(source => source.state === "unavailable")) return { state: "unavailable" as const };
  if ([payments, rentals, overdue].every(source => source.state === "off")) return { state: "off" as const };
  const p = payments.state === "ready" ? payments : undefined;
  const r = rentals.state === "ready" ? rentals : undefined;
  const o = overdue.state === "ready" ? overdue : undefined;
  const counts = { payments: p?.yourTurn ?? 0, vacant: r?.counts.vacant ?? 0, renewal: r?.counts.renewalAsk ?? 0, early: r?.counts.earlyVacancy ?? 0 };
  const mineCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const paymentOthers = p?.counts.filter(c => c.holder === "tenant").reduce((sum, c) => sum + c.count, 0) ?? 0;
  const othersCount = paymentOthers + (o?.count ?? 0);
  const mine: TodayRow[] = [...(p?.mine ?? []).map(row => ({ type: "payment" as const, row })), ...(r?.mine ?? []).map(row => ({ type: "rental" as const, row }))];
  const others: TodayRow[] = [...(p?.others ?? []).map(row => ({ type: "payment" as const, row })), ...(o?.others ?? []).map(row => ({ type: "overdue" as const, row }))];
  const mineMore: TodayMore[] = [
    { kind: "payments", href: "/m/payments", count: counts.payments }, { kind: "renewal", href: "/m/leases", count: counts.renewal },
    { kind: "early", href: "/m/units", count: counts.early }, { kind: "vacant", href: "/m/units", count: counts.vacant },
  ];
  const othersMore: TodayMore[] = [{ kind: "payments", href: "/m/payments", count: paymentOthers }, { kind: "overdue", href: "/m/rent", count: o?.count ?? 0 }];
  return { state: "ready" as const, counts, mineCount, othersCount, mine: oldestFirst(mine), others: oldestFirst(others),
    mineMore: mineCount > 50 ? mineMore.filter(item => item.count > 0) : [],
    othersMore: othersCount > 50 ? othersMore.filter(item => item.count > 0) : [],
    checkedPayments: !!p || !!o, checkedRentals: !!r };
}
export function todayRowHref(item: TodayRow, roomUnits: Record<string, string>): string {
  if (item.type === "payment") return "/m/payments";
  if (item.type === "overdue") return "/m/rent";
  if (item.row.kind === "renewal_ask") return `/m/leases/${item.row.leaseId}`;
  const unitId = item.row.targetKind === "unit" ? item.row.targetId : roomUnits[item.row.targetId];
  if (!unitId) throw new Error("Missing rental turn unit");
  return `/m/units/${unitId}/invite`;
}

export type BillRow = { currency: string; due: string; received: string };
type BillTotal = { due: bigint; received: bigint; paid: number; total: number };
/** From f81427c payment-turns.tsx: same rent-roll population and integer minor-unit arithmetic. */
export function monthlyBillTotals(rows: BillRow[], defaultCurrency?: string): [string, BillTotal][] {
  const totals = new Map<string, BillTotal>();
  for (const row of rows) {
    const sum = totals.get(row.currency) ?? { due: BigInt(0), received: BigInt(0), paid: 0, total: 0 };
    const due = BigInt(row.due), received = BigInt(row.received);
    sum.due += due; sum.received += received;
    if (due > BigInt(0)) { sum.total++; if (received >= due) sum.paid++; }
    totals.set(row.currency, sum);
  }
  return Array.from(totals).filter(([, sum]) => sum.total > 0)
    .sort(([a], [b]) => a === b ? 0 : a === defaultCurrency ? -1 : b === defaultCurrency ? 1 : a.localeCompare(b));
}
export type TodayMonthly = { rows: BillRow[]; month: number; defaultCurrency: string };
export function hasMonthlyFigure(data: TodayMonthly | undefined): data is TodayMonthly {
  return data !== undefined && monthlyBillTotals(data.rows).length > 0;
}

/** Data API only. Repair row/overflow rendering remains gated by §10b. */
export function todayTurnCounts(sources: TodayTurns) {
  const original = todayOverview(sources), repair = sources.repairs;
  if (original.state === "unavailable" || repair?.state === "unavailable") return { state: "unavailable" as const };
  if (original.state === "off" && (!repair || repair.state === "off")) return { state: "off" as const };
  return { state: "ready" as const,
    mine: (original.state === "ready" ? original.mineCount : 0) + (repair?.state === "ready" ? repair.yourTurn : 0),
    others: (original.state === "ready" ? original.othersCount : 0) + (repair?.state === "ready"
      ? repair.counts.filter(c => !(c.holder === "manager" && c.canAct)).reduce((n, c) => n + c.count, 0) : 0) };
}
export function repairTodayKey(ticketId: string) { return `repair:${ticketId}`; }
