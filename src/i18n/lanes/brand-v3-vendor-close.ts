import type { Locale } from "../index";

// B-097 RV-DONE and B-098 RV-TIME 「打電話給租客」 (vendor round, Ron 2026-11-15 「全部核准」). zh-TW strings are verbatim
// from the approved frames 「回報完工・附照片就結案」 and 「約時間・從租客的時段挑」; the 回報完工 button on RV-JOB is the
// stage primary's approved label (VEN-26-AC1).
const copy = {
  "zh-TW": {
    report: "回報完工",
    doneTitle: "回報完工",
    afterPhotos: "處理後照片",
    atLeastOne: "至少一張",
    note: "說明（選填）",
    closeLine: "送出就結案，租客會看到「已完成」。{company} 7 天內可以重開。",
    submit: "送出完工",
    cancel: "取消",
    timeTitle: "約時間",
    callTenant: "打電話給租客",
  },
  en: {
    report: "Report completion",
    doneTitle: "Report completion",
    afterPhotos: "After photos",
    atLeastOne: "At least one",
    note: "Notes (optional)",
    closeLine: "Sending closes the job and the tenant sees \"Completed\". {company} can reopen it within 7 days.",
    submit: "Send completion",
    cancel: "Cancel",
    timeTitle: "Set a time",
    callTenant: "Call the tenant",
  },
} as const;
export type VendorCloseCopy = (typeof copy)["zh-TW"] | (typeof copy)["en"];
export function vendorCloseCopy(locale: Locale): VendorCloseCopy { return copy[locale]; }
