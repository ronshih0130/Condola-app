import type { Locale } from "../index";

// R5-ACCT (設定 › 我的帳號; MGT-137, B-073). zh-TW is verbatim from the approved frame 「設定・我的帳號」 in
// brand-3.0.html (round 5); the new words (the lead) are P52 approved as written (Ron, PENDING-RON PR-018, round 5
// strings). 「未開啟」 is the off state of the frame's 「已開啟」 row (MGT-137-AC1, approved with PR-018). The footer line
// 「提醒信的開關在「通知設定」；全公司的兩步驟驗證規則在「團隊」。」 is the R5-NOTIFY lane's (brand-v3-r5-notify.ts), reused
// as is. The read error and retry are the GS-02 pattern (MGT-137-AC4). 繁中／EN reuse i_lang_zh / i_lang_en (SH-ME).
// EN is a translation (draft).
const copy = {
  "zh-TW": {
    lead: "我的帳號：只放跟你自己有關的設定。",
    basics: "基本資料",
    name: "名字",
    email: "Email",
    phone: "手機",
    edit: "修改",
    security: "登入與安全",
    password: "密碼",
    line: "LINE",
    linked: "已連結",
    notLinked: "尚未連結",
    mfa: "兩步驟驗證",
    mfaOn: "已開啟",
    mfaOff: "未開啟",
    devices: "登入中的裝置",
    deviceCount: (count: number) => `${count} 台`,
    language: "介面語言",
    readFailed: "這裡暫時讀不到，請再試一次。",
    retry: "再試一次",
  },
  en: {
    lead: "My account: only the settings that are about you.",
    basics: "Basic info",
    name: "Name",
    email: "Email",
    phone: "Mobile",
    edit: "Edit",
    security: "Sign-in and security",
    password: "Password",
    line: "LINE",
    linked: "Linked",
    notLinked: "Not linked",
    mfa: "Two-step verification",
    mfaOn: "On",
    mfaOff: "Off",
    devices: "Signed-in devices",
    deviceCount: (count: number) => `${count} ${count === 1 ? "device" : "devices"}`,
    language: "Language",
    readFailed: "This is temporarily unavailable. Please try again.",
    retry: "Try again",
  },
};
export function brandV3AcctCopy(locale: Locale) { return copy[locale]; }
