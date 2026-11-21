import type { Locale } from "../index";
// B-071 R3-LIST (Round 3: 租約, approved Ron 2026-11-15 00:05 PT, 「全部核准」).
// Only strings from the R3-LIST row and frame, MGT-112-AC6/AC8 and the GS-02 answer (2026-11-15).
// Not here (no approved string or no data source): the R3-LIST lead 「有 {n} 份租約，{k} 份還要補資料。」
// and 待補資料／補資料. The lease page itself stays the existing /m/leases/[id] page.
const copy = {
  "zh-TW": {
    active: "進行中", endingSoon: "即將到期", view: "查看",
    empty: "還沒有租約", emptyHint: "建立第一筆租約就會出現在這裡。", create: "建立租約",
    noResult: "找不到符合的結果", noResultHint: "換個關鍵字，或清除搜尋看全部。", clearSearch: "清除搜尋",
    permission: "你沒有權限看這頁", permissionHint: "這裡只有管理員和經理能看。",
    failed: "資料載入失敗", retry: "再試一次",
  },
  en: {
    active: "In progress", endingSoon: "Ending soon", view: "View",
    empty: "No leases yet", emptyHint: "Leases appear here once you create the first one.", create: "Create lease",
    noResult: "No matching results", noResultHint: "Try another keyword, or clear the search to see everything.", clearSearch: "Clear search",
    permission: "You don't have permission to view this page", permissionHint: "Only admins and managers can see this page.",
    failed: "Could not load data", retry: "Try again",
  },
};
export const leasesCopy = (locale: Locale) => copy[locale];
