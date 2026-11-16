import type { Locale } from "../index";

// B-110 (GS-32 ven-copy-link, share-expired; P52 new words approved by the standing delegation 2026-11-16 ~11:20 PT).
// 「複製唯讀連結」, the scope note, 「複製連結」 and the revoked text are the approved vendor-frontend-1112 words.
const copy = {
  "zh-TW": {
    entry: "複製唯讀連結", title: "這一案的唯讀連結", noSend: "系統不會代你寄出連結。請複製後，自己傳給需要的人。",
    link: "連結", scope: "對方只會看到已准許的照片，以及已開立或已作廢的文件。內部備註不會出現。",
    copy: "複製連結", close: "關閉", copied: "已複製連結",
    readError: "這裡暫時讀不到，請再試一次。", saveError: "沒有存成功，請再試一次。", retry: "再試一次",
    brand: "租多啦", sharedBy: "{company}分享的唯讀頁", status: "狀態", done: "已完成", working: "處理中", vendor: "廠商",
    photos: "已准許的照片", documents: "文件", markReceipt: "收據", markStatement: "完工明細（非稅務憑證）", markVoid: "已作廢",
    receiptTitle: "收據", statementTitle: "完工明細",
    expiredTitle: "這個分享已過期", expiredBody: "這個連結已過期，文件內容不會再顯示。需要的話請聯絡{company}。",
    revokedTitle: "這個分享已撤銷", revokedBody: "管理方已停止這個連結，文件內容不會再顯示。",
  },
  en: {
    entry: "Copy read-only link", title: "Read-only link for this job", noSend: "The system won't send the link for you. Copy it and send it to whoever needs it.",
    link: "Link", scope: "They will only see approved photos and issued or voided documents. Internal notes are never shown.",
    copy: "Copy link", close: "Close", copied: "Link copied",
    readError: "This can't be loaded right now. Please try again.", saveError: "This wasn't saved. Please try again.", retry: "Try again",
    brand: "Condola", sharedBy: "Read-only page shared by {company}", status: "Status", done: "Completed", working: "In progress", vendor: "Vendor",
    photos: "Approved photos", documents: "Documents", markReceipt: "Receipt", markStatement: "Completion statement (not a tax document)", markVoid: "Voided",
    receiptTitle: "Receipt", statementTitle: "Completion statement",
    expiredTitle: "This share has expired", expiredBody: "This link has expired, so the documents are no longer shown. Contact {company} if you need them.",
    revokedTitle: "This share was revoked", revokedBody: "The manager stopped this link, so the documents are no longer shown.",
  },
} as const;
export type CaseShareCopy = (typeof copy)["zh-TW"] | (typeof copy)["en"];
export function caseShareCopy(locale: Locale): CaseShareCopy { return copy[locale]; }
