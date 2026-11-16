import { tenantPaymentHistoryCopy } from "../tenant-payment-history";
import type { Locale } from "../index";

// screens.md: money month page A/B (PR-011), B3A-PAY / B3A-PAY-ROW;
// brand-3.0.html: manager money frame.
// MGT-141 / R6-PARTIAL supersedes B.2's no-new-wording rule for partial payments.
// partial / partialAmounts below: approved by Ron 2026-11-15 11:42 PT (PENDING-RON PR-018).
const zh = {
  headline: "{month} 月 {total} 筆應繳，{paid} 筆已確認繳款。", month: "{month} 月",
  all: "全部", yours: "輪到你", overdue: "逾期未繳", future: "未到期", paid: "已繳",
  reported: "已回報・待確認", due_today: "待繳", other: "其他回報",
  partial: "部分已繳", partialAmounts: "已繳 {paid}・還差 {balance}",
  property: "物件・租客", due: "應繳", status: "狀態", source: "來源", turn: "輪到誰",
  pending: "{count} 筆等你核對", confirm: "確認已繳款", confirmed: "已確認繳款",
  // P52 approved by Ron 2026-11-15 20:44 PT (PENDING-RON PR-023); #181 already-confirmed copy removed by revert.
  tenantReport: "租客回報", bank: "銀行明細", waiting: "等租客繳款", dueDate: "{date} 到期",
};
// English translation; partial / partialAmounts were approved with them (PR-018, 2026-11-15 11:42 PT).
const en: typeof zh = {
  headline: "{month}: {total} bills due, {paid} confirmed paid.", month: "{month}",
  all: "All", yours: "Your turn", overdue: "Overdue", future: "Not due", paid: "Paid",
  reported: "Reported · awaiting confirmation", due_today: "Due", other: "Other reports",
  partial: "Partially paid", partialAmounts: "Paid {paid} · Remaining {balance}",
  property: "Property · tenant", due: "Due", status: "Status", source: "Source", turn: "Whose turn",
  pending: "{count} awaiting your confirmation", confirm: "Confirm payment", confirmed: "Payment confirmed",
  // P52 approved by Ron 2026-11-15 20:44 PT (PENDING-RON PR-023); #181 already-confirmed copy removed by revert.
  tenantReport: "Tenant report", bank: "Bank statement", waiting: "Waiting for tenant payment", dueDate: "Due {date}",
};
export const moneyPageCopy = (locale: Locale) => ({
  ...(locale === "en" ? en : zh),
  next: tenantPaymentHistoryCopy(locale).next, first: tenantPaymentHistoryCopy(locale).first,
});
