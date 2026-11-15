import type { Locale } from "../index";
// R2-TEN and Round 2 conflict choices, approved 2026-11-14; tenant-mobile m-list.
const copy = {
  "zh-TW": {
    title: "租客", area: "物件與租客", lead: "有 {n} 位租客，{k} 位還沒留手機。",
    // Approved by Ron 2026-11-15 11:42 PT (PENDING-RON PR-018): first-clause fallback for the item flag OFF state.
    leadOff: "有 {n} 位租客。", duplicate: "和 {name} 的號碼相同",
    search: "搜尋姓名、單位、電話", searchPrivate: "搜尋姓名、單位", submit: "搜尋",
    all: "全部租客", missing: "缺手機（{n}）", unit: "單位", phone: "手機", line: "LINE",
    unverified: "未驗證", unverifiedTip: "還沒用簡訊確認過，號碼可能有誤。", staff: "管理方更新",
    absent: "尚未填寫", joined: "已加入", notJoined: "未加入",
    emptyFilter: "沒有缺手機號碼的租客", clearFilter: "清除篩選",
    noResult: "找不到符合的結果", noResultHint: "換個關鍵字，或清除搜尋看全部。", clearSearch: "清除搜尋",
    permission: "請管理者完成設定。", failed: "資料載入失敗", retry: "再試一次",
    next: "下一頁", first: "返回第一頁", loading: "載入中", invite: "邀請租客",
  },
  en: {
    title: "Tenants", area: "Properties and tenants", lead: "{n} tenants; {k} have not provided a mobile number.",
    leadOff: "{n} tenants.", duplicate: "Same number as {name}",
    search: "Search name, unit or phone", searchPrivate: "Search name or unit", submit: "Search",
    all: "All tenants", missing: "Missing phone ({n})", unit: "Unit", phone: "Mobile", line: "LINE",
    unverified: "Unverified", unverifiedTip: "This number has not been confirmed by SMS and may be incorrect.", staff: "Updated by management",
    absent: "Not provided", joined: "Joined", notJoined: "Not joined",
    emptyFilter: "No tenants are missing a mobile number", clearFilter: "Clear filters",
    noResult: "No matching results", noResultHint: "Try another keyword, or clear the search to see everything.", clearSearch: "Clear search",
    permission: "Ask an administrator to complete setup.", failed: "Could not load data", retry: "Try again",
    next: "Next page", first: "Back to first page", loading: "Loading", invite: "Invite tenants",
  },
};
export const tenantsCopy = (locale: Locale) => copy[locale];
