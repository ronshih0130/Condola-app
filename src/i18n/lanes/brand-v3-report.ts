import type { Locale } from "../index";

// R1-RPT / MGT-128 approved 2026-11-14 19:02 PT. Empty copy retains shipped
// i_report_empty (P52: the row does not approve a replacement sentence).
const copy = {
  "zh-TW": {
    title: "收支報表", lead: "{period} 收入 {income}，支出 {expense}，淨額 {net}。",
    hint: "只算已確認的。押金和預付另外列，不算收入。", separate: "另外列", deposit: "押金",
    tax: "這是已記錄收支的整理，不是稅務證明，也不幫你算稅",
    period: "期間", source: "查來源", empty: "這個範圍沒有物件。",
    failed: "資料載入失敗", retry: "再試一次", date: "日期", item: "項目", amount: "金額",
    property: "物件", owner: "屋主", currency: "幣別", income: "收入", expense: "支出", net: "淨額",
    total: "合計", export: "匯出 CSV", next: "下一頁", back: "返回第一頁", sourceId: "來源",
  },
  en: {
    title: "Income and expenses", lead: "{period} Income {income}, expenses {expense}, net {net}.",
    hint: "Confirmed records only. Deposits and prepayments are listed separately, outside income.",
    separate: "Listed separately", deposit: "Deposits",
    tax: "This summarizes recorded income and expenses. It is not tax documentation and does not calculate your taxes.",
    period: "Period", source: "View source", empty: "No properties in this view.",
    failed: "Could not load data", retry: "Try again", date: "Date", item: "Item", amount: "Amount",
    property: "Property", owner: "Owner", currency: "Currency", income: "Income", expense: "Expenses", net: "Net",
    total: "Total", export: "Export CSV", next: "Next page", back: "Back to first page", sourceId: "Source",
  },
};
export const incomeReportCopy = (locale: Locale) => copy[locale];
