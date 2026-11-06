import type { Locale } from "../index";

/** B-028 package 2 message bodies that had no existing copy. Titles and labels reuse
 * the center, handover, owner report and invite strings. The repair labels below are
 * verbatim copies of the repair decision copy (asserted equal in
 * notification-event-templates.test.ts) so this lane does not import the guarded
 * repair approval module family. */
const words = {
  "zh-TW": {
    inviteOpen: "請使用管理方提供的連結開啟。",
    inviteSubjectTenant: "邀請您使用租客頁",
    inviteSubjectOwner: "邀請您使用屋主頁",
    repair: { title: "修繕決定", emergency: "緊急例外", water: "水務", electricity: "電力", safety: "安全", approved: "已核准", rejected: "已拒絕", more_information: "要求補充資料" } as Record<string, string>,
    payment: (name: string, firm: string, label: string, amount: string) => `${name}，${firm}：${label}，金額 ${amount}。請至租客頁查看繳款紀錄。`,
    handover: (name: string, firm: string, phase: string, revision: number) => `${name}，${firm}：${phase}已發布第 ${revision} 版，請至租客頁查看並回覆。`,
    report: (name: string, firm: string, start: string, end: string, version: string) => `${name}，${firm}：${start} 至 ${end} 的月結報表已產生${version}，請至屋主頁查看。`,
    approval: (name: string, firm: string, amount: string) => `${name}，${firm}：有一筆修繕估價（${amount}）需要您決定，請至屋主頁查看。`,
    emergency: (name: string, firm: string, category: string) => `${name}，${firm}：管理方已就${category}問題使用緊急例外並先行安排修繕，請至屋主頁查看。`,
    decision: (name: string, firm: string, version: number, decision: string) => `${name}，${firm}：屋主已對第 ${version} 版估價做出決定（${decision}），請至維修案件查看。`,
  },
  en: {
    inviteOpen: "Open the link your property manager shared with you.",
    inviteSubjectTenant: "Your tenant portal invitation",
    inviteSubjectOwner: "Your owner portal invitation",
    repair: { title: "Repair decisions", emergency: "Emergency exception", water: "Water", electricity: "Electricity", safety: "Safety", approved: "Approved", rejected: "Rejected", more_information: "More information requested" } as Record<string, string>,
    payment: (name: string, firm: string, label: string, amount: string) => `${name}, ${firm}: ${label} for ${amount}. View your payment history in the tenant portal.`,
    handover: (name: string, firm: string, phase: string, revision: number) => `${name}, ${firm}: ${phase} version ${revision} was published. Review and reply in the tenant portal.`,
    report: (name: string, firm: string, start: string, end: string, version: string) => `${name}, ${firm}: the monthly statement for ${start} to ${end} now has ${version}. View it in the owner portal.`,
    approval: (name: string, firm: string, amount: string) => `${name}, ${firm}: a repair estimate (${amount}) needs your decision. Review it in the owner portal.`,
    emergency: (name: string, firm: string, category: string) => `${name}, ${firm}: the management team used an emergency exception for a ${category} issue and arranged the repair. Review it in the owner portal.`,
    decision: (name: string, firm: string, version: number, decision: string) => `${name}, ${firm}: the owner recorded a decision on estimate version ${version} (${decision}). View the repair ticket.`,
  },
} satisfies Record<Locale, Record<string, unknown>>;

export function notificationEventCopy(locale: Locale) { return words[locale]; }
