import { unreportedRest } from "./b087-report-guard";
import { tenantHomeHeadline, type TenantHomeBill, type TenantHomeFacts, type TenantHomeHeadline } from "./b090-tenant-home-rules";
import type { BillState } from "./tenant-payment-history-rules";

/**
 * Brand 3.0 B-090 slice 2, RT-PAY / RT-REPORT (TEN-52, TEN-53). Pure rules over what the v3-only 繳款 reader
 * (b090-tenant-pay-reader.ts) and the existing tenant payment-history reader return. Nothing is stored.
 */

/** Facts the v3 繳款 reader adds beyond the bill and the 首頁 facts. */
export type TenantPayFacts = {
  /** The caller's own most recent stored 帳號末五碼 on this lease (5 digits), if any (TEN-53-AC1). Never a co-tenant's. */
  lastLast5: string | null;
  /** The property's local date (YYYY-MM-DD): the 匯款日期 default (TEN-53-AC1). */
  today: string;
  /** TEN-52-AC3: the newest PAY_HISTORY_MONTHS months of the caller's own reports, aggregated in SQL over every report. */
  months: PayMonthFacts[];
  /** Older months exist beyond the ones listed. */
  olderMonths: boolean;
};

/** 「之前的繳款」 shows this many most recent months; each line lists at most PAY_MONTH_REPORTS of its reports. */
export const PAY_HISTORY_MONTHS = 12;
export const PAY_MONTH_REPORTS = 20;

export type PayReport = { id: string; status: "submitted" | "confirmed" | "rejected" | "reversed"; amountMinor: number; currency: string; paidOn: string; rejectionReason: string | null };

/** One month (of 匯款日期) over all of the caller's own reports, computed in SQL by the reader. */
export type PayMonthFacts = {
  month: string; count: number; countedMinor: number; anySubmitted: boolean; anyConfirmed: boolean;
  newestStatus: PayReport["status"]; newestAmountMinor: number; currency: string; newestRejectedReason: string | null; reports: PayReport[];
};
export type PayMonthRow = { ym: string; n: number; currencies: number; counted: string; any_submitted: boolean; any_confirmed: boolean; newest_status: string; newest_amount: string; currency: string; newest_reason: string | null };
export type PayMonthReportRow = { id: string; status: string; amount: string; currency: string; paid_on: string; rejected_reason: string | null; ym: string };

const STATUSES = ["submitted", "confirmed", "rejected", "reversed"] as const;
const isStatus = (v: string): v is PayReport["status"] => (STATUSES as readonly string[]).includes(v);
const minor = (v: string) => {
  if (!/^-?\d+$/.test(v)) throw new Error("Invalid amount");
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("Amount out of range");
  return n;
};

/** Shapes the reader's SQL rows; null (the reader answers "unavailable") on anything inconsistent, e.g. mixed currencies in a month. */
export function payMonthFacts(months: PayMonthRow[], rows: PayMonthReportRow[]): PayMonthFacts[] | null {
  const out: PayMonthFacts[] = [];
  try {
    for (const m of months) {
      if (!/^\d{4}-\d{2}$/.test(m.ym) || m.currencies !== 1 || !isStatus(m.newest_status) || !(m.n >= 1)) return null;
      const reports: PayReport[] = [];
      for (const r of rows.filter(x => x.ym === m.ym)) {
        if (!isStatus(r.status) || r.currency !== m.currency || !/^\d{4}-\d{2}-\d{2}$/.test(r.paid_on)) return null;
        reports.push({ id: r.id, status: r.status, amountMinor: minor(r.amount), currency: r.currency, paidOn: r.paid_on, rejectionReason: r.status === "rejected" ? r.rejected_reason : null });
      }
      out.push({
        month: m.ym, count: m.n, countedMinor: minor(m.counted), anySubmitted: m.any_submitted === true, anyConfirmed: m.any_confirmed === true,
        newestStatus: m.newest_status, newestAmountMinor: minor(m.newest_amount), currency: m.currency, newestRejectedReason: m.newest_reason, reports,
      });
    }
  } catch {
    return null;
  }
  return out;
}

export type PayBadge =
  | { kind: "due" } | { kind: "overdue" } | { kind: "sent" } | { kind: "paid" }
  | { kind: "partial"; restMinor: number }
  | { kind: "none"; state: BillState };

export type TenantPayState = {
  headline: TenantHomeHeadline;
  badge: PayBadge;
  /** The 金額 row: what is owed now (open balance). Absent when nothing is owed. */
  owedMinor: number | null;
  pendingMinor: number;
  /** Owed and not yet covered by waiting reports: the report form's prefill and maximum (TEN-53-AC4, B-087). */
  restMinor: number;
  /** 「回報已繳」 shows only when the lease can be reported on and something is still unreported (TEN-52-AC1, TEN-53-AC4). */
  canReport: boolean;
  waiting: { pendingMinor: number; restMinor: number } | null;
};

/**
 * TEN-52-AC1 / TEN-53-AC3…AC4. The headline is RT-HOME's rule over the same facts (the lease-wide waiting total, the
 * B-087 guard's predicate, PR-042 (1) = a), so 還差 and the form's maximum match what the server will accept.
 */
export function tenantPayState(bill: TenantHomeBill, facts: TenantHomeFacts, leaseCanReport: boolean): TenantPayState {
  if (!Number.isSafeInteger(facts.pendingMinor) || facts.pendingMinor < 0) throw new Error("Invalid pay facts");
  const pendingMinor = facts.pendingMinor;
  const headline = tenantHomeHeadline(bill, facts);
  const owed = bill.balanceMinor > 0 ? bill.balanceMinor : 0;
  const restMinor = unreportedRest(owed, pendingMinor);
  let badge: PayBadge;
  switch (headline.kind) {
    case "due": badge = { kind: "due" }; break;
    case "overdue": badge = { kind: "overdue" }; break;
    case "reported": badge = { kind: "sent" }; break;
    case "partial": badge = pendingMinor > 0 ? { kind: "sent" } : { kind: "partial", restMinor: headline.restMinor }; break;
    case "paid": badge = { kind: "paid" }; break;
    case "none": badge = { kind: "none", state: headline.state };
  }
  return {
    headline, badge, owedMinor: owed > 0 ? owed : null, pendingMinor, restMinor,
    canReport: leaseCanReport && restMinor > 0,
    waiting: pendingMinor > 0 && owed > 0 ? { pendingMinor, restMinor } : null,
  };
}

export type PayHistoryLine = { month: string; status: PayReport["status"]; amountMinor: number; currency: string; reason: string | null; count: number; reports: PayReport[] };

/**
 * TEN-52-AC3 「之前的繳款」: one line per month, newest first. A report is not tied to a billing month, so the month is
 * the month of its 匯款日期 (paid_on). Status: any waiting → 等待確認; else any confirmed → 已確認; else the newest
 * report's own status (未通過 with its reason, 確認已撤銷). The amount counts confirmed and waiting reports; a month with
 * only refused ones shows the newest refused amount. Totals come from the SQL aggregate over every report.
 */
export function payHistoryLines(months: PayMonthFacts[]): PayHistoryLine[] {
  return months.map(m => {
    const status: PayReport["status"] = m.anySubmitted ? "submitted" : m.anyConfirmed ? "confirmed" : m.newestStatus;
    return {
      month: m.month, status, amountMinor: m.anySubmitted || m.anyConfirmed ? m.countedMinor : m.newestAmountMinor, currency: m.currency,
      reason: status === "rejected" ? m.newestRejectedReason : null, count: m.count, reports: m.reports,
    };
  });
}
