import type { Locale } from "../index";

// screens.md: money month page A/B (PR-011), B3A-PAY / B3A-PAY-ROW;
// brand-3.0.html: manager money frame. No new Chinese product wording.
const zh = {
  headline: "{month} 月 {total} 筆應繳，{paid} 筆已確認繳款。", month: "{month} 月",
  all: "全部", yours: "輪到你", overdue: "逾期未繳", future: "未到期", paid: "已繳",
  reported: "已回報・待確認", due_today: "待繳", other: "其他回報",
  property: "物件・租客", due: "應繳", status: "狀態", source: "來源", turn: "輪到誰",
  pending: "{count} 筆等你核對", confirm: "確認已繳款", confirmed: "已確認繳款",
  tenantReport: "租客回報", bank: "銀行明細", waiting: "等租客繳款", dueDate: "{date} 到期",
};
// English translation of the same approved content; not a new workflow.
const en: typeof zh = {
  headline: "{month}: {total} bills due, {paid} confirmed paid.", month: "{month}",
  all: "All", yours: "Your turn", overdue: "Overdue", future: "Not due", paid: "Paid",
  reported: "Reported · awaiting confirmation", due_today: "Due", other: "Other reports",
  property: "Property · tenant", due: "Due", status: "Status", source: "Source", turn: "Whose turn",
  pending: "{count} awaiting your confirmation", confirm: "Confirm payment", confirmed: "Payment confirmed",
  tenantReport: "Tenant report", bank: "Bank statement", waiting: "Waiting for tenant payment", dueDate: "Due {date}",
};
export const moneyPageCopy = (locale: Locale) => locale === "en" ? en : zh;
