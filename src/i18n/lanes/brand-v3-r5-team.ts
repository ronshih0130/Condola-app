import type { Locale } from "../index";

// R5-TEAM + R5-FULL (設定 › 團隊; MGT-133 AC1, AC3–AC8, B-073). zh-TW is verbatim from the approved frames
// 「設定・團隊」 and 「設定・團隊・人數滿了」 in brand-3.0.html (round 5); the four role descriptions and 「取消」 are
// verbatim from the approved frame 「設定・團隊・新增同事」 (R5-ADD). The new words (the security card title and its
// sub-line, the full-panel body, the role descriptions) are P52, approved as written (Ron, PENDING-RON PR-018,
// round 5 strings). The read error, retry and save failure reuse the GS-02 pattern (MGT-133-AC8). 「團隊」 is the
// frame's 「設定 › 團隊」 crumb. Role names, permission rows, 已停用 and the existing invite/row actions keep their
// existing catalog strings. EN is a translation (draft).
const copy = {
  "zh-TW": {
    title: "團隊",
    leadLimit: "團隊人數 {used}／{limit}",
    leadNoLimit: "團隊人數 {used}",
    leadNote: "每位同事都算一人，不分角色。",
    add: "新增同事",
    colName: "同事",
    colRole: "角色",
    colStatus: "狀態",
    statusActive: "使用中",
    statusInvited: "邀請中",
    statusPaused: "暫停",
    pausedSub: "試用結束，升級後恢復",
    more: "更多",
    resend: "重寄邀請",
    perms: "看完整權限表",
    securityTitle: "全公司的安全規則",
    require2fa: "要求全體成員啟用兩步驟驗證",
    require2faSub: "開啟後，還沒設定的同事下次登入時要先完成。",
    fullTitle: "團隊人數已滿",
    fullBody: "團隊人數已滿（{used}／{limit}）。升級到進階方案就不限人數，或先停用一位同事。",
    plans: "看方案",
    close: "關閉",
    cancel: "取消",
    roleAdmin: "全部都能做，包括團隊、方案和公司設定。",
    roleManager: "看今天和報表，處理物件、租客、租約、確認繳款、記支出、報修和訊息，可以匯出報表；不能撤回繳款、對帳、月結，也不能改團隊、方案和公司設定。",
    roleAccountant: "看今天，確認和撤回繳款、對帳、屋主報表、記支出、月結，可以匯出報表；看得到物件和租約但不能修改，沒有報修和訊息，也看不到租客電話。",
    roleMaintenance: "處理報修、聯絡租客；看不到收款和報表。",
    readFailed: "這裡暫時讀不到，請再試一次。",
    retry: "再試一次",
    saveFailed: "沒有存成功，請再試一次。",
  },
  en: {
    title: "Team",
    leadLimit: "Team size {used}/{limit}",
    leadNoLimit: "Team size {used}",
    leadNote: "Every colleague counts as one, whatever their role.",
    add: "Add a colleague",
    colName: "Colleague",
    colRole: "Role",
    colStatus: "Status",
    statusActive: "Active",
    statusInvited: "Invited",
    statusPaused: "Paused",
    pausedSub: "Trial ended; restored after you upgrade",
    more: "More",
    resend: "Resend invitation",
    perms: "See the full permission table",
    securityTitle: "Company-wide security rules",
    require2fa: "Require two-step verification for all members",
    require2faSub: "Once on, colleagues who have not set it up must finish it at their next sign-in.",
    fullTitle: "Your team is full",
    fullBody: "Your team is full ({used}/{limit}). Upgrade to Premium for unlimited colleagues, or deactivate a colleague first.",
    plans: "See plans",
    close: "Close",
    cancel: "Cancel",
    roleAdmin: "Can do everything, including the team, the plan and company settings.",
    roleManager: "Sees Today and reports; handles properties, tenants, leases, payment confirmation, expenses, repairs and messages, and can export reports. Cannot reverse payments, reconcile, close the month, or change the team, the plan or company settings.",
    roleAccountant: "Sees Today; confirms and reverses payments, reconciles, owner statements, records expenses, closes the month, and can export reports. Sees properties and leases but cannot change them; no repairs or messages, and no tenant phone numbers.",
    roleMaintenance: "Handles repairs and contacts tenants; cannot see payments or reports.",
    readFailed: "This is temporarily unavailable. Please try again.",
    retry: "Try again",
    saveFailed: "That didn't save. Please try again.",
  },
};
export type TeamCopy = (typeof copy)["zh-TW"];
export function brandV3TeamCopy(locale: Locale): TeamCopy { return copy[locale]; }
export function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
}
