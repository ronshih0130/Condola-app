import type { Locale } from "../index";

// Owner / vendor OWN-STATUS strings that contain the restricted collection word. Ron 2026-11-13 22:25 PT allows
// that word only in the manager nav section name and in the owner's/vendor's own status (the vendor status
// below); Ron 2026-11-15 11:42 PT (PENDING-RON PR-016) approved these exact strings as that exception. The copy
// guard exempts exactly these literals in this file only (src/i18n/copy-guard.test.ts); the word anywhere else
// still fails. Used by M-PROXY (screens.md, MGT-120) and the vendor shell / V-RECV (OV-SH-*, VEN-14).
// B-063: vendorEmpty is the approved V-EMPTY reason (VEN-14-AC4, Ron 2026-11-12 12:57 PT) and vendorListEmpty the
// V-RECV empty heading (drawing 22; P52 approved 2026-11-15 11:42 PT, PENDING-RON PR-018). EN is a translation.
const copy = {
  "zh-TW": {
    proxyTitle: "代屋主確認收款",
    proxyNote: "收款帳戶是屋主的，你只是代他在系統裡記下「已收到」，不是代他收錢。",
    proxyDone: "已代{屋主}記下這筆收款。",
    vendorTab: "收款",
    vendorStatus: "待收款",
    vendorListTitle: "待收款紀錄",
    vendorEmpty: "目前沒有未結案件，也沒有待收款。免下載 App，用這個網頁就行。",
    vendorListEmpty: "還沒有待收款紀錄",
  },
  en: {
    proxyTitle: "Confirm receipt for the owner",
    proxyNote: "The account is the owner's. You are only recording \"received\" in the system for them, not collecting money.",
    proxyDone: "Recorded this receipt for {屋主}.",
    vendorTab: "Payments",
    vendorStatus: "Awaiting payment",
    vendorListTitle: "Awaiting payment",
    vendorEmpty: "No open jobs and nothing awaiting payment. No app to download: this web page is all you need.",
    vendorListEmpty: "No payments awaited yet",
  },
} as const;
export const OWN_STATUS_COLLECTION_STRINGS = Object.values(copy["zh-TW"]);
export function ownStatusCopy(locale: Locale) { return copy[locale]; }
