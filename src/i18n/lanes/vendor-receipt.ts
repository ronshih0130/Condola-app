export type VendorReceiptLocale = "zh-TW" | "en";

export interface VendorReceiptLabels {
  receiptTitle: string;
  completionStatementTitle: string;
  nonTaxVoucherNotice: string;
  previewWatermark: string;
  documentNo: string;
  issueDate: string;
  ticketNo: string;
  buyerCompanyName: string;
  buyerCompanyAddress: string;
  buyerTaxId: string;
  ownerReceiptTitle: string;
  clientLabel: string;
  repairLocation: string;
  itemName: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
  totalAmount: string;
  chineseUppercaseTotal: string;
  vendorBusinessName: string;
  vendorTaxId: string;
  vendorAddress: string;
  vendorPhone: string;
  vendorRepresentative: string;
  workerName: string;
  workerPhone: string;
  sealPosition: string;
  currencyPrefix: string;
  confirmIssueReceipt: string;
  confirmIssueStatement: string;
  lockNotice: string;
  voidedBadge: string;
  voidDownloadNotice: string;
  qualificationStatement: string;
  qualificationLookupHint: string;
  sealClarityHint: string;
  receiptDisclaimer: string;
  completionStatementDisclaimer: string;
}

export interface VendorReceiptErrors {
  nationalIdForbidden: string;
  invalidTaxId: string;
  invalidPhone: string;
  missingBusinessFields: string;
  missingIndividualFields: string;
  qualificationNotAttested: string;
  usingUniformInvoiceNotSupported: string;
  invalidSealFormat: string;
  sealFileTooLarge: string;
  missingRequiredJobFields: string;
  invalidPhotoCount: string;
  missingAfterPhotosOrReason: string;
  invalidPricingMode: string;
  invalidLineItems: string;
  ownerReceiptTitleMissing: string;
  companyBuyerIncomplete: string;
  buyerPiiForbidden: string;
  totalMismatchWithTicketCost: string;
  invalidVoidTransition: string;
  voidReasonRequired: string;
  invalidReissueSource: string;
  invalidDocumentCode: string;
}

export interface VendorReceiptCopyBundle {
  labels: VendorReceiptLabels;
  errors: VendorReceiptErrors;
}

export const VENDOR_RECEIPT_COPY: Record<
  VendorReceiptLocale,
  VendorReceiptCopyBundle
> = {
  "zh-TW": {
    labels: {
      receiptTitle: "免用統一發票收據",
      completionStatementTitle: "維修完工單／費用明細",
      nonTaxVoucherNotice: "本文件非稅務憑證",
      previewWatermark: "預覽，尚未開立",
      documentNo: "文件編號",
      issueDate: "日期",
      ticketNo: "工單編號",
      buyerCompanyName: "買受人名稱",
      buyerCompanyAddress: "買受人地址",
      buyerTaxId: "買受人統編",
      ownerReceiptTitle: "收據抬頭",
      clientLabel: "委託方",
      repairLocation: "維修地點",
      itemName: "品項／服務內容",
      quantity: "數量",
      unit: "單位",
      unitPrice: "單價",
      amount: "金額",
      totalAmount: "合計",
      chineseUppercaseTotal: "國字大寫",
      vendorBusinessName: "廠商名稱",
      vendorTaxId: "統編",
      vendorAddress: "營業地址",
      vendorPhone: "電話",
      vendorRepresentative: "負責人",
      workerName: "施作人員",
      workerPhone: "聯絡電話",
      sealPosition: "電子章位置",
      currencyPrefix: "NT$",
      confirmIssueReceipt: "確認並產生收據",
      confirmIssueStatement: "確認並產生明細",
      lockNotice: "產生後內容將鎖定；如需更正，須作廢後重新開立。",
      voidedBadge: "已作廢",
      voidDownloadNotice: "作廢無法撤回已下載檔案，請以文件頁最新狀態為準。",
      qualificationStatement:
        "我確認本商號為經核定免用統一發票之營業人，以上資料正確，並同意將上傳的電子章用於本商號送出產生的收據。",
      qualificationLookupHint:
        "請至財政部「稅籍登記資料公示查詢」核對商號名稱、統編及相關登記資料；如無法確認免用統一發票資格，請向所屬國稅局確認。統編格式檢查不代表資格確認。",
      sealClarityHint: "請確認章面清晰，能辨識開立廠商。",
      receiptDisclaimer:
        "本收據由上述廠商開立。Condola 只提供管理軟體，不經手任何款項。憑證適用性請依交易事實及相關規定由買受人確認。",
      completionStatementDisclaimer:
        "本文件僅供記錄維修完成情形與費用明細，非稅務憑證。Condola 只提供管理軟體，不經手任何款項。",
    },
    errors: {
      nationalIdForbidden: "系統不收集身分證字號或個人證件編號。",
      invalidTaxId: "請輸入有效的 8 碼統編。",
      invalidPhone: "請輸入有效的台灣電話或手機號碼。",
      missingBusinessFields: "商號名稱、統編、負責人、電話、營業地址與電子章皆為必填。",
      missingIndividualFields: "個人師傅請填寫姓名與聯絡電話。",
      qualificationNotAttested: "請勾選免用統一發票開立資格確認。",
      usingUniformInvoiceNotSupported: "請依適用規定提供統一發票。",
      invalidSealFormat: "電子章僅接受 PNG 或 JPEG 圖片格式。",
      sealFileTooLarge: "電子章檔案大小超過上限。",
      missingRequiredJobFields: "請完整填寫該工種的必填欄位。",
      invalidPhotoCount: "施工階段照片張數不符合工種規定。",
      missingAfterPhotosOrReason: "請上傳處理後照片，或填寫無處理後照片之原因。",
      invalidPricingMode: "不支援此計價方式。",
      invalidLineItems: "品項名稱、數量與 NT$ 整數金額格式不正確。",
      ownerReceiptTitleMissing: "個人屋主尚未填寫收據抬頭，不得以屋主姓名代替。",
      companyBuyerIncomplete: "管理公司買受人需填寫完整公司名稱、地址與 8 碼統編。",
      buyerPiiForbidden: "個人屋主買受人僅能包含收據抬頭，不得包含其他個資。",
      totalMismatchWithTicketCost: "文件合計與工單實際費用不一致，請由管理公司確認。",
      invalidVoidTransition: "僅已開立之有效文件可執行作廢。",
      voidReasonRequired: "作廢時必須填寫原因。",
      invalidReissueSource: "重開文件必須關聯已作廢之原文件。",
      invalidDocumentCode: "廠商識別碼或序號格式無效。",
    },
  },
  en: {
    labels: {
      receiptTitle: "Exempt Uniform Invoice Receipt",
      completionStatementTitle: "Repair Completion Statement / Cost Breakdown",
      nonTaxVoucherNotice: "This document is not a tax voucher",
      previewWatermark: "Preview - Not Yet Issued",
      documentNo: "Document No.",
      issueDate: "Date",
      ticketNo: "Ticket No.",
      buyerCompanyName: "Buyer Company Name",
      buyerCompanyAddress: "Buyer Address",
      buyerTaxId: "Buyer Tax ID",
      ownerReceiptTitle: "Receipt Title",
      clientLabel: "Client",
      repairLocation: "Repair Location",
      itemName: "Service Item",
      quantity: "Qty",
      unit: "Unit",
      unitPrice: "Unit Price",
      amount: "Amount",
      totalAmount: "Total",
      chineseUppercaseTotal: "Amount in Words",
      vendorBusinessName: "Vendor Name",
      vendorTaxId: "Tax ID",
      vendorAddress: "Business Address",
      vendorPhone: "Phone",
      vendorRepresentative: "Representative",
      workerName: "Technician",
      workerPhone: "Contact Phone",
      sealPosition: "E-Seal",
      currencyPrefix: "NT$",
      confirmIssueReceipt: "Confirm and Issue Receipt",
      confirmIssueStatement: "Confirm and Issue Statement",
      lockNotice:
        "Content is locked once issued. To make corrections, void and reissue a new document.",
      voidedBadge: "Voided",
      voidDownloadNotice:
        "Voiding cannot recall previously downloaded files. Refer to the latest status on the document page.",
      qualificationStatement:
        "I confirm this business is approved to use exempt uniform invoice receipts, the above details are accurate, and I authorize applying the uploaded e-seal to issued receipts.",
      qualificationLookupHint:
        "Please verify the business name and Tax ID on the Ministry of Finance tax registration portal. Format validation does not confirm tax qualification.",
      sealClarityHint:
        "Please confirm the seal image is clear and identifies the issuing vendor.",
      receiptDisclaimer:
        "This receipt is issued by the vendor above. Condola provides management software only and never handles funds. Voucher applicability should be confirmed by the buyer.",
      completionStatementDisclaimer:
        "This document records repair completion and cost details only and is not a tax voucher. Condola provides management software only and never handles funds.",
    },
    errors: {
      nationalIdForbidden: "National ID numbers or personal ID documents are not collected.",
      invalidTaxId: "Please enter a valid 8-digit Taiwan Tax ID.",
      invalidPhone: "Please enter a valid Taiwan phone or mobile number.",
      missingBusinessFields:
        "Business name, Tax ID, representative, phone, address, and e-seal are required.",
      missingIndividualFields:
        "Individual technicians must provide a display name and contact phone.",
      qualificationNotAttested:
        "Please confirm exempt uniform invoice qualification.",
      usingUniformInvoiceNotSupported:
        "Please provide a uniform invoice in accordance with applicable regulations.",
      invalidSealFormat: "E-seal must be a valid PNG or JPEG image.",
      sealFileTooLarge: "E-seal file size exceeds the maximum limit.",
      missingRequiredJobFields:
        "Please fill in all required fields for the selected job type.",
      invalidPhotoCount:
        "Photo count for this phase does not meet the job type rules.",
      missingAfterPhotosOrReason:
        "Please upload after-repair photos or provide a reason for missing photos.",
      invalidPricingMode: "Unsupported pricing mode for this job type.",
      invalidLineItems:
        "Line item name, quantity, and integer NT$ amount are invalid.",
      ownerReceiptTitleMissing:
        "Owner receipt title is required and cannot fall back to the owner display name.",
      companyBuyerIncomplete:
        "Company buyer requires company name, address, and a valid 8-digit Tax ID.",
      buyerPiiForbidden:
        "Owner buyer snapshot may only include the receipt title and no personal data.",
      totalMismatchWithTicketCost:
        "Document total does not match the ticket final cost. Management confirmation is required.",
      invalidVoidTransition: "Only issued documents can be voided.",
      voidReasonRequired: "A reason is required to void a document.",
      invalidReissueSource:
        "Reissued documents must reference a voided source document.",
      invalidDocumentCode: "Invalid vendor code or sequence number.",
    },
  },
};

export function getVendorReceiptCopy(
  locale: VendorReceiptLocale = "zh-TW",
): VendorReceiptCopyBundle {
  return VENDOR_RECEIPT_COPY[locale] ?? VENDOR_RECEIPT_COPY["zh-TW"];
}
