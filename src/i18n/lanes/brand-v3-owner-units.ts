import type { Locale } from "../index";

// RO-UNITS (owner round, 總覽 › 我的物件; OWN-33-AC1). zh-TW: the section title and the status wording are P52
// APPROVED as drafted (Ron 2026-11-15 20:44 PT, PENDING-RON PR-023; frame 「總覽・我的物件」 approved ~13:01 PT).
// 「租客」 when names are hidden reuses the existing i_tenant_hidden wording. Read errors reuse O-STATES. EN translation.
const copy = {
  "zh-TW": {
    title: "我的物件",
    tenantHidden: "租客",
    paid: "已確認繳款",
    partial: (rest: string) => `部分已繳・還差 ${rest}`,
    overdue: "逾期未繳",
    vacant: (days: number) => `空租 ${days} 天`,
  },
  en: {
    title: "My properties",
    tenantHidden: "Tenant",
    paid: "Payment confirmed",
    partial: (rest: string) => `Partly paid · ${rest} to go`,
    overdue: "Overdue",
    vacant: (days: number) => `Vacant ${days} ${days === 1 ? "day" : "days"}`,
  },
};
export function brandV3OwnerUnitsCopy(locale: Locale) { return copy[locale]; }
