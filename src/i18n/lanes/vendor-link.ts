import type { Locale } from "../index";

const copy = {
  "zh-TW": {
    waiting: "等待公司分享工作內容。",
    review: "確認分享內容",
    guidance: "請填寫可分享的工作說明，並逐張確認照片。不應包含證件或屋主個資。",
    description: "提供給廠商的工作說明",
    photos: "選擇可分享的照片",
    approve: "確認並分享",
    approved: "已確認分享內容。再次送出將取代先前分享的說明與照片。",
  },
  en: {
    waiting: "Waiting for the company to share work details.",
    review: "Review sharing",
    guidance: "Write a redacted work description and review each photo. Exclude identity documents and owner personal information.",
    description: "Work description for the vendor",
    photos: "Select photos to share",
    approve: "Approve and share",
    approved: "Sharing approved. Submitting again replaces the shared description and selected photos.",
  },
} as const;

export function vendorLinkCopy(locale: Locale) {
  return copy[locale];
}
