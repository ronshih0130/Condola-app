import type { Locale } from "@/i18n";

const copy = {
  en: { unavailable:"The first invoice estimate is unavailable.", estimate:"First invoice estimate", issued:"Recorded first invoice", asOf:"Estimate based on the current snapshot. Amounts can change before issuance.", rent:"Rent", deposit:"Deposit", utility:"Selected utility", total:"Total", period:"Rent service period", unknown:"Unknown", formula:"Monthly rent ÷ 30 × days", full:"Full rent", days:"days", zero:"Zero amount; no ledger posting." },
  "zh-TW": { unavailable:"無法取得首張帳單估算。", estimate:"首張帳單估算", issued:"已開立首張帳單紀錄", asOf:"此估算依目前資料快照計算，開立前金額可能變動。", rent:"租金", deposit:"押金", utility:"所選水電費", total:"合計", period:"租金服務期間", unknown:"未知", formula:"月租 ÷ 30 × 天數", full:"全額租金", days:"天", zero:"金額為零，沒有帳簿紀錄。" },
} as const;
export function moveInPreviewCopy(locale: Locale) { return copy[locale]; }
