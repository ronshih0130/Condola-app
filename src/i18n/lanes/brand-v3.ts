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
