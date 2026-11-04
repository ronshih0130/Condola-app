const messages = {
  "zh-TW": {
    title: "紙本簽署租約",
    hint: "上傳紙本簽署的 PDF，作為電子簽署的替代方式。歷史版本會保留供團隊下載。",
    current: "現行有效",
    currentLegacy: "最新上傳（未連結租約文件）",
    history: "歷史版本",
    uploadedAt: "上傳時間",
    uploader: "上傳者",
    unknownUploader: "未記錄",
    unavailable: "無法顯示",
    reason: "替換原因",
    reasonHint: "替換現有版本時請從清單選擇一個原因代碼。",
    reasonInvalid: "請選擇一個替換原因。",
    reasonChoose: "請選擇",
    reasons: {
      corrected_signature: "更正簽名",
      wrong_file: "檔案錯誤",
      illegible_scan: "掃描無法辨識",
      other: "其他",
    },
    noReason: "未記錄原因",
    pdf: "簽署 PDF",
    upload: "上傳簽署 PDF",
  },
  en: {
    title: "Paper-signed lease",
    hint: "Upload a paper-signed PDF as a fallback for electronic signing. Previous versions remain available for team download.",
    current: "Current valid version",
    currentLegacy: "Latest upload (not linked to lease document)",
    history: "Previous version",
    uploadedAt: "Uploaded at",
    uploader: "Uploaded by",
    unknownUploader: "Not recorded",
    unavailable: "Unavailable",
    reason: "Replacement reason",
    reasonHint: "Choose one reason code when replacing an existing version.",
    reasonInvalid: "Choose a replacement reason.",
    reasonChoose: "Choose one",
    reasons: {
      corrected_signature: "Corrected signature",
      wrong_file: "Wrong file",
      illegible_scan: "Illegible scan",
      other: "Other",
    },
    noReason: "No reason recorded",
    pdf: "Signed PDF",
    upload: "Upload signed PDF",
  },
};

export function paperLeaseCopy(locale: string) {
  return locale === "zh-TW" ? messages["zh-TW"] : messages.en;
}

/** Localized label for a stored code. Unknown text is not shown. */
export function paperLeaseReasonLabel(locale: string, code: string | null): string | null {
  if (!code) return null;
  const reasons = paperLeaseCopy(locale).reasons as Record<string, string>;
  return reasons[code] ?? null;
}
