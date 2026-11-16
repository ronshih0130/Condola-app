import type { Locale } from "../index";

const copy = {
  "zh-TW": {
    brand: "租多啦・廠商", context: "{name} 你好｜管理方：{company}", contextNoName: "管理方：{company}",
    title: "這一案", status: "狀態", address: "地址", appointment: "約定到場",
    off: "工作台還沒開放。請先處理這一案，或等管理方通知你。",
    hint: "先處理這一案，想看全部可以登入。", report: "回報進度",
    workbench: "工作台", notifications: "通知", navigation: "廠商導覽",
    sheetTitle: "登入後才能看全部未結案件",
    sheetBody: "單案連結只能處理這一張工單，不會因此看到歷史清單。", back: "回到這一案",
  },
  en: {
    brand: "Condola · Vendor", context: "Hello {name} | Managed by: {company}", contextNoName: "Managed by: {company}",
    title: "This job", status: "Status", address: "Address", appointment: "Agreed arrival",
    off: "The workbench is not available yet. Handle this job first, or wait for your manager's update.",
    hint: "Handle this job first. Sign in to see all jobs.", report: "Report progress",
    workbench: "Workbench", notifications: "Notifications", navigation: "Vendor navigation",
    sheetTitle: "Sign in to see all open jobs",
    sheetBody: "This link only lets you handle this job. It does not give access to job history.", back: "Back to this job",
  },
} as const;
export function vendorTokenCopy(locale: Locale) { return copy[locale]; }
