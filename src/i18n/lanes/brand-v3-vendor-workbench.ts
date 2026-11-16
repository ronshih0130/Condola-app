import type { Locale } from "../index";

// B-063 vendor workbench (hub 07-brand/brand-3.0-1113/screens.md rows V-HOME, V-EMPTY, V-JOBS, V-RECV, OV-SH-*;
// round 7 batch 1, Ron 2026-11-16 ~02:05 PT). zh-TW only uses approved words: the V-HOME row (Ron 2026-11-12
// 12:57 PT, as revised in Batch 2 22:25 PT), the OV-SH-PHONE tab name 工單, and the round 7 V-JOBS empty sentence.
// The strings with the restricted collection word live in brand-v3-own-status.ts (copy guard). EN is a translation.
// V-HOME lead: its general rule (which day, no visits, zero) has no drafted text, so the lead is the title 工作台
// as the row states (screens.md V-HOME: "until approved, the lead is 「工作台」").
const copy = {
  "zh-TW": {
    jobsTab: "工單",
    openJobs: "未結案件",
    visit: "待到場",
    working: "處理中",
    view: "查看",
    note: "這是已記錄的應付狀態，不是代付款。",
    emptyTitle: "目前沒有未結案件",
    jobsEmpty: "管理方派工給你後，案件會出現在這裡。",
  },
  en: {
    jobsTab: "Jobs",
    openJobs: "Open jobs",
    visit: "Visit pending",
    working: "In progress",
    view: "View",
    note: "This is a recorded amount owed to you. Condola does not pay it for anyone.",
    emptyTitle: "No open jobs",
    jobsEmpty: "Jobs appear here once the manager assigns them to you.",
  },
} as const;
export type VendorWorkbenchCopy = (typeof copy)["zh-TW"] | (typeof copy)["en"];
export function vendorWorkbenchCopy(locale: Locale): VendorWorkbenchCopy { return copy[locale]; }
