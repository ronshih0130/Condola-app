import type { Locale } from "../index";

// RO-DECIDED (owner round, 更多 › 核准紀錄; OWN-35). zh-TW: entry name and the empty sentence are
// P52 APPROVED (Ron 2026-11-15 20:44 PT, PENDING-RON PR-023); B1-NOPERM sentence and 「回到首頁」
// are P52 APPROVED with GS-03 (screens.md § "What the 缺 G-* tags mean now"). EN is a translation.
// Result labels follow the RO-DECIDED row (已核准 / 退回 / 要求補充資料; Ron approved the owner round 11/15;
// 退回 matches the 11/13 O-EST button set and D16 — Design Session ruling on OQ-079). Field labels and
// states reuse existing copy (O-STATES, O-EST).
const copy = {
  "zh-TW": {
    title: "核准紀錄",
    empty: "還沒有決定過的估價。",
    noPerm: "你目前的角色看不到這一頁，需要的話請公司管理員幫你開。",
    home: "回到首頁",
    result: { approved: "已核准", rejected: "退回", more_information: "要求補充資料" },
  },
  en: {
    title: "Approval history",
    empty: "No decided estimates yet.",
    noPerm: "Your current role can't see this page. If you need it, ask your company admin to open it for you.",
    home: "Back to home",
    result: { approved: "Approved", rejected: "Sent back", more_information: "More information requested" },
  },
};
export function brandV3OwnerDecidedCopy(locale: Locale) { return copy[locale]; }
