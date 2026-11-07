import type { Locale } from ".";

export function lineTenantCopy(locale: Locale) {
 return locale === "en" ? {
  bind: "Link LINE", manage: "LINE settings", consent: "I agree to link my LINE account to this company's contact and receive its notifications. Email recovery remains available.",
  unlink: "Unlink this company", revoke: "Unlink LINE everywhere", fallback: "Continue with Email", unavailable: "Please sign in again or reopen your invitation.",
 } : {
  bind: "綁定 LINE", manage: "LINE 設定", consent: "我同意將 LINE 帳號綁定至此公司的聯絡人並接收通知。仍可使用 Email 復原帳號。",
  unlink: "解除此公司綁定", revoke: "解除所有 LINE 綁定", fallback: "使用 Email 登入", unavailable: "請重新登入或開啟邀請。",
 };
}
