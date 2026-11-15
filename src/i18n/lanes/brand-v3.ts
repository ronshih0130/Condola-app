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
    renewalDate: "租約 {date} 到期", renewalDays: "{days} 天後到期", departureDate: "{date} 搬出",
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
    renewalDate: "Lease ends {date}", renewalDays: "Ends in {days} days", departureDate: "Moving out {date}",
    overdue: "{days} days overdue", more: "See all {count} items",
    confirmedBills: "Month {month} bills, payments confirmed", noConfirmed: "No payments confirmed yet", source: "View source",
    billProgress: "Due {amount} · Confirmed {percent}% · {paid}/{total} items",
    billProgressWithoutPercent: "Due {amount} · Confirmed {paid}/{total} items",
  },
};
export function brandV3TodayCopy(locale: Locale) { return todayCopy[locale]; }
