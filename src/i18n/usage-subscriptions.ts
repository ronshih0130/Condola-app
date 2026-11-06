export function usageSubscriptionCopy(locale: string) {
  return locale === 'zh-TW'
    ? { pricingNotConfigured: '尚未設定價格', limitsNotConfigured: '尚未設定用量上限' }
    : { pricingNotConfigured: 'Pricing not configured', limitsNotConfigured: 'Usage limits not configured' };
}
