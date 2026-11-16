import type { Locale } from "../index";

// B-105 Round 7 batch 3 vendor case (screens.md § "Round 7 batch 3"; P52 new words approved by the
// standing delegation, 2026-11-16 ~11:00 PT). zh-TW strings are verbatim from the approved frames.
const copy = {
  "zh-TW": {
    leadAccept: "{company}派了這一件給你，下一步：決定要不要接。",
    badgeAccept: "待接單",
    status: "狀態",
    dueLabel: "約定完工日",
    duePreset: "管理員已填寫約定完工日，接單時看得到、不會被清掉。",
    dueHelp: "過了這天還沒完工，管理方會看到逾期。沒填也可以接單。",
    accept: "接受工單",
    decline: "不接受",
    other: "其他",
    declineTitle: "不接這一件？",
    declineReason: "原因（選填）",
    declineConfirm: "確定不接",
    cancel: "取消",
    declined: "你沒有接這一件，{company}會另外安排。",
    leadWait: "在等屋主核准估價，核准後就可以約時間。",
    badgeWait: "待屋主核准",
    viewEstimate: "看估價（第 {n} 版，待屋主核准）",
    photos: "處理前／後照片",
    photosCrumb: "{job} › 照片",
    before: "處理前",
    after: "處理後",
    uploadBefore: "上傳處理前照片",
    uploadAfter: "上傳處理後照片",
    closedInfo: "這一案已結案，照片不能再改。要補照片，請{company}重開這一案。",
    readError: "這裡暫時讀不到，請再試一次。",
    saveError: "沒有存成功，請再試一次。",
    retry: "再試一次",
  },
  en: {
    leadAccept: "{company} sent you this job. Next: decide whether to take it.",
    badgeAccept: "Waiting for you to accept",
    status: "Status",
    dueLabel: "Agreed completion date",
    duePreset: "The manager set an agreed completion date. You can see it when you accept, and it will not be cleared.",
    dueHelp: "If the job is not finished by this date, the manager will see it as overdue. You can accept without a date.",
    accept: "Accept job",
    decline: "Decline",
    other: "More",
    declineTitle: "Decline this job?",
    declineReason: "Reason (optional)",
    declineConfirm: "Decline job",
    cancel: "Cancel",
    declined: "You declined this job. {company} will arrange someone else.",
    leadWait: "Waiting for the owner to approve the estimate. You can schedule the visit after approval.",
    badgeWait: "Waiting for owner approval",
    viewEstimate: "View estimate (version {n}, waiting for owner approval)",
    photos: "Before and after photos",
    photosCrumb: "{job} › Photos",
    before: "Before",
    after: "After",
    uploadBefore: "Upload before photo",
    uploadAfter: "Upload after photo",
    closedInfo: "This job is closed, so its photos can no longer change. To add photos, ask {company} to reopen this job.",
    readError: "This can't be loaded right now. Please try again.",
    saveError: "This wasn't saved. Please try again.",
    retry: "Try again",
  },
} as const;

export type VendorCaseCopy = (typeof copy)["zh-TW"] | (typeof copy)["en"];
export function vendorCaseCopy(locale: Locale): VendorCaseCopy {
  return copy[locale];
}
