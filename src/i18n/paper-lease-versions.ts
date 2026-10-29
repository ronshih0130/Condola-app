const messages = {
  "zh-TW": {
    title: "紙本簽署租約",
    hint: "上傳紙本簽署的 PDF，作為電子簽署的替代方式。歷史版本會保留供團隊下載。",
    current: "現行有效",
    history: "歷史版本",
    uploadedAt: "上傳時間",
    uploader: "上傳者",
    unknownUploader: "未記錄",
    reason: "替換原因",
    reasonHint: "替換現有版本時必填，去除前後空白後須為 1–500 字。",
    reasonInvalid: "請輸入替換原因，去除前後空白後須為 1–500 字。",
    noReason: "未記錄原因",
    pdf: "簽署 PDF",
    upload: "上傳簽署 PDF",
  },
  en: {
    title: "Paper-signed lease",
    hint: "Upload a paper-signed PDF as a fallback for electronic signing. Previous versions remain available for team download.",
    current: "Current valid version",
    history: "Previous version",
    uploadedAt: "Uploaded at",
    uploader: "Uploaded by",
    unknownUploader: "Not recorded",
    reason: "Replacement reason",
    reasonHint: "Required when replacing an existing version; 1–500 characters after trimming.",
    reasonInvalid: "Enter a replacement reason of 1–500 characters after trimming.",
    noReason: "No reason recorded",
    pdf: "Signed PDF",
    upload: "Upload signed PDF",
  },
};

export function paperLeaseCopy(locale: string) {
  return locale === "zh-TW" ? messages["zh-TW"] : messages.en;
}
