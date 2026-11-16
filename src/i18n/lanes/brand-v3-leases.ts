import type { Locale } from "../index";
// B-071 R3-LIST / lease page tabs (Round 3: 租約, approved Ron 2026-11-15 00:05 PT, 「全部核准」).
// Only strings from the R3-LIST, R3-FEES, R3-DEP rows and frames, MGT-112-AC6/AC8, and the
// GS-02 / GS-03 answers (2026-11-15). The lead sentence reuses R2-TEN-ONE (tenantOneCopy.lead).
// Not here (no approved string or no data source): the R3-LIST lead 「有 {n} 份租約，{k} 份還要補資料。」,
// 待補資料／補資料, the R3-FEES cards, 已收／還差, receipt rows, the custodian line and the R3-DEP footer.
const copy = {
  "zh-TW": {
    overview: "概要", fees: "費用", deposit: "押金", handover: "點交", moveOut: "退租結算",
    active: "進行中", endingSoon: "即將到期", view: "查看",
    empty: "還沒有租約", emptyHint: "建立第一筆租約就會出現在這裡。", create: "建立租約",
    noResult: "找不到符合的結果", noResultHint: "換個關鍵字，或清除搜尋看全部。", clearSearch: "清除搜尋",
    permission: "你沒有權限看這頁", permissionHint: "這裡只有管理員和經理能看。",
    failed: "資料載入失敗", retry: "再試一次",
    agreedDeposit: "約定押金",
    readError: "這裡暫時讀不到，請再試一次。",
    noPerm: "你目前的角色看不到這一頁，需要的話請公司管理員幫你開。", home: "回到首頁",
  },
  en: {
    overview: "Overview", fees: "Fees", deposit: "Deposit", handover: "Handover", moveOut: "Move-out settlement",
    active: "In progress", endingSoon: "Ending soon", view: "View",
    empty: "No leases yet", emptyHint: "Leases appear here once you create the first one.", create: "Create lease",
    noResult: "No matching results", noResultHint: "Try another keyword, or clear the search to see everything.", clearSearch: "Clear search",
    permission: "You don't have permission to view this page", permissionHint: "Only admins and managers can see this page.",
    failed: "Could not load data", retry: "Try again",
    agreedDeposit: "Agreed deposit",
    readError: "This is temporarily unavailable. Please try again.",
    noPerm: "Your current role can't see this page. If you need it, ask your company admin to open it for you.", home: "Back to home",
  },
};
export const leasesCopy = (locale: Locale) => copy[locale];
