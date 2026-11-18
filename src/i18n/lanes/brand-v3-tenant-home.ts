import type { Locale } from "../index";

// B-090 slice 1: RT-HOME 首頁 (TEN-54-AC1…AC4) and the tenant tab bar (TEN-55-AC1), Brand 3.0 tenant round.
// zh-TW is verbatim from the approved stories (stories.md TEN-54, TEN-55; Ron 2026-11-15 ~12:05 PT) and the approved
// frames 「首頁・已回報，還有兩件事」 and 「首頁・這個月都好了」 (Ron ~12:21 PT, 「全部核准」). New strings are P52 APPROVED
// as drafted (Ron 2026-11-15 20:44 PT, PENDING-RON PR-023). The context line follows the frames' top bar
// 「{稱呼} 你好｜{物件}」; its no-name / no-place forms drop the missing part (same rule as SH-NONAME / OV-SH-NONAME).
// The read error and retry are the shared approved O-STATES pair (TEN-54-AC4 names the same words).
// Repair step names are RT-REPAIR's 已回報 → 已派工 → 處理中 (約好時間 needs B-088 and is not used).
// EN is a draft translation.
const zhMonth = (ym: string) => String(Number(ym.slice(5, 7)));
const enMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const enMonth = (ym: string) => enMonths[Number(ym.slice(5, 7)) - 1] ?? ym;
const copy = {
  "zh-TW": {
    tabs: { home: "首頁", pay: "繳款", repair: "報修", messages: "訊息", more: "更多" },
    context: "{name} 你好｜{place}",
    contextNoName: "{place}",
    contextNoPlace: "{name} 你好",
    due: "{name}你好，{month} 月租金 {amount}，{date} 前繳。",
    dueNoName: "{month} 月租金 {amount}，{date} 前繳。",
    reported: "已回報 {amount}，等{company}確認。",
    waiting: "等{company}確認，確認後這裡會打勾。",
    paid: "{month} 月已繳清。",
    overdue: "{month} 月租金還沒繳，已經過了 {days} 天。",
    partial: "{month} 月還差 {amount}。",
    repairTitle: "報修・{title}",
    steps: { reported: "已回報", dispatched: "已派工", working: "處理中" },
    viewProgress: "看進度",
    readFailed: "這裡暫時讀不到，請再試一次。",
    retry: "再試一次",
    month: zhMonth,
    date: (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`,
    days: (n: number) => String(n),
  },
  en: {
    tabs: { home: "Home", pay: "Pay", repair: "Repairs", messages: "Messages", more: "More" },
    context: "Hello {name} · {place}",
    contextNoName: "{place}",
    contextNoPlace: "Hello {name}",
    due: "Hello {name}, {month} rent of {amount} is due by {date}.",
    dueNoName: "{month} rent of {amount} is due by {date}.",
    reported: "Reported {amount}, waiting for {company} to confirm.",
    waiting: "Waiting for {company} to confirm. A tick appears here once confirmed.",
    paid: "{month} is paid in full.",
    overdue: "{month} rent is unpaid and {days} past due.",
    partial: "{month}: {amount} still to pay.",
    repairTitle: "Repair · {title}",
    steps: { reported: "Reported", dispatched: "Dispatched", working: "In progress" },
    viewProgress: "View progress",
    readFailed: "This is temporarily unavailable. Please try again.",
    retry: "Try again",
    month: enMonth,
    date: (ymd: string) => `${enMonths[Number(ymd.slice(5, 7)) - 1]?.slice(0, 3) ?? ymd.slice(5, 7)} ${Number(ymd.slice(8, 10))}`,
    days: (n: number) => `${n} ${n === 1 ? "day" : "days"}`,
  },
};
export type TenantHomeCopy = typeof copy["zh-TW"];
export function brandV3TenantHomeCopy(locale: Locale): TenantHomeCopy { return copy[locale]; }
