/** The profile describes the management firm, never the Condola platform. */
export function companyProfileCopy(locale: string) {
  return locale === 'zh-TW' ? {
    title: '管理公司資料', identifier: '地區識別資料',
    stale: '資料已變更，請重新確認後儲存。', unavailable: '無法確認結果，請重新載入並檢查資料。', invalid: '請檢查填寫的資料。',
  } : {
    title: 'Management firm profile', identifier: 'Regional identifier',
    stale: 'The profile changed. Review it before saving again.', unavailable: 'The result could not be confirmed. Reload and check the profile.', invalid: 'Check the profile fields.',
  };
}
