import type { Locale } from "../index";

export const partnerConsentStrings = {
  "zh-TW": {
    title: "公司服務同意",
    summary: "本服務可能委託第三方 AI 服務協助處理資料。",
    checkbox: "我已閱讀並代表公司同意《隱私權政策》及《合作夥伴合約》",
    accept: "同意並開始使用",
    logout: "登出",
    waiting: "等待公司管理員同意",
    privacy: "隱私權政策",
    partner_agreement: "合作夥伴合約",
    version: "版本",
    effective: "生效日期",
    read: "閱讀全文",
    fallback: "暫無本語系版本",
    authority: "本人有權代表公司同意",
    required: "請勾選閱讀同意及代表公司同意的權限確認後繼續。",
    unavailable: "同意文件暫時無法使用，請稍後再試。",
    history: "合規同意紀錄",
    time: "同意時間",
    consenter: "同意人",
  },
  en: {
    title: "Company service consent",
    summary: "This service may engage third-party AI services to help process data.",
    checkbox: "I have read and agree to the Privacy Policy and Partner Agreement on behalf of the company.",
    accept: "Agree and start",
    logout: "Sign out",
    waiting: "Waiting for a company administrator to agree",
    privacy: "Privacy Policy",
    partner_agreement: "Partner Agreement",
    version: "Version",
    effective: "Effective date",
    read: "Read full text",
    fallback: "This language is not available yet",
    authority: "I am authorized to agree on behalf of the company.",
    required: "Please check both the agreement and company authorization boxes to continue.",
    unavailable: "The consent documents are unavailable. Please try again later.",
    history: "Compliance consent records",
    time: "Consent time",
    consenter: "Agreed by",
  },
} as const;

export function partnerConsentCopy(locale: Locale) {
  return partnerConsentStrings[locale];
}
