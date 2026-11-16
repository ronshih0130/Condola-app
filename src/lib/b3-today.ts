import type { StaffPaymentTurns } from "../server/b3-payment-turns";
import type { StaffRentalTurns } from "../server/b3-rental-turns";
import type { StaffOverdueTurns } from "../server/b3-overdue-turns";
import type { TodayRepairRow, TodayRepairs } from "../server/b3-today-repairs";
import type { TodayBank, TodayMonthClose, TodayReply } from "../server/b3-today-kinds";

type Failed = { state: "off" | "unavailable" };
/** Each optional source is a separate reader; absent means not admitted (same as off). */
export type TodayTurns = {
  repairs?: TodayRepairs; payments: StaffPaymentTurns; rentals: StaffRentalTurns; overdue: StaffOverdueTurns; roomUnits: Record<string, string>;
  bank?: TodayBank | Failed; monthClose?: TodayMonthClose | Failed; reply?: TodayReply | Failed;
};
export type TodayRow =
  | { type: "payment"; row: Extract<StaffPaymentTurns, { state: "ready" }>["mine"][number] }
  | { type: "rental"; row: Extract<StaffRentalTurns, { state: "ready" }>["mine"][number] }
  | { type: "overdue"; row: Extract<StaffOverdueTurns, { state: "ready" }>["others"][number] }
  | { type: "repair"; row: TodayRepairRow }
  | { type: "bank"; row: { count: number; oldestMonth: string | null; since: string | null } }
  | { type: "monthClose"; row: NonNullable<Extract<TodayMonthClose, { state: "ready" }>["row"]> }
  | { type: "reply"; row: { threads: number; oldest: string | null } };
export type TodayMoreKind = "payments" | "vacant" | "renewal" | "early" | "overdue" | "repairs";
export type TodayMore = { href: string; count: number; kind: TodayMoreKind };
export function repairTodayKey(ticketId: string) { return `repair:${ticketId}`; }
export function rowKey(item: TodayRow): string {
  switch (item.type) {
    case "payment": return `payment:${item.row.id}`;
    case "overdue": return `overdue:${item.row.leaseId}:${item.row.currency}`;
    case "repair": return repairTodayKey(item.row.ticketId);
    case "bank": return "bank";
    case "monthClose": return `month-close:${item.row.period}`;
    case "reply": return "reply";
    default: return `rental:${item.row.kind}:${item.row.targetKind}:${item.row.targetId}`;
  }
}
function rowDate(item: TodayRow): string | null {
  switch (item.type) {
    case "payment": return item.row.since;
    case "overdue": return item.row.oldestDueDate;
    case "repair": return item.row.since;
    case "bank": return item.row.since;
    case "monthClose": return item.row.since;
    case "reply": return item.row.oldest;
    default: return item.row.date;
  }
}
/** MGT-148-AC3 / MGT-149-AC4 (approved 2026-11-15, 「照你的排序提案」), extending R6 (PR-011):
 * 輪到你: 確認已繳款 → 報修 (核對費用 → 派工 → 重新估價 → 處理中) → 回覆 → 處理請求 → 結算押金 → 安排點交 → 開始對帳
 *   → 開始月結 → 查看原因 → 詢問續約意願 → 提早找租客 → 找新租客;
 * 等別人: 重新回報 → 逾期 → 付押金 → 簽名 → 報修 (date only). Gaps are the kinds with no source yet (GS-44). */
const MINE_RANK = { payment: 0, confirm_cost: 1, dispatch: 2, re_estimate: 3, in_progress: 4, reply: 5, bank: 9, monthClose: 10,
  renewal_ask: 12, early_vacancy: 13, vacant: 14 } as const;
export function kindRank(item: TodayRow): number {
  if (item.type === "payment") return 0;
  if (item.type === "overdue") return 1;
  if (item.type === "repair") {
    // 等別人 repairs follow payment and rental rows, by date only (MGT-149-AC4).
    if (!(item.row.holder === "manager" && item.row.viewerCanAct)) return 20;
    return (MINE_RANK as Record<string, number>)[item.row.step] ?? MINE_RANK.in_progress;
  }
  if (item.type === "reply" || item.type === "bank" || item.type === "monthClose") return MINE_RANK[item.type];
  return (MINE_RANK as Record<string, number>)[item.row.kind] ?? 30;
}
function exactFirst(a: TodayRow, b: TodayRow): number {
  // Within one repair step, exact waits come before approximate ones (Design Session 2026-11-16).
  return a.type === "repair" && b.type === "repair" && kindRank(a) < 20 ? Number(b.row.sinceExact) - Number(a.row.sinceExact) : 0;
}
export function oldestFirst(rows: TodayRow[]): TodayRow[] {
  return [...rows].sort((a, b) => {
    const rank = kindRank(a) - kindRank(b);
    if (rank) return rank;
    const exact = exactFirst(a, b);
    if (exact) return exact;
    const left = rowDate(a), right = rowDate(b);
    const difference = (left ? Date.parse(left) : Infinity) - (right ? Date.parse(right) : Infinity);
    return (Number.isNaN(difference) ? 0 : difference) || rowKey(a).localeCompare(rowKey(b));
  }).slice(0, 50);
}
export type RepairMineStep = "confirm_cost" | "dispatch" | "re_estimate" | "in_progress";
export type WaitingParty = "tenant" | "owner" | "vendor" | "manager";
export function todayOverview({ payments, rentals, overdue, repairs, bank, monthClose, reply }: TodayTurns) {
  const sources = [payments, rentals, overdue, repairs, bank, monthClose, reply].filter((s): s is NonNullable<typeof s> => !!s);
  if (sources.some(source => source.state === "unavailable")) return { state: "unavailable" as const };
  if (sources.every(source => source.state === "off")) return { state: "off" as const };
  const p = payments.state === "ready" ? payments : undefined;
  const r = rentals.state === "ready" ? rentals : undefined;
  const o = overdue.state === "ready" ? overdue : undefined;
  const fix = repairs?.state === "ready" ? repairs : undefined;
  const b = bank?.state === "ready" ? bank : undefined;
  const c = monthClose?.state === "ready" ? monthClose : undefined;
  const m = reply?.state === "ready" ? reply : undefined;
  const repairMine = (step: RepairMineStep) => fix?.counts.filter(x => x.holder === "manager" && x.canAct && x.step === step).reduce((n, x) => n + x.count, 0) ?? 0;
  const counts = {
    payments: p?.yourTurn ?? 0, confirmCost: repairMine("confirm_cost"), dispatch: repairMine("dispatch"), reEstimate: repairMine("re_estimate"),
    inProgress: repairMine("in_progress"), reply: m && m.threads > 0 ? 1 : 0, bank: b && b.count > 0 ? 1 : 0, monthClose: c?.row ? 1 : 0,
    renewal: r?.counts.renewalAsk ?? 0, early: r?.counts.earlyVacancy ?? 0, vacant: r?.counts.vacant ?? 0,
  };
  // Every 管 matter this viewer can act on counts once; uncapped (MGT-125-AC1, MGT-148-AC4). The repair total is the
  // gateway's own uncapped yourTurn, so a step outside the four approved words is still counted, never dropped.
  const mineCount = counts.payments + (fix?.yourTurn ?? 0) + counts.reply + counts.bank + counts.monthClose + counts.renewal + counts.early + counts.vacant;
  const paymentOthers = p?.counts.filter(x => x.holder === "tenant").reduce((sum, x) => sum + x.count, 0) ?? 0;
  const repairOthers = (holder: WaitingParty) => fix?.counts.filter(x => x.holder === holder && !(holder === "manager" && x.canAct)).reduce((n, x) => n + x.count, 0) ?? 0;
  const waiting: Record<WaitingParty, number> = { tenant: paymentOthers + (o?.count ?? 0), owner: repairOthers("owner"), vendor: repairOthers("vendor"), manager: repairOthers("manager") };
  const othersCount = Object.values(waiting).reduce((sum, n) => sum + n, 0);
  const mine: TodayRow[] = [
    ...(p?.mine ?? []).map(row => ({ type: "payment" as const, row })), ...(r?.mine ?? []).map(row => ({ type: "rental" as const, row })),
    ...(fix?.mine ?? []).map(row => ({ type: "repair" as const, row })),
    ...(m && m.threads > 0 ? [{ type: "reply" as const, row: { threads: m.threads, oldest: m.oldest } }] : []),
    ...(b && b.count > 0 ? [{ type: "bank" as const, row: { count: b.count, oldestMonth: b.oldestMonth, since: b.since } }] : []),
    ...(c?.row ? [{ type: "monthClose" as const, row: c.row }] : []),
  ];
  const others: TodayRow[] = [...(p?.others ?? []).map(row => ({ type: "payment" as const, row })), ...(o?.others ?? []).map(row => ({ type: "overdue" as const, row })),
    ...(fix?.others ?? []).map(row => ({ type: "repair" as const, row }))];
  const shownMine = oldestFirst(mine), shownOthers = oldestFirst(others);
  // T-MORE: the existing kinds and 維修 (GS-41) keep their list link. 待你回覆／對帳／月結 have no drawn 看全部 label, so
  // they get none (GS-44); past the first 50 such a row still counts in N and is named in the supporting line.
  const mineMore: TodayMore[] = [
    { kind: "payments", href: "/m/payments", count: counts.payments },
    { kind: "repairs", href: "/m/tickets", count: fix?.yourTurn ?? 0 },
    { kind: "renewal", href: "/m/leases", count: counts.renewal },
    { kind: "early", href: "/m/units", count: counts.early }, { kind: "vacant", href: "/m/units", count: counts.vacant },
  ];
  const repairOthersCount = waiting.owner + waiting.vendor + waiting.manager;
  const othersMore: TodayMore[] = [{ kind: "payments", href: "/m/payments", count: paymentOthers }, { kind: "overdue", href: "/m/rent", count: o?.count ?? 0 },
    { kind: "repairs", href: "/m/tickets", count: repairOthersCount }];
  // T-LINE numbers: the frame's 「回覆 n 則」 and 「對帳 n 筆」 count messages and bank lines; the headline counts matters.
  const summary = { ...counts, reply: counts.reply ? m!.threads : 0, bank: counts.bank ? b!.count : 0 };
  return { state: "ready" as const, counts, summary, mineCount, othersCount, waiting, mine: shownMine, others: shownOthers,
    mineMore: mineCount > 50 ? mineMore.filter(item => item.count > 0) : [],
    othersMore: othersCount > 50 ? othersMore.filter(item => item.count > 0) : [],
    checkedPayments: !!p || !!o || !!b || !!c, checkedRentals: !!r, checkedRepairs: !!fix };
}
/** R1-BANK opens on the current month; send the row to the oldest month that still has lines to review. */
export function bankHref(oldestMonth: string | null): string {
  return oldestMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(oldestMonth) ? `/m/bank?month=${oldestMonth}` : "/m/bank";
}
export function todayRowHref(item: TodayRow, roomUnits: Record<string, string>): string {
  switch (item.type) {
    case "payment": return "/m/payments";
    case "overdue": return "/m/rent";
    case "repair": return `/m/tickets/${encodeURIComponent(item.row.ticketId)}`;
    case "bank": return bankHref(item.row.oldestMonth);
    case "monthClose": return "/m/close";
    case "reply": return "/m/messages";
  }
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

/** Headline numbers from the same overview the page renders (repairs included once). */
export function todayTurnCounts(sources: TodayTurns) {
  const overview = todayOverview(sources);
  if (overview.state !== "ready") return { state: overview.state };
  return { state: "ready" as const, mine: overview.mineCount, others: overview.othersCount };
}
