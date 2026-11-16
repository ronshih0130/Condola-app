import type { Locale } from "../index";

// ADV-METER (Round 7 batch 4, GS-53 = A; MGT-90-AC4…AC6), 物件 › 進階設定 › 公用電表. zh-TW is verbatim from the
// approved frame 「物件・進階設定・公用電表（GS-53）」 and its new-word list (standing delegation): lead, 分給哪幾間,
// 怎麼分, 平均分, 依住的天數分, 依分表度數, 起始度數 + help, 每度電價, 公用電表已儲存, 請至少選一間。, 請填起始度數。;
// 「分給 {n} 間」 and the next-period note are the frame/row; 「在金流設定的「電費規則」」 is batch 3 create-flows;
// 「未設定不影響建立單位或邀請租客。」 is create-flows adv-settings; save error is GS-02. EN is a translation.
const copy = {
  "zh-TW": {
    title: "公用電表", lead: "樓梯、走廊這類大家一起用的電，每期度數依這裡的設定分給各間。",
    rooms: "分給哪幾間", count: "分給 {n} 間", method: "怎麼分",
    methods: { even: "平均分", days_occupied: "依住的天數分", sub_meter: "依分表度數" },
    start: "起始度數", startHelp: "第一次抄表時的上期度數，之後每期自動接上。",
    price: "每度電價", priceWhere: "在金流設定的「電費規則」",
    note: "下一期起（{m} 月帳單）生效，不改已開出的帳單。",
    save: "儲存", cancel: "取消", saved: "公用電表已儲存",
    errRooms: "請至少選一間。", errStart: "請填起始度數。",
    saveFailed: "沒有存成功，請再試一次。", retry: "再試一次",
    aside: "未設定不影響建立單位或邀請租客。",
  },
  en: {
    title: "Shared meter", lead: "Electricity everyone uses, such as stairs and hallways. Each period's usage is split between units as set here.",
    rooms: "Which units share it", count: "Shared by {n}", method: "How to split",
    methods: { even: "Split evenly", days_occupied: "By days occupied", sub_meter: "By sub-meter readings" },
    start: "Starting reading", startHelp: "The previous reading at the first meter reading. Later periods continue from it automatically.",
    price: "Price per kWh", priceWhere: "In the money-flow settings under “Electricity rule”",
    note: "Takes effect from the next period ({m} bill). Bills already issued don't change.",
    save: "Save", cancel: "Cancel", saved: "Shared meter saved",
    errRooms: "Select at least one.", errStart: "Enter the starting reading.",
    saveFailed: "Could not save. Please try again.", retry: "Try again",
    aside: "Leaving this unset doesn't affect creating units or inviting tenants.",
  },
};
export type SharedMeterCopy = (typeof copy)["zh-TW"];
export const sharedMeterCopy = (locale: Locale): SharedMeterCopy => copy[locale];
/** The note's month: 「12」 in zh-TW, 「December」 in en, from the next effective date (YYYY-MM-01). */
export function noteMonth(effectiveFrom: string, locale: Locale): string {
  const month = Number(effectiveFrom.slice(5, 7));
  return locale === "zh-TW" ? String(month) : new Date(Date.UTC(2000, month - 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" });
}
