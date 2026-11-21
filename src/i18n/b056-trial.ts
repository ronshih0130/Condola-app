// zh-TW strings are verbatim from mockup b73680e / B-056 ACs; en strings are translations of those.
export type B056TrialCopy = {
  btn_trial_pro: string;
  btn_trial_std: string;
  note_admin: string;
  note_non_admin: string;
  confirm_title_pro: string;
  confirm_title_std: string;
  confirm_body_pro: (date: string) => string;
  confirm_body_std: (date: string) => string;
  cancel: string;
  confirm: string;
  plan_trial_pro: (date: string) => string;
  plan_trial_std: (date: string) => string;
  days_left: (days: number) => string;
  banner_pro: (days: number, date: string) => string;
  banner_std: (days: number, date: string) => string;
  apply_cta: string;
  dismiss_label: string;
};

const zhTW: B056TrialCopy = {
  btn_trial_pro: "免費試用進階方案 6 個月",
  btn_trial_std: "免費試用標準方案 3 個月",
  note_admin: "只有公司管理員能開始試用，每家公司限試用一次（標準或進階擇一）。",
  note_non_admin: "請公司管理員開始試用",
  confirm_title_pro: "開始進階方案免費試用？",
  confirm_title_std: "開始標準方案免費試用？",
  confirm_body_pro: (date) => `試用 6 個月，到 ${date} 結束，期間不收費。開始後就不能再試用標準。到期後自動回到免費方案，資料都會保留；依生效租約起始日最早的 5 戶仍可編輯，其餘改為唯讀。多出來的管理者帳號會保留，但後台權限暫停，升級後恢復；租客端完全不受影響。`,
  confirm_body_std: (date) => `試用 3 個月，到 ${date} 結束，期間不收費。開始後就不能再試用進階。到期後自動回到免費方案，資料都會保留；依生效租約起始日最早的 5 戶仍可編輯，其餘改為唯讀。多出來的管理者帳號會保留，但後台權限暫停，升級後恢復；租客端完全不受影響。`,
  cancel: "取消",
  confirm: "開始試用",
  plan_trial_pro: (date) => `目前方案：進階（免費試用中，到 ${date}）`,
  plan_trial_std: (date) => `目前方案：標準（免費試用中，到 ${date}）`,
  days_left: (days) => `試用還有 ${days} 天`,
  banner_pro: (days, date) => `進階試用將在 ${days} 天後（${date}）結束。結束後超過 5 戶的部分會改為唯讀。`,
  banner_std: (days, date) => `標準試用將在 ${days} 天後（${date}）結束。結束後超過 5 戶的部分會改為唯讀。`,
  apply_cta: "申請付費方案",
  dismiss_label: "關閉提醒",
};

const en: B056TrialCopy = {
  btn_trial_pro: "Try Premium free for 6 months",
  btn_trial_std: "Try Standard free for 3 months",
  note_admin: "Only a company admin can start a trial. Each company can try either Standard or Premium once.",
  note_non_admin: "Ask your company admin to start a trial",
  confirm_title_pro: "Start your free Premium trial?",
  confirm_title_std: "Start your free Standard trial?",
  confirm_body_pro: (date) => `Try Premium for 6 months, ending on ${date}, at no charge. Once started, you cannot try Standard. When the trial ends, you automatically return to the Free plan and all data is retained. The 5 units with the earliest active lease start dates remain editable; the rest become read-only. Additional manager accounts are retained, but their admin-console access is paused until you upgrade. Tenant access is completely unaffected.`,
  confirm_body_std: (date) => `Try Standard for 3 months, ending on ${date}, at no charge. Once started, you cannot try Premium. When the trial ends, you automatically return to the Free plan and all data is retained. The 5 units with the earliest active lease start dates remain editable; the rest become read-only. Additional manager accounts are retained, but their admin-console access is paused until you upgrade. Tenant access is completely unaffected.`,
  cancel: "Cancel",
  confirm: "Start trial",
  plan_trial_pro: (date) => `Current plan: Premium (free trial until ${date})`,
  plan_trial_std: (date) => `Current plan: Standard (free trial until ${date})`,
  days_left: (days) => `${days} days left in your trial`,
  banner_pro: (days, date) => `Your Premium trial ends in ${days} days (${date}). After it ends, units beyond the first 5 become read-only.`,
  banner_std: (days, date) => `Your Standard trial ends in ${days} days (${date}). After it ends, units beyond the first 5 become read-only.`,
  apply_cta: "Apply for a paid plan",
  dismiss_label: "Dismiss reminder",
};

export function b056TrialCopy(locale: string): B056TrialCopy {
  return locale === "en" ? en : zhTW;
}
