const strings = {
  en: {
    title: "Paper-signed lease PDFs",
    current: "Current version",
    historical: "Previous version",
    uploaded: "Uploaded",
    view: "View PDF",
    download: "Download PDF",
    notice: "These are copies of your paper-signed lease. Viewing or downloading does not sign a lease. Your browser may download the PDF before opening it.",
  },
  "zh-TW": {
    title: "紙本簽署租約 PDF",
    current: "目前版本",
    historical: "歷史版本",
    uploaded: "上傳時間",
    view: "查看 PDF",
    download: "下載 PDF",
    notice: "這些是您紙本簽署租約的副本。查看或下載不代表簽署租約。瀏覽器可能會先下載 PDF 再開啟。",
  },
} as const;

export function tenantSignedPdfStrings(locale: string) {
  return locale === "zh-TW" ? strings["zh-TW"] : strings.en;
}
