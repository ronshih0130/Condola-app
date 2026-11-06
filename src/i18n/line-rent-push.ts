import type { Locale } from ".";

export type RentPushKind = "rent_due" | "rent_overdue" | "payment_confirmed" | "payment_rejected";
export type RentPushCopyInput = { company: string; amount: string; dueDate: string | null; url: string };

/** B-037 LINE push copy. Reminder text plus the tenant LIFF deep link only.
 * Condola only shows bills and records; payment happens between tenant and company. */
export function lineRentPushText(kind: RentPushKind, locale: Locale, input: RentPushCopyInput) {
 const { company, amount, dueDate, url } = input;
 if (locale === "en") {
  switch (kind) {
   case "rent_due": return `[${company}] Rent reminder: ${amount} is due on ${dueDate}. View the bill and transfer details: ${url}`;
   case "rent_overdue": return `[${company}] Your rent of ${amount} was due on ${dueDate}. If you have already transferred it, please ignore this message. View the bill: ${url}`;
   case "payment_confirmed": return `[${company}] Your reported payment of ${amount} has been reconciled and confirmed. View your records: ${url}`;
   case "payment_rejected": return `[${company}] Your reported payment of ${amount} could not be reconciled. Open the link for details and contact the management company: ${url}`;
  }
 }
 switch (kind) {
  case "rent_due": return `【${company}】租金提醒：本期租金 ${amount}，應繳日為 ${dueDate}。查看帳單與匯款資訊：${url}`;
  case "rent_overdue": return `【${company}】本期租金 ${amount} 已超過應繳日 ${dueDate}。如已匯款請忽略此訊息。查看帳單：${url}`;
  case "payment_confirmed": return `【${company}】您回報的繳款 ${amount} 已完成對帳確認。查看紀錄：${url}`;
  case "payment_rejected": return `【${company}】您回報的繳款 ${amount} 未能完成對帳，請開啟連結查看說明並與管理公司聯繫：${url}`;
 }
}

/** Provider acceptance is shown as sent only; LINE delivery/read is never claimed. */
export function lineRentPushStatusLabel(status: "sent" | "email_fallback" | "queued" | "suppressed", locale: Locale) {
 const labels = locale === "en"
  ? { sent: "Sent", email_fallback: "Sent by Email instead", queued: "Queued", suppressed: "Not sent (no longer applicable)" }
  : { sent: "已送出", email_fallback: "改以 Email 通知", queued: "等待送出", suppressed: "未送出（已不適用）" };
 return labels[status];
}
