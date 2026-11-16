import type { Locale } from "../index";

const copy = {
  "zh-TW": { m: "管理方", t: "租客", o: "屋主", v: "廠商", account: "{role}：{name}" },
  en: { m: "Manager", t: "Tenant", o: "Owner", v: "Vendor", account: "{role}: {name}" },
};

export function brandV3Copy(locale: Locale) {
  return copy[locale];
}

// B-043 AREAS / shell aria labels; PLT-44-AC11 identity pattern.
const navigationCopy = {
  "zh-TW": {
    properties: "物件與租客",
    money: "收款",
    maintenance: "維修",
    more: "更多",
    roles: "角色權限",
    import: "資料匯入",
    navigation: "主要導覽",
    context: "{company}｜{name}（{role}）",
    // SH-NONAME: no display name → drop the name and its 「｜」.
    contextNoName: "{company}（{role}）",
    brandParty: "{brand}・{party}",
  },
  en: {
    properties: "Properties and tenants",
    money: "Payments",
    maintenance: "Maintenance",
    more: "More",
    roles: "Role permissions",
    import: "Data import",
    navigation: "Main navigation",
    context: "{company} · {name} ({role})",
    contextNoName: "{company} ({role})",
    brandParty: "{brand} · {party}",
  },
};
export type NavigationCopyKey = keyof typeof navigationCopy.en;
export function brandV3NavigationCopy(locale: Locale) { return navigationCopy[locale]; }

// screens.md, Shell strings and states (Ron 2026-11-14 15:24 PT); EN is draft.
export function brandV3ShellCopy(locale: Locale) {
  return locale === "en"
    ? { menuContext: "{role} · {company}", close: "Close" }
    : { menuContext: "{role}・{company}", close: "關閉" };
}

/** Server supplies the rendered date to avoid a midnight hydration mismatch. */
export function shellTodayTitle(now: Date, locale: Locale) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", weekday: "short",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  const weekday = part("weekday");
  if (locale === "en") {
    const month = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", month: "short" }).format(now);
    return `Today · ${weekday} ${part("day")} ${month}`;
  }
  const week: Record<string, string> = { Mon: "一", Tue: "二", Wed: "三", Thu: "四", Fri: "五", Sat: "六", Sun: "日" };
  return `今天・${part("month")} 月 ${part("day")} 日（${week[weekday]}）`;
}

// 今天: screens B3A-TODAY/ROW/NUM, T-ROWS/LINE/WAIT/CLEAR/FAIL/NUM-ZERO/MORE,
// SH-NONAME/SANDBOX; DECISIONS 2026-11-14 20:50. English is a plain-language translation.
const todayCopy = {
  "zh-TW": {
    title: "今天", greeting: "{name}早，", greetingOnly: "{name}早。", headline: "今天輪到你的有 {count} 件。",
    waitingHeadline: "今天沒有輪到你的事。", clearHeadline: "今天都處理好了。", clear: "今天都處理好了",
    failure: "待辦暫時讀不到。", failureDetail: "你的資料都還在，稍後再看一次。", retry: "再試一次",
    sandbox: "這裡的人名、地址和金額都是範例。", mine: "輪到你・{count} 件", others: "等別人・{count} 件",
    paymentSummary: "確認已繳款 {count} 筆", vacantSummary: "找新租客 {count} 件",
    renewalSummary: "詢問續約意願 {count} 件", earlySummary: "提早找租客 {count} 件",
    waitingSummary: "另外 {count} 件在等租客。", summaryEnd: "。", separator: "、",
    rentals: "出租與租約", checked: "{areas}都看過了，沒有要處理的事。",
    confirm: "確認已繳款", vacant: "找新租客", renewal: "詢問續約意願", early: "提早找租客",
    yourStep: "輪到你・{step}", reReport: "等租客{name}重新回報", overdueTurn: "等租客{name}繳款",
    reported: "已回報・待確認", vacantBadge: "待出租", earlyBadge: "即將空出",
    vacantDays: "空了 {days} 天", vacantRent: "每月少收 {amount}",
    renewalDate: "租約 {date} 到期", renewalDays: "{days} 天後到期", departureDate: "{date} 搬出", overdueRent: "{month} 月租金 {amount}", overdueOpen: "逾期未繳 {amount}", declined: "{name}不續約",
    overdue: "逾期 {days} 天", more: "看全部 {count} 件",
    confirmedBills: "{month} 月帳單，已確認繳款", noConfirmed: "還沒有確認的繳款", source: "查來源",
    billProgress: "應繳 {amount}・已確認 {percent}%・{paid}／{total} 筆",
    billProgressWithoutPercent: "應繳 {amount}・已確認 {paid}／{total} 筆",
  },
  en: {
    title: "Today", greeting: "Good morning, {name}. ", greetingOnly: "Good morning, {name}.", headline: "It's your turn on {count} items today.",
    waitingHeadline: "Nothing needs your action today.", clearHeadline: "Everything is handled today.", clear: "Everything is handled today",
    failure: "Your tasks are temporarily unavailable.", failureDetail: "Your data is still here. Check again shortly.", retry: "Try again",
    sandbox: "The names, addresses and amounts here are examples.", mine: "Your turn · {count} items", others: "Waiting on others · {count} items",
    paymentSummary: "Confirm {count} payments", vacantSummary: "Find new tenants: {count} items",
    renewalSummary: "Ask about renewal: {count} items", earlySummary: "Find tenants early: {count} items",
    waitingSummary: "Another {count} items are waiting on tenants.", summaryEnd: ". ", separator: ", ",
    rentals: "Rentals and leases", checked: "{areas} have been checked. Nothing needs action.",
    confirm: "Confirm payment", vacant: "Find a new tenant", renewal: "Ask about renewal", early: "Find a tenant early",
    yourStep: "Your turn · {step}", reReport: "Waiting for the tenant{name} to report again", overdueTurn: "Waiting for the tenant{name} to pay",
    reported: "Reported · awaiting confirmation", vacantBadge: "Vacant", earlyBadge: "Available soon",
    vacantDays: "Vacant for {days} days", vacantRent: "Missing {amount} per month",
    renewalDate: "Lease ends {date}", renewalDays: "Ends in {days} days", departureDate: "Moving out {date}", overdueRent: "Rent for month {month}, {amount}", overdueOpen: "Overdue, unpaid {amount}", declined: "{name} is not renewing",
    overdue: "{days} days overdue", more: "See all {count} items",
    confirmedBills: "Month {month} bills, payments confirmed", noConfirmed: "No payments confirmed yet", source: "View source",
    billProgress: "Due {amount} · Confirmed {percent}% · {paid}/{total} items",
    billProgressWithoutPercent: "Due {amount} · Confirmed {paid}/{total} items",
  },
};
export function brandV3TodayCopy(locale: Locale) { return todayCopy[locale]; }

// OV-SH-PHONE / OV-SH-NONAME. Interim owner navigation until O-HOME and the overview ship.
const ownerShellCopy = {
  "zh-TW": { home: "首頁", statements: "月報", context: "{name} 你好｜管理方：{company}", contextNoName: "管理方：{company}" },
  en: { home: "Home", statements: "Monthly statements", context: "Hello {name} · Managed by: {company}", contextNoName: "Managed by: {company}" },
};
export function brandV3OwnerShellCopy(locale: Locale) { return ownerShellCopy[locale]; }

// Batch 2 O-STATES, shared by owner lanes (screens.md). EN translation.
export function brandV3OwnerStateCopy(locale: Locale) {
  return locale === "en"
    ? { error: "This is temporarily unavailable. Please try again.", retry: "Try again" }
    : { error: "這裡暫時讀不到，請再試一次。", retry: "再試一次" };
}
// O-RPT / O-RPT-SRC, D14. No P52 empty/one-off/other-source proposals.
export function brandV3OwnerReportCopy(locale: Locale) {
  return locale === "en"
    ? { rent: "Rent income", title: "Monthly report · {month}", note: "Opening this report does not constitute confirmation or agreement.", source: "View source", sourceLine: "{n} confirmed payments · {date}" }
    : { rent: "租金收入", title: "{month} 月月報", note: "打開月報不構成確認或同意。", source: "查來源", sourceLine: "{n} 筆已確認的繳款・{date}" };
}
// O-HOME / O-EST / O-EMPTY / O-STATES, revision 9; P52 zero lead uses the existing home title.
export function brandV3OwnerHomeCopy(locale: Locale) {
  return locale === "en" ? {
    lead: "{name}, {count} items need your attention.", leadNoName: "{count} items need your attention.",
    tasks: "Needs your attention", estimate: "Estimate", pending: "Awaiting approval", approve: "Approve estimate",
    empty: "Nothing needs your attention", emptyDetail: "Nothing needs your attention right now. Rest easy.",
    failure: "This is temporarily unavailable. Please try again.", title: "Approve this estimate",
    prompt: "The estimate for {item} is {amount}. Approve it?", property: "Property", item: "Item", vendor: "Vendor",
    description: "Description", version: "Version", versionNumber: "Version {n}",
    emergencyNote: "已緊急處理・仍可核准",
    note: "This exceeds the management company's threshold. Until you approve, the vendor cannot mark the job as in progress.",
    back: "Send back", reason: "Reason", done: "Estimate approved", approvedVersion: "Approved version", amount: "Amount", status: "Status",
    handoff: "The manager and vendor now see the same version. The vendor can start as agreed.",
  } : {
    lead: "{name}，有 {count} 件事要你處理。", leadNoName: "有 {count} 件事要你處理。",
    tasks: "要你處理", estimate: "估價", pending: "待核准", approve: "核准估價",
    empty: "目前沒有要你處理的事", emptyDetail: "目前沒有要你處理的事，放心。",
    failure: "這裡暫時讀不到，請再試一次。", title: "核准這筆估價",
    prompt: "{item}估價 {amount}，要不要核准？", property: "物件", item: "項目", vendor: "廠商",
    description: "說明", version: "版本", versionNumber: "第 {n} 版",
    emergencyNote: "已緊急處理・仍可核准",
    note: "這筆超過管理公司門檻。你核准前，廠商不能把工單標成施工中。",
    back: "退回", reason: "原因", done: "估價已核准", approvedVersion: "核准版本", amount: "金額", status: "狀態",
    handoff: "管理方和廠商現在會看到同一版，廠商可以依約定開工。",
  };
}

// R1-BANK / R1-BANK-ROW (Round 1, 2026-11-14 18:53); scope follows phase 3 §3.2.
// A single partial stored suggestion uses the possible-count wording, never the all-three claim.
export function brandV3BankCopy(locale: Locale) {
  return locale === "en" ? {
    lead: "Month {month} has {all} bank lines, {matched} matched and {review} needing your review.",
    upload: "Upload bank statement", lastUpload: "Last upload {time}",
    uploadScope: "Across this organization's active accounts, all months.",
    review: "Needs your review", matched: "Matched", all: "All", ignored: "Ignored",
    exact: "All three match, not confirmed yet", possible: "{count} possible matches",
    same_day: "{count} payments on the same date for the same amount", none: "No matching bill",
    confirm: "Confirm match", reject: "Not this payment", choose: "Choose one", manual: "Match manually",
    dateLast5: "Posted date · last five digits", last5: "Last five digits {last5}",
    suggestion: "Suggestion", month: "Month", previous: "Previous month", next: "Next month",
    more: "Next page", shown: "Showing {shown} of {total}", failure: "Couldn't load the data", retry: "Try again",
    loading: "Loading", close: "Close", noRows: "No unmatched bank lines",
  } : {
    lead: "{month} 月的銀行明細有 {all} 筆，{matched} 筆已經對上，{review} 筆要你看。",
    upload: "上傳銀行明細", lastUpload: "最後上傳 {time}",
    uploadScope: "本組織未封存帳戶，不限月份。",
    review: "要你看", matched: "已對上", all: "全部", ignored: "已忽略",
    exact: "三樣都對上，還沒確認", possible: "有 {count} 筆可能",
    same_day: "同一天同金額有 {count} 筆", none: "沒有對得上的帳單",
    confirm: "確認配對", reject: "不是這筆", choose: "選一筆", manual: "手動配對",
    dateLast5: "交易日・末五碼", last5: "末五碼 {last5}", suggestion: "建議",
    month: "月份", previous: "上一個月", next: "下一個月", more: "下一頁", shown: "顯示 {shown}／{total} 筆",
    failure: "資料載入失敗", retry: "再試一次", loading: "載入中", close: "關閉", noRows: "沒有未配對銀行明細",
  };
}
