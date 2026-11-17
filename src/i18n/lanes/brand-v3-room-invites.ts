import type { Locale } from "../index";

// FE-ROOMINV (MGT-147-AC2): 「一次邀請全部房間」, 「複製連結」, 「列印 QR」 are P52 APPROVED (Ron 2026-11-16 ~02:20 PT,
// 「按照建議」; screens.md FE-ROOMINV). 「已複製」 and the error sentence reuse the M4 invite panel copy. EN is a translation.
const copy = {
  "zh-TW": { title: "一次邀請全部房間", copy: "複製連結", print: "列印 QR", copied: "已複製", error: "這裡暫時讀不到，請再試一次。", retry: "再試一次" },
  en: { title: "Invite all rooms at once", copy: "Copy link", print: "Print QR", copied: "Copied", error: "This is temporarily unavailable. Please try again.", retry: "Try again" },
};
export function brandV3RoomInvitesCopy(locale: Locale) { return copy[locale]; }
