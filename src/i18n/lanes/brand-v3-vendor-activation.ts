import type { Locale } from "../index";

// B-065 (VEN-17, VEN-18; GS-31): the approved 3.0 words of 我的帳號 › 開立類型 and 印章 (Round 7 batches 3–4; titles and
// descriptions are the approved issuer-types.md / vendor-frontend-1112 words).
const copy = {
  "zh-TW": {
    fixed: "固定資料", row: "開立類型", rowNote: "更改類型不會改已開出的舊 PDF。", manageStamp: "管理印章",
    title: "開立類型", crumb: "我的帳號 › 開立類型", question: "你要開哪一種文件？",
    types: {
      individual: { title: "個人（非營業人）師傅", desc: "你還沒辦稅籍、不是營業人，系統幫你開簽收單或完工明細，上面會標示「本文件非稅務憑證」。" },
      exempt_business: { title: "免用統一發票之營業人", desc: "你已辦稅籍、依規定免開統一發票，系統可以幫你開普通收據，也可以讓你上傳自己開的紙本收據。" },
      invoice_business: { title: "使用統一發票之營業人", desc: "你依法要自己開統一發票，系統不幫你開，只接受你上傳；需要時可另存完工明細給你對帳。" },
    },
    selfDeclared: "類型由你自己聲明，管理公司不會代你勾選。我們不收身分證。",
    save: "儲存", cancel: "取消", saveError: "沒有存成功，請再試一次。", retry: "再試一次",
    stampTitle: "印章", stampCard: "收據印章", noStamp: "還沒有印章，開第一張收據前會先請你預覽並同意。",
  },
  en: {
    fixed: "Fixed details", row: "Issuer type", rowNote: "Changing the type does not change PDFs already issued.", manageStamp: "Manage stamp",
    title: "Issuer type", crumb: "My account › Issuer type", question: "Which documents do you issue?",
    types: {
      individual: { title: "Individual (non-business) tradesperson", desc: "You are not tax-registered as a business. The system issues sign-off receipts or completion statements marked as not tax documents." },
      exempt_business: { title: "Business exempt from uniform invoices", desc: "You are tax-registered and exempt from uniform invoices. The system can issue ordinary receipts, and you can upload your own paper receipts." },
      invoice_business: { title: "Business using uniform invoices", desc: "You must issue your own uniform invoices. The system does not issue them and only accepts your uploads; it can keep a completion statement for reconciliation." },
    },
    selfDeclared: "You declare the type yourself; the management company never ticks it for you. We do not collect ID cards.",
    save: "Save", cancel: "Cancel", saveError: "This wasn't saved. Please try again.", retry: "Try again",
    stampTitle: "Stamp", stampCard: "Receipt stamp", noStamp: "No stamp yet. Before your first receipt you'll preview it and agree to it.",
  },
} as const;
export type VendorActivationCopy = (typeof copy)["zh-TW"] | (typeof copy)["en"];
export function vendorActivationCopy(locale: Locale): VendorActivationCopy { return copy[locale]; }
