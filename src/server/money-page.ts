import { moneyMonthBills, moneyMonthReports, type MoneyMonthBill, type MoneyMonthBills, type MoneyMonthReports } from "./b3-money-month";
import { FlowError, logServerError } from "./errors";
import { can } from "./perms";
import type { Session } from "./types";

export type MoneyBills = MoneyMonthBills | { state: "forbidden" };
export type MoneyReports = MoneyMonthReports | { state: "forbidden" };
export type MoneyTab = "all" | "yours" | "overdue" | "future" | "paid";
export type MoneyParams = { month?: string; tab?: string; error?: string; cursor?: string };
// MGT-141: keep the five tabs and the reader's underlying due-state buckets.
// Partial on the due day appears in all (there is no due_today tab), never paid.
// A pending report retains precedence and belongs to yours, even on a partial bill.
// PLT-54: the partial bucket uses the row's own property date, the same one the reader classified with.
export function moneyBillMatchesTab(row: MoneyMonthBill, tab: MoneyTab): boolean {
  const bucket = row.status === "partial" ? row.dueDate > row.propertyToday ? "future" : "due_today" : row.status;
  return tab === "all" || bucket === (tab === "yours" ? "reported" : tab);
}
export function moneyTab(value?: string): MoneyTab {
  return value === "yours" || value === "overdue" || value === "future" || value === "paid" ? value : "all";
}
export function validMoneyMonth(value?: string): value is string {
  return typeof value === "string" && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
export function moneyHref(month: string, tab: MoneyTab, cursor?: string) {
  return `/m/payments?month=${encodeURIComponent(month)}&tab=${tab}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
}
export function adjacentMoneyMonth(month: string, offset: number) {
  const [year, number] = month.split("-").map(Number);
  const index = year * 12 + number - 1 + offset;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String(index % 12 + 1).padStart(2, "0")}`;
}
async function safeRead<T>(read: () => Promise<T>): Promise<T | { state: "forbidden" | "unavailable" }> {
  try { return await read(); } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") return { state: "forbidden" };
    logServerError("b3_money_page", error);
    return { state: "unavailable" };
  }
}
// Each list is one reader snapshot. Only org-calendar correction may repeat a read.
// The default month is month selection, not due/overdue, so it stays on the organization calendar (PLT-54-AC3).
export async function readMoneyPage(session: Session, params: MoneyParams, deps = {
  bills: moneyMonthBills, reports: moneyMonthReports, now: () => new Date(),
}) {
  // 輪到你 exists only for viewers whose reports read is allowed: it filters bills to `reported`, which
  // would otherwise tell a stmt.view-only viewer which bills have a pending report (Codex r2 I1).
  const requested = moneyTab(params.tab);
  let tab = requested;
  if (tab === "yours" && !can(session, "pay.record")) tab = "all";
  let month = validMoneyMonth(params.month) ? params.month : deps.now().toISOString().slice(0, 7);
  const reportCursor = () => tab === "yours" ? params.cursor : undefined;
  const readBills = () => safeRead(async (): Promise<MoneyBills> => can(session, "stmt.view")
    ? deps.bills(session, { month, status: tab === "all" ? undefined : tab === "yours" ? "reported" : tab,
      cursor: tab === "yours" || tab !== requested ? undefined : params.cursor }) : { state: "forbidden" });
  const readReports = () => safeRead(async (): Promise<MoneyReports> => can(session, "pay.record")
    ? deps.reports(session, { month, cursor: reportCursor() }) : { state: "forbidden" });
  // Reports first: an effective denial (e.g. a custom role without pay.record) also drops 輪到你 before bills are filtered.
  let reports = await readReports();
  if (tab === "yours" && reports.state === "forbidden") tab = "all";
  let bills = await readBills();
  const calendar = bills.state === "ready" ? bills : reports.state === "ready" ? reports : undefined;
  if (!validMoneyMonth(params.month) && calendar && calendar.today.slice(0, 7) !== month) {
    month = calendar.today.slice(0, 7);
    reports = await readReports();
    if (tab === "yours" && reports.state === "forbidden") tab = "all";
    bills = await readBills();
  }
  if (bills.state === "ready" && reports.state === "ready") {
    const visibleBills = new Map(bills.rows.map(row => [row.leaseId, row]));
    const attachedIds = new Set(reports.attached.flatMap(report => report.billRows
      .filter(target => target.month === month).map(target => target.leaseId)));
    const conflictingReport = [...attachedIds].some(id => {
      const bill = visibleBills.get(id);
      return bill && bill.status !== "reported" && bill.status !== "paid";
    });
    const completeReports = reportCursor() === undefined && reports.nextCursor === null;
    if (conflictingReport || (completeReports && bills.rows.some(row => row.status === "reported" && !attachedIds.has(row.leaseId)))) {
      reports = { state: "unavailable" };
    }
  }
  return { month, tab, bills, reports, cursor: tab === requested ? params.cursor : undefined };
}
