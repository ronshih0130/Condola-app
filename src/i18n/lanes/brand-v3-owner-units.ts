import type { Locale } from "../index";

// RO-UNITS (owner round, 總覽 › 我的物件; OWN-33-AC1). zh-TW: the section title and the status wording are P52
// APPROVED as drafted (Ron 2026-11-15 20:44 PT, PENDING-RON PR-023; frame 「總覽・我的物件」 approved ~13:01 PT).
// 「租客」 when names are hidden reuses the existing i_tenant_hidden wording. Read errors reuse O-STATES. EN translation.
// RO-UNIT (frame 「總覽・我的物件・信義路 2 樓」, approved with the owner round; new words per PENDING-RON PR-023):
// 「租客」 (row label), 「最近的繳款」, 「進行中的報修」 and 「{n} 月」. 「電話」, 「租期」 and 「月租」 reuse the existing
// dictionary words i_phone_label / i_term / i_rent_label. EN is a draft translation.
const copy = {
  "zh-TW": {
    title: "我的物件",
    tenantHidden: "租客",
    paid: "已確認繳款",
    partial: (rest: string) => `部分已繳・還差 ${rest}`,
    overdue: "逾期未繳",
    vacant: (days: number) => `空租 ${days} 天`,
    tenant: "租客",
    recentPayments: "最近的繳款",
    openRepairs: "進行中的報修",
    month: (n: number) => `${n} 月`,
  },
  en: {
    title: "My properties",
    tenantHidden: "Tenant",
    paid: "Payment confirmed",
    partial: (rest: string) => `Partly paid · ${rest} to go`,
    overdue: "Overdue",
    vacant: (days: number) => `Vacant ${days} ${days === 1 ? "day" : "days"}`,
    tenant: "Tenant",
    recentPayments: "Recent payments",
    openRepairs: "Open repairs",
    month: (n: number) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][n - 1] ?? String(n),
  },
};
export function brandV3OwnerUnitsCopy(locale: Locale) { return copy[locale]; }
