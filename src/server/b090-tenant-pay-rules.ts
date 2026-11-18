import { unreportedRest } from "./b087-report-guard";
import { tenantHomeHeadline, type TenantHomeBill, type TenantHomeFacts, type TenantHomeHeadline } from "./b090-tenant-home-rules";
import type { BillState } from "./tenant-payment-history-rules";

/**
 * Brand 3.0 B-090 slice 2, RT-PAY / RT-REPORT (TEN-52, TEN-53). Pure rules over what the existing tenant
 * payment-history reader returns; nothing is stored and no database object is added.
 */

/** Extra facts the reader returns for the 繳款 page only (`pay: true`). */
export type TenantPayFacts = {
  /** Lease-wide sum of tenant reports still waiting (source tenant_portal, status submitted): the B-087 guard's own predicate. */
  leasePendingMinor: number;
  /** The caller's own most recent stored 帳號末五碼 on this lease (5 digits), if any (TEN-53-AC1). */
  lastLast5: string | null;
  /** The property's local date (YYYY-MM-DD): the 匯款日期 default (TEN-53-AC1). */
  today: string;
};

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
  /** Owed and not yet covered by waiting reports: the report form's prefill and maximum (TEN-53-AC4). */
  restMinor: number;
  /** 「回報已繳」 shows only when the lease can be reported on and something is still unreported (TEN-52-AC1, TEN-53-AC4). */
  canReport: boolean;
  waiting: { pendingMinor: number; restMinor: number } | null;
};

/**
 * TEN-52-AC1 / TEN-53-AC3…AC4. The headline is RT-HOME's rule with the lease-wide waiting total (so 還差 and the
 * form's maximum match what the server's B-087 guard will accept). The badge follows the headline.
 */
export function tenantPayState(bill: TenantHomeBill, home: TenantHomeFacts, pay: Pick<TenantPayFacts, "leasePendingMinor">, leaseCanReport: boolean): TenantPayState {
  if (!Number.isSafeInteger(pay.leasePendingMinor) || pay.leasePendingMinor < 0) throw new Error("Invalid pay facts");
  const pendingMinor = pay.leasePendingMinor;
  const headline = tenantHomeHeadline(bill, { ...home, pendingMinor });
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

export type PayReport = { id: string; status: "submitted" | "confirmed" | "rejected" | "reversed"; amountMinor: number; currency: string; paidOn: string; rejectionReason: string | null };
export type PayHistoryLine = { month: string; status: PayReport["status"]; amountMinor: number; currency: string; reason: string | null; reports: PayReport[] };

/**
 * TEN-52-AC3 「之前的繳款」: one line per month, newest first. A report is not tied to a billing month, so the month is
 * the month of its 匯款日期 (paid_on). Status: any waiting → 等待確認; else any confirmed → 已確認; else the newest
 * report's own status (未通過 with its reason, 確認已撤銷). The amount counts confirmed and waiting reports; a month with
 * only refused ones shows the newest refused amount. Tapping the line lists that month's reports.
 */
export function payHistoryLines(reports: PayReport[]): PayHistoryLine[] {
  const months = new Map<string, PayReport[]>();
  for (const r of reports) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.paidOn)) continue;
    const key = r.paidOn.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), r]);
  }
  return [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, list]) => {
    const rows = [...list].sort((a, b) => b.paidOn.localeCompare(a.paidOn));
    const counted = rows.filter(r => r.status === "submitted" || r.status === "confirmed");
    const status: PayReport["status"] = rows.some(r => r.status === "submitted") ? "submitted"
      : rows.some(r => r.status === "confirmed") ? "confirmed" : rows[0].status;
    let amountMinor = 0;
    for (const r of counted.length ? counted : [rows[0]]) {
      if (!Number.isSafeInteger(amountMinor + r.amountMinor)) throw new Error("Amount out of range");
      amountMinor += r.amountMinor;
    }
    const newestRejected = status === "rejected" ? rows.find(r => r.status === "rejected") : undefined;
    return { month, status, amountMinor, currency: rows[0].currency, reason: newestRejected?.rejectionReason ?? null, reports: rows };
  });
}
