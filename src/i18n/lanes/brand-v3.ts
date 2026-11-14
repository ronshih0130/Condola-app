import type { Locale } from "../index";

const copy = {
  "zh-TW": { m: "管理方", t: "租客", o: "屋主", v: "廠商", account: "{role}：{name}" },
  en: { m: "Manager", t: "Tenant", o: "Owner", v: "Vendor", account: "{role}: {name}" },
};

export function brandV3Copy(locale: Locale) {
  return copy[locale];
}
