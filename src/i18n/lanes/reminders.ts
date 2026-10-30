import type { Locale } from "../index";
const copy={
  "zh-TW":{title:"租金提醒",scope:"此功能目前僅建立本地測試記錄，尚未傳送訊息。",queue:"建立測試提醒",retry:"重試本地處理",queued:"等待處理",claimed:"處理中",captured:"已記錄測試",failed:"處理失敗",unavailable:"無法建立提醒，請確認帳單和通知設定。",empty:"目前沒有符合條件的帳單。",back:"返回租金總覽",tenantTitle:"到期前提醒設定",tenantDescription:"選擇是否接收帳單到期前的電子郵件提醒。此設定不會更改逾期提醒。",tenantOn:"到期前提醒：開啟",tenantOff:"到期前提醒：關閉",turnOn:"開啟提醒",turnOff:"關閉提醒",saved:"設定已儲存。",tenantBack:"返回首頁"},
  en:{title:"Rent reminder",scope:"This creates a local test record only. No message has been sent.",queue:"Create test reminder",retry:"Retry local capture",queued:"Queued",claimed:"In progress",captured:"Test recorded",failed:"Failed",unavailable:"The reminder could not be created. Check the bill and notification settings.",empty:"There are no eligible bills.",back:"Back to rent overview",tenantTitle:"Due reminder preference",tenantDescription:"Choose whether to receive email reminders before a bill is due. This does not change overdue reminders.",tenantOn:"Due reminders: on",tenantOff:"Due reminders: off",turnOn:"Turn reminders on",turnOff:"Turn reminders off",saved:"Preference saved.",tenantBack:"Back to home"},
} as const;
export function reminderCopy(locale:Locale) { return copy[locale]; }
export const paymentRequestCopy = {
  "zh-TW": { checking: "正在確認上次記錄…", recorded: "上次的付款已記錄。", unknown: "若上次結果尚未確認，請使用相同資料重試。", unavailable: "目前無法確認付款記錄，請稍後再試。", newPayment: "記錄另一筆付款" },
  en: { checking: "Checking the previous record…", recorded: "The previous payment was recorded.", unknown: "If the previous result is unknown, retry with the same details.", unavailable: "The payment record cannot be checked now. Please try again later.", newPayment: "Record another payment" },
} as const;
