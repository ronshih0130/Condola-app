import type { Locale } from "../index";

// Round 7 batch 4 GS-32 (screens.md § "Round 7 batch 4"; P52 new words approved by the standing delegation,
// 2026-11-16 ~11:20 PT; GS-57/GS-58 words approved by Ron 2026-11-16 ~15:15 PT, 「都照建議」). Other zh-TW strings are the approved vendor-frontend-1112 words, verbatim.
const copy = {
  "zh-TW": {
    // rec-type1-preview
    previewTitle: "預覽簽收單", previewHeading: "簽收單／完工明細預覽", notTax: "本文件非稅務憑證",
    markStatement: "完工明細（非稅務憑證）", previewNote: "這是預覽，還沒開立，因此還沒有編號。",
    issuer: "開立人", buyer: "買受人", amount: "金額", number: "編號", noNumber: "（預覽不占號）",
    signLine: "開立人：{name}（簽收單不蓋章）",
    withholding: "若付款方是公司：扣繳與列單是公司在系統外的義務，系統不代為處理，也不開扣繳憑單。我們不收、不印身分證。",
    issue: "確認已全額收款並開立", close: "關閉",
    // rec-issued with paper receipts, rec-paper-upload
    receiptTitle: "普通收據", receiptCrumb: "{job} › 收據", evidence: "已關聯的證據", markReceipt: "收據", billedTo: "開給",
    paperCard: "紙本收據", paperEntry: "上傳紙本收據", paperCrumb: "{job} › 上傳紙本收據",
    paperSibling: "紙本收據會和電子收據 {number} 放在一起，不會取代它，也不會多算一筆費用。",
    paperZone: "點這裡上傳收據照片或 PDF", paperFile: "檔案 {name}", upload: "上傳", cancel: "取消", paperDone: "已上傳紙本收據",
    // DOC-VOID (m-docs)
    documents: "文件", markVoid: "已作廢", statementTitle: "完工明細",
    // GS-02
    saveError: "沒有存成功，請再試一次。", retry: "再試一次",
  },
  en: {
    previewTitle: "Preview sign-off receipt", previewHeading: "Sign-off receipt / completion statement preview", notTax: "This document is not a tax document",
    markStatement: "Completion statement (not a tax document)", previewNote: "This is a preview. It has not been issued yet, so it has no number.",
    issuer: "Issued by", buyer: "Buyer", amount: "Amount", number: "Number", noNumber: "(A preview takes no number)",
    signLine: "Issued by: {name} (sign-off receipts carry no stamp)",
    withholding: "If the payer is a company, withholding and reporting are the company's obligations outside this system. The system does not handle them or issue withholding statements. We do not collect or print ID cards.",
    issue: "Confirm full payment received and issue", close: "Close",
    receiptTitle: "Ordinary receipt", receiptCrumb: "{job} › Receipt", evidence: "Linked evidence", markReceipt: "Receipt", billedTo: "Billed to",
    paperCard: "Paper receipt", paperEntry: "Upload paper receipt", paperCrumb: "{job} › Upload paper receipt",
    paperSibling: "The paper receipt is kept with e-receipt {number}. It does not replace it or add another charge.",
    paperZone: "Tap here to upload a photo or PDF of the receipt", paperFile: "File {name}", upload: "Upload", cancel: "Cancel", paperDone: "Paper receipt uploaded",
    documents: "Documents", markVoid: "Voided", statementTitle: "Completion statement",
    saveError: "This wasn't saved. Please try again.", retry: "Try again",
  },
} as const;
export type VendorDocsCopy = (typeof copy)["zh-TW"] | (typeof copy)["en"];
export function vendorDocsCopy(locale: Locale): VendorDocsCopy { return copy[locale]; }
