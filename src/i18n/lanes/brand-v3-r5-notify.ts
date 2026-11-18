import type { Locale } from "../index";

// R5-NOTIFY (設定 › 通知設定; MGT-135, B-073). zh-TW is verbatim from the approved frame 「設定・通知設定」 in
// brand-3.0.html (round 5); the new words (lead, each switch's sub-line, the footer) are P52 approved as written
// (Ron, PENDING-RON PR-018, round 5 strings). The read error, retry and save failure reuse the GS-02 pattern
// (MGT-135-AC5). The 我的帳號 link line (MGT-135-AC2) is the first clause of the approved R5-ACCT frame sentence
// 「提醒信的開關在「通知設定」；全公司的兩步驟驗證規則在「團隊」。」 — the 團隊 clause is left out because that rule has
// not moved yet (R5-TEAM). On 規則與資料 the R5-OWNVIEW side-card row 「提醒租客・在「通知設定」」 is the link line.
// EN is a translation (draft).
const copy = {
  "zh-TW": {
    lead: "通知設定：決定你自己收哪些提醒，也決定租客收哪些。",
    mine: "寄給我的",
    mineLease: "租約快到期",
    mineLeaseSub: "租約到期前提醒我。",
    mineOverdue: "逾期未繳",
    mineOverdueSub: "有租金逾期時提醒我。",
    tenant: "寄給租客的",
    tenantNote: "只有管理員看得到這一塊。",
    tenantLease: "租約到期",
    tenantLeaseSub: "租約快到期時提醒租客。",
    tenantOverdue: "租金逾期",
    tenantOverdueSub: "租金逾期時提醒租客。",
    footer: "這一頁只存設定，改了不會因此多寄任何東西。",
    readFailed: "這裡暫時讀不到，請再試一次。",
    retry: "再試一次",
    saveFailed: "沒有存成功，請再試一次。",
    movedBefore: "提醒信的開關在「",
    movedLink: "通知設定",
    movedAfter: "」。",
  },
  en: {
    lead: "Notifications: choose which reminders you get, and which ones tenants get.",
    mine: "Sent to me",
    mineLease: "Lease ending soon",
    mineLeaseSub: "Remind me before a lease ends.",
    mineOverdue: "Overdue rent",
    mineOverdueSub: "Remind me when rent is overdue.",
    tenant: "Sent to tenants",
    tenantNote: "Only admins can see this section.",
    tenantLease: "Lease ending",
    tenantLeaseSub: "Remind tenants when their lease is ending soon.",
    tenantOverdue: "Rent overdue",
    tenantOverdueSub: "Remind tenants when their rent is overdue.",
    footer: "This page only saves settings; changing them doesn't send anything extra.",
    readFailed: "This is temporarily unavailable. Please try again.",
    retry: "Try again",
    saveFailed: "That didn't save. Please try again.",
    movedBefore: "Reminder email switches are in ",
    movedLink: "Notifications",
    movedAfter: ".",
  },
};
export function brandV3NotifyCopy(locale: Locale) { return copy[locale]; }
