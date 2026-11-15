import { moneyMonthBills, moneyMonthReports, type MoneyMonthBills, type MoneyMonthReports } from "./b3-money-month";
import { FlowError, logServerError } from "./errors";
import { can } from "./perms";
import type { Session } from "./types";

export type MoneyBills = MoneyMonthBills | { state: "forbidden" };
export type MoneyReports = MoneyMonthReports | { state: "forbidden" };
export type MoneyTab = "all" | "yours" | "overdue" | "future" | "paid";
export type MoneyParams = { month?: string; tab?: string; error?: string };
export function moneyTab(value?: string): MoneyTab {
  return value === "yours" || value === "overdue" || value === "future" || value === "paid" ? value : "all";
}
export function validMoneyMonth(value?: string): value is string {
  return typeof value === "string" && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
export function moneyHref(month: string, tab: MoneyTab) {
  return `/m/payments?month=${encodeURIComponent(month)}&tab=${tab}`;
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
// Consume cursors independently: report pages need not line up with bill pages. Never lose a
// second report on a row, or mislabel an attached report as "other" because its bill is on page 2.
// Each reader retains its own authorization/snapshot. A changed summary or duplicate fails closed.
export async function readMoneyPage(session: Session, params: MoneyParams, deps = {
  bills: moneyMonthBills, reports: moneyMonthReports, now: () => new Date(),
}) {
  let month = validMoneyMonth(params.month) ? params.month : deps.now().toISOString().slice(0, 7);
  const readBills = () => safeRead(async (): Promise<MoneyBills> => {
    if (!can(session, "stmt.view")) return { state: "forbidden" };
    let first = await deps.bills(session, { month });
    if (first.state !== "ready") return first;
    // The reader supplies the org calendar. UTC is only a bootstrap input, never the displayed
    // default when the authorized org-calendar read succeeds (including around month rollover).
    if (!validMoneyMonth(params.month) && first.today.slice(0, 7) !== month) {
      month = first.today.slice(0, 7);
      first = await deps.bills(session, { month });
      if (first.state !== "ready") return first;
    }
    const rows = [...first.rows], seen = new Set<string>();
    let cursor = first.nextCursor;
    while (cursor) {
      if (seen.has(cursor)) return { state: "unavailable" };
      seen.add(cursor);
      const page = await deps.bills(session, { month, cursor });
      if (page.state !== "ready") return page;
      if (JSON.stringify([page.counts, page.totals, page.outstanding, page.today]) !== JSON.stringify([first.counts, first.totals, first.outstanding, first.today])) return { state: "unavailable" };
      rows.push(...page.rows); cursor = page.nextCursor;
    }
    if (rows.length !== first.counts.all || new Set(rows.map(row => row.leaseId)).size !== rows.length) return { state: "unavailable" };
    return { ...first, rows, nextCursor: null };
  });
  const bills = await readBills();
  let reports = await safeRead(async (): Promise<MoneyReports> => {
    if (!can(session, "pay.record")) return { state: "forbidden" };
    const first = await deps.reports(session, { month });
    if (first.state !== "ready") return first;
    const attached = [...first.attached], other = [...first.other], seen = new Set<string>();
    let cursor = first.nextCursor;
    while (cursor) {
      if (seen.has(cursor)) return { state: "unavailable" };
      seen.add(cursor);
      const page = await deps.reports(session, { month, cursor });
      if (page.state !== "ready") return page;
      if (page.yourTurn !== first.yourTurn || page.attachedCount !== first.attachedCount || page.otherCount !== first.otherCount) return { state: "unavailable" };
      attached.push(...page.attached); other.push(...page.other); cursor = page.nextCursor;
    }
    if (attached.length !== first.attachedCount || other.length !== first.otherCount || new Set([...attached, ...other].map(row => row.id)).size !== first.yourTurn) return { state: "unavailable" };
    return { ...first, attached, other, nextCursor: null };
  });
  if (bills.state === "ready" && reports.state === "ready") {
    const billIds = new Set(bills.rows.map(row => row.leaseId));
    const attachedIds = new Set(reports.attached.flatMap(report => report.billRows.filter(target => target.month === month).map(target => target.leaseId)));
    // Separate snapshots may race with confirmation. Do not silently discard a report or show
    // a zero turn count beside a reported bill; keep bills and mark the report section unavailable.
    if ([...attachedIds].some(id => !billIds.has(id)) || bills.rows.some(row => row.status === "reported" && !attachedIds.has(row.leaseId))) {
      reports = { state: "unavailable" };
    }
  }
  return { month, tab: moneyTab(params.tab), bills, reports };
}
