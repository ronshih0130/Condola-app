import type { MonthlyRentUnsupportedReason } from '@/server/monthly-rent-operation-plan';

const copy = {
  en: {
    title: 'Monthly rent detail', back: 'Back to rent', unavailable: 'Preview unavailable.',
    unsupported: 'This rent source needs review before it can be shown as a supported monthly amount.',
    asOf: 'Snapshot as of', property: 'Property', billTo: 'Bill-to', currency: 'Currency',
    rent: 'Monthly rent', period: 'Service period', due: 'Due date', rentOnly: 'Rent only',
    exclusions: 'Deposits, utilities, and other fees are excluded.',
    snapshot: 'This is a snapshot for review, not a reservation or a complete bill.',
    reasons: {
      period_out_of_range: 'This month is outside the supported date range.',
      source_cap: 'Too many source records are available to review this lease completely.',
      inactive_lease: 'The lease is not active for this review.',
      invalid_source: 'Some required source information is unavailable or inconsistent.',
      invalid_date: 'A lease date is invalid.',
      unsupported_frequency: 'This rent frequency is not supported for monthly review.',
      date_conflict: 'The lease dates conflict.',
      partial_or_moveout: 'The lease covers only part of this month or records a move-out.',
      invalid_currency_config: 'The currency display settings are unavailable or invalid.',
      invalid_rent: 'The stored rent amount is invalid.',
      historical_period_unknown: 'An existing rent record has no known service period.',
      coverage_conflict: 'Existing rent records overlap or conflict with this month.',
      existing_rent: 'A rent record already exists for this service period.',
      due_day_unavailable: 'A due date cannot be determined for this month.',
      zero_rent: 'The stored rent amount is zero.',
      payer_missing: 'No bill-to contact is assigned to this lease.',
      payer_ambiguous: 'More than one bill-to contact is assigned to this lease.',
      payer_unusable: 'The bill-to contact is unavailable for this review.',
    } satisfies Record<MonthlyRentUnsupportedReason, string>,
  },
  'zh-TW': {
    title: '每月租金明細', back: '返回租金頁面', unavailable: '目前無法使用預覽。',
    unsupported: '此租金來源需要核對，才能作為每月租金顯示。',
    asOf: '資料快照時間', property: '物件', billTo: '帳單對象', currency: '幣別',
    rent: '每月租金', period: '服務期間', due: '繳費日', rentOnly: '僅列租金',
    exclusions: '不包含押金、水電及其他費用。',
    snapshot: '此資料為供核對的快照，不是預留或完整帳單。',
    reasons: {
      period_out_of_range: '此月份超出支援的日期範圍。',
      source_cap: '來源資料筆數過多，無法完整核對此租約。',
      inactive_lease: '此租約目前不適用於本次核對。',
      invalid_source: '部分必要來源資料無法使用或彼此不一致。',
      invalid_date: '租約日期無效。',
      unsupported_frequency: '此租金週期尚未支援每月核對。',
      date_conflict: '租約日期彼此衝突。',
      partial_or_moveout: '租約只涵蓋本月部分期間或記錄了搬離日期。',
      invalid_currency_config: '幣別顯示設定無法使用或無效。',
      invalid_rent: '已儲存的租金金額無效。',
      historical_period_unknown: '既有租金紀錄沒有可確認的服務期間。',
      coverage_conflict: '既有租金紀錄與本月期間重疊或衝突。',
      existing_rent: '此服務期間已有租金紀錄。',
      due_day_unavailable: '無法確定本月繳費日。',
      zero_rent: '已儲存的租金金額為零。',
      payer_missing: '此租約沒有指定帳單對象。',
      payer_ambiguous: '此租約指定了多位帳單對象。',
      payer_unusable: '此帳單對象目前無法供本次核對使用。',
    } satisfies Record<MonthlyRentUnsupportedReason, string>,
  },
} as const;

export function monthlyRentCopy(locale: string) {
  return locale === 'zh-TW' ? copy['zh-TW'] : copy.en;
}
