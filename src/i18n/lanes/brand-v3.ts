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
    context: "{company} | {name} ({role})",
    brandParty: "{brand} · {party}",
  },
};
export type NavigationCopyKey = keyof typeof navigationCopy.en;
export function brandV3NavigationCopy(locale: Locale) { return navigationCopy[locale]; }
