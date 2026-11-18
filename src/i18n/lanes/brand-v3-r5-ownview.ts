import type { Locale } from "../index";

// R5-OWNVIEW (設定 › 規則與資料 › 屋主看得到什麼; MGT-138, B-073). zh-TW is verbatim from the approved frame
// 「設定・規則與資料・屋主看得到什麼」 in brand-3.0.html (round 5); the new words (lead, block description, the two
// switch sub-lines) are P52 approved as written (Ron, PENDING-RON PR-018, round 5 strings). The read error, retry and
// save failure reuse the GS-02 pattern (MGT-138-AC4). 「管理費規則・依物件設定」 is not here: B-049 is not built,
// so the side-card row is not shown. EN is a translation (draft).
const copy = {
  "zh-TW": {
    lead: "規則與資料：公司資料、管理費規則，和屋主看得到什麼。",
    title: "屋主看得到什麼",
    description: "全公司一個設定，對所有屋主都一樣。",
    showName: "租客姓名",
    showNameSub: "屋主在月報和首頁看得到租客的名字。",
    showPhone: "租客電話",
    showPhoneSub: "屋主看得到租客的手機號碼。",
    others: "這一頁的其他設定",
    company: "公司資料",
    companyTaxId: (name: string, taxId: string) => `${name}・統編 ${taxId}`,
    notify: "提醒租客",
    notifyWhere: "在「通知設定」",
    readFailed: "這裡暫時讀不到，請再試一次。",
    retry: "再試一次",
    saveFailed: "沒有存成功，請再試一次。",
  },
  en: {
    lead: "Rules & data: company details, management-fee rules, and what owners can see.",
    title: "What owners can see",
    description: "One setting for the whole company, the same for every owner.",
    showName: "Tenant name",
    showNameSub: "Owners see the tenant's name in monthly statements and on their home page.",
    showPhone: "Tenant phone",
    showPhoneSub: "Owners see the tenant's mobile number.",
    others: "Other settings on this page",
    company: "Company details",
    companyTaxId: (name: string, taxId: string) => `${name} · Tax ID ${taxId}`,
    notify: "Tenant reminders",
    notifyWhere: "In Notifications",
    readFailed: "This is temporarily unavailable. Please try again.",
    retry: "Try again",
    saveFailed: "That didn't save. Please try again.",
  },
};
export function brandV3OwnViewCopy(locale: Locale) { return copy[locale]; }
