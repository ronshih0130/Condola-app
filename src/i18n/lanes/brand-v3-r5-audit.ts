import type { Locale } from "../index";

// R5-AUDIT (設定 › 操作紀錄, company-wide part of MGT-136: AC2, AC3 company log, AC4, AC5; B-073). zh-TW is verbatim
// from the approved frame 「設定・操作紀錄（全公司）」 in brand-3.0.html (round 5): the lead (the frame's only new
// sentence, P52, approved as written by Ron in PENDING-RON PR-018), the filter placeholders 「全部的人」「全部項目」,
// the item names 租約・繳款・單位, the entry shape 「{誰}把{什麼}從 {舊} 改成 {新}・原因：{原因}」 with 「{哪一類}・{時間}」
// beside it, and 「下一頁」. 「上一頁」 from page 2 is the approved paging of 操作紀錄 (GS-56 = A, MGT-76-AC13).
// The no-match pair is MGT-136-AC5 (B-046 SRCH pattern); the read error and 「再試一次」 reuse the GS-02 lines of the
// other R5 slices (MGT-136-AC5). 「項目」 (the item filter's accessible name) is the lead's own word. Everything
// else on the page (action names, record names, field names, 成員, 系統, 篩選, 從, 到) keeps its existing catalog
// string. EN is a translation (draft).
const copy = {
  "zh-TW": {
    title: "操作紀錄",
    lead: "操作紀錄：全公司誰改了什麼，可以依人、日期、項目找。",
    allPeople: "全部的人",
    allItems: "全部項目",
    itemLabel: "項目",
    itemLease: "租約",
    itemPayment: "繳款",
    itemUnit: "單位",
    changed: "{who}把{record}的{field}從 {from} 改成 {to}",
    changedQuoted: "{who}把{record}的{field}從「{from}」改成「{to}」",
    reason: "・原因：{reason}",
    itemTime: "{item}・{when}",
    sep: "・",
    next: "下一頁",
    prev: "上一頁",
    noMatch: "找不到符合的紀錄",
    clear: "清除篩選",
    readFailed: "這裡暫時讀不到，請再試一次。",
    retry: "再試一次",
  },
  en: {
    title: "Activity log",
    lead: "Activity log: who changed what across the company. Find it by person, date or item.",
    allPeople: "Everyone",
    allItems: "All items",
    itemLabel: "Item",
    itemLease: "Lease",
    itemPayment: "Payment",
    itemUnit: "Unit",
    changed: "{who} changed the {field} of {record} from {from} to {to}",
    changedQuoted: "{who} changed the {field} of {record} from “{from}” to “{to}”",
    reason: " · Reason: {reason}",
    itemTime: "{item} · {when}",
    sep: " · ",
    next: "Next page",
    prev: "Previous page",
    noMatch: "No matching entries",
    clear: "Clear filters",
    readFailed: "This is temporarily unavailable. Please try again.",
    retry: "Try again",
  },
};
export type AuditV3Copy = (typeof copy)["zh-TW"];
export function brandV3AuditCopy(locale: Locale): AuditV3Copy { return copy[locale]; }

const CJK = /[㐀-鿿豈-﫿]/;
const LATIN = /[A-Za-z0-9$%)]/;
const gap = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && ((CJK.test(a) && LATIN.test(b)) || (LATIN.test(a) && CJK.test(b)));

/**
 * Fills `{name}` placeholders. In zh-TW a space is put where an inserted value meets the template with Chinese on one
 * side and a Latin letter or digit on the other, as the frame writes 「民生 3F 房間 A 的狀態」; the value itself is
 * never changed. EN fills as written.
 */
export function fillAudit(locale: Locale, template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string, offset: number) => {
    if (!(key in values)) return match;
    const value = values[key];
    if (locale !== "zh-TW" || !value) return value;
    const before = template[offset - 1];
    const after = template[offset + match.length];
    return `${gap(before, value[0]) ? " " : ""}${value}${gap(value[value.length - 1], after) ? " " : ""}`;
  });
}
