const copy = {
  en: { choice: "Calculate partial first-month rent by day", summary: "First-month rent", period: "Billing period", formula: "Monthly rent ÷ 30 × days", full: "Full monthly rent", days: "days", unavailable: "The first-month billing source is unavailable.", keep: "Keep current first-month setting", note: "Billing summary shown separately from the lease PDF." },
  "zh-TW": { choice: "首月未滿月時按日計算租金", summary: "首月租金", period: "計費期間", formula: "月租 ÷ 30 × 天數", full: "全月租金", days: "天", unavailable: "無法取得首月計費資料。", keep: "保留目前的首月設定", note: "此計費摘要與租約 PDF 分開顯示。" },
} as const;

export function firstPeriodCopy(locale: string) {
  return locale === "zh-TW" ? copy["zh-TW"] : copy.en;
}
