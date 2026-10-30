import type { Locale } from "../index";
import type { CenterKind } from "@/server/notification-center";
const words = {
  "zh-TW": {title:"通知", empty:"目前沒有通知。", read:"已讀", unread:"未讀", mark:"標記已讀", next:"下一頁", busy:"通知暫時無法顯示，請稍後再試。", retry:"重試", scope:"目前僅顯示此功能支援的通知。", kinds:{rent_due:"帳單到期提醒",rent_overdue:"帳單逾期提醒",rent_manual:"帳單提醒",payment_confirmed:"付款紀錄已確認",payment_rejected:"付款回報已退回",payment_reversed:"付款紀錄已撤銷",vendor_job_assigned:"維修案件更新"}},
  en: {title:"Notifications", empty:"There are no notifications.", read:"Read", unread:"Unread", mark:"Mark as read", next:"Next page", busy:"Notifications are temporarily unavailable. Please try again.", retry:"Try again", scope:"Only notifications supported by this feature appear here.", kinds:{rent_due:"Bill due reminder",rent_overdue:"Overdue bill reminder",rent_manual:"Bill reminder",payment_confirmed:"Payment record confirmed",payment_rejected:"Payment report returned",payment_reversed:"Payment record reversed",vendor_job_assigned:"Repair job update"}},
} satisfies Record<Locale,{title:string;empty:string;read:string;unread:string;mark:string;next:string;busy:string;retry:string;scope:string;kinds:Record<CenterKind,string>}>;
export function centerCopy(locale:Locale){return words[locale];}
