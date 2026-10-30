import type { Locale } from "../index";
const words={
 "zh-TW":{contact:"聯絡資料",noLease:"尚未連結租約",more:"其他租約",empty:"目前沒有符合的租客。",unavailable:"目前無法顯示租客名錄，請重新整理。",retry:"重新整理",noContact:"未提供聯絡資料"},
 en:{contact:"Contact details",noLease:"No linked leases",more:"other leases",empty:"No tenants match this view.",unavailable:"The tenant directory is unavailable. Please refresh.",retry:"Refresh",noContact:"No contact details provided"},
} satisfies Record<Locale,{contact:string;noLease:string;more:string;empty:string;unavailable:string;retry:string;noContact:string}>;
export function directoryCopy(locale:Locale){return words[locale];}
