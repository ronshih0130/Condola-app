import { moneyMonthBills, moneyMonthReports, type MoneyMonthBills, type MoneyMonthReports } from "./b3-money-month";
import { FlowError, logServerError } from "./errors";
import { can } from "./perms";
import type { Session } from "./types";

export type MoneyBills = MoneyMonthBills | { state: "forbidden" };
export type MoneyReports = MoneyMonthReports | { state: "forbidden" };
export type MoneyTab = "all" | "yours" | "overdue" | "future" | "paid";
export type MoneyParams = { month?: string; tab?: string; error?: string; cursor?: string };
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
export async function readMoneyPage(session: Session, params: MoneyParams, deps = {
  bills: moneyMonthBills, reports: moneyMonthReports, now: () => new Date(),
}) {
  const tab = moneyTab(params.tab);
  let month = validMoneyMonth(params.month) ? params.month : deps.now().toISOString().slice(0, 7);
  const reportCursor = tab === "yours" ? params.cursor : undefined;
  const readBills = () => safeRead(async (): Promise<MoneyBills> => can(session, "stmt.view")
    ? deps.bills(session, { month, status: tab === "all" ? undefined : tab === "yours" ? "reported" : tab,
      cursor: tab === "yours" ? undefined : params.cursor }) : { state: "forbidden" });
  const readReports = () => safeRead(async (): Promise<MoneyReports> => can(session, "pay.record")
    ? deps.reports(session, { month, cursor: reportCursor }) : { state: "forbidden" });
  let bills = await readBills();
  let reports = await readReports();
  const calendar = bills.state === "ready" ? bills : reports.state === "ready" ? reports : undefined;
  if (!validMoneyMonth(params.month) && calendar && calendar.today.slice(0, 7) !== month) {
    month = calendar.today.slice(0, 7);
    bills = await readBills();
    reports = await readReports();
  }
  if (bills.state === "ready" && reports.state === "ready") {
    const visibleBills = new Map(bills.rows.map(row => [row.leaseId, row]));
    const attachedIds = new Set(reports.attached.flatMap(report => report.billRows
      .filter(target => target.month === month).map(target => target.leaseId)));
    const conflictingReport = [...attachedIds].some(id => {
      const bill = visibleBills.get(id);
      return bill && bill.status !== "reported" && bill.status !== "paid";
    });
    const completeReports = reportCursor === undefined && reports.nextCursor === null;
    if (conflictingReport || (completeReports && bills.rows.some(row => row.status === "reported" && !attachedIds.has(row.leaseId)))) {
      reports = { state: "unavailable" };
    }
  }
  return { month, tab, bills, reports, cursor: params.cursor };
}
