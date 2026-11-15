import type { Locale } from "../index";
// R2-TEN-ONE + tenant-mobile m-detail + login-phone mgr-entry, approved sources.
// Approved by Ron 2026-11-15 11:42 PT (PENDING-RON PR-018): where no active, dated lease proves the lead,
// retain the shipped name + lease status display; do not compose a new sentence.
const copy = {
  "zh-TW": {
    lead: "{name}住{unit}，租約到 {date}。", contact: "聯絡資料", email: "Email",
    note: "修改號碼時，系統會把驗證碼傳到新號碼。租客在自己的租多啦完成驗證前，目前的號碼不會變更。",
  },
  en: {
    lead: "{name} lives at {unit}; the lease ends on {date}.", contact: "Contact details", email: "Email",
    note: "When a number is changed, a verification code is sent to the new number. The current number stays unchanged until the tenant verifies it in their own Condola account.",
  },
};
export const tenantOneCopy = (locale: Locale) => copy[locale];
