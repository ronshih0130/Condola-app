import type { Locale } from "../index";

// B-090 slice 3 (re-land, PENDING-RON PR-043): RT-REPAIR 報修 progress (TEN-56, read part) and RT-LEASE 更多 › 我的租約
// (TEN-57, read part), Brand 3.0 tenant round. Stories: hub 07-brand/brand-3.0-1113/stories.md TEN-56-AC4/AC5 and
// TEN-57-AC1. zh-TW is from the approved frames 「報修・進度（師傅想約時間）」 and 「更多・我的租約（快到期）」; their new
// words are P52 APPROVED (PENDING-RON PR-023). The five status sentences (repair.lead.*) are approved in PR-042
// (Ron 2026-11-18 10:40 PST). Card title, 看進度 and the step names 已回報／已派工／處理中 are the slice-1 RT-HOME words;
// 已完成 is TEN-56-AC4's step; 已取消 is the app's existing repair status word (i_repair_cancelled_status). The read
// error and retry are the shared approved O-STATES pair (GS-02 = A). No staff money words on the tenant side (TEN-52-AC4).
// Not built here (no data yet): the time question and visit choice (B-088), 「取消授權進入」, the renewal question
// (B-089), the deposit card (TEN-49). EN is a draft translation.
const copy = {
  "zh-TW": {
    repair: {
      title: "報修",
      cardTitle: "報修・{title}",
      steps: { reported: "已回報", dispatched: "已派工", working: "處理中", done: "已完成" },
      cancelled: "已取消",
      stepAt: "{step}・{date}",
      lead: {
        reported: "已回報，等{company}派師傅。",
        dispatched: "{company}已經派師傅。",
        working: "師傅處理中。",
        done: "這件報修已經完成。",
        cancelled: "這件報修已取消。",
      },
      viewProgress: "看進度",
      sent: "你送出的內容",
      message: "有問題傳訊息",
      newRepair: "新增報修",
    },
    lease: {
      title: "我的租約",
      place: "物件",
      period: "租期",
      rent: "租金",
      dueDay: "繳租日",
      deposit: "押金",
      periodValue: "{start}～{end}",
      rentValue: "{amount}／月",
      dueDayValue: "每月 {day} 日",
    },
    readFailed: "這裡暫時讀不到，請再試一次。",
    retry: "再試一次",
  },
  en: {
    repair: {
      title: "Repairs",
      cardTitle: "Repair · {title}",
      steps: { reported: "Reported", dispatched: "Dispatched", working: "In progress", done: "Done" },
      cancelled: "Cancelled",
      stepAt: "{step} · {date}",
      lead: {
        reported: "Reported. Waiting for {company} to send a technician.",
        dispatched: "{company} has sent a technician.",
        working: "The technician is working on it.",
        done: "This repair is done.",
        cancelled: "This repair was cancelled.",
      },
      viewProgress: "View progress",
      sent: "What you sent",
      message: "Message us about a problem",
      newRepair: "New repair",
    },
    lease: {
      title: "My lease",
      place: "Unit",
      period: "Term",
      rent: "Rent",
      dueDay: "Rent due",
      deposit: "Deposit",
      periodValue: "{start} – {end}",
      rentValue: "{amount} / month",
      dueDayValue: "Day {day} of each month",
    },
    readFailed: "This is temporarily unavailable. Please try again.",
    retry: "Try again",
  },
};
export type TenantLeaseRepairCopy = typeof copy["zh-TW"];
export function brandV3TenantLeaseRepairCopy(locale: Locale): TenantLeaseRepairCopy { return copy[locale]; }
