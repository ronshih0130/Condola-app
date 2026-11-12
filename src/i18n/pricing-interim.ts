// FILE: src/i18n/pricing-interim.ts
//
// Condola B-045 — Interim pricing / plan-application / usage copy.
// Stories: PLT-26, PLT-27, PLT-28, PLT-29, PLT-30, MGT-53.
// Amendments C1 / C2 / C3 applied (see b045b-amendments.md).
//
// Static, approved copy for the FLAG-ON pricing UI only. The flag-OFF path
// keeps the old copy in the existing i18n JSON — do NOT touch those keys.
// zh-TW strings here are the approved wording (amendments already folded in);
// English is a faithful rendering using plan names Free / Standard / Premium.
//
// Calculator result helpers are exposed as functions so the UI can supply
// computed unit / month / year figures.

export type PricingInterimCopy = {
  pricing: {
    // header
    title: string;
    lead: string;
    sub: string;
    // billing cycle toggles
    cycle_month: string;
    cycle_year: string;
    // plan names
    plan_free: string;
    plan_std: string;
    plan_pre: string;
    badge_rec: string;
    // free plan card
    free_price: string;
    free_period: string;
    free_fit: string;
    // paid plan prices
    std_price_month: string;
    pre_price_month: string;
    period_month: string;
    period_year: string;
    std_year_line: string;
    pre_year_line: string;
    std_year_equiv: string;
    pre_year_equiv: string;
    std_fit: string;
    pre_fit: string;
    // admins per plan
    admins_free: string;
    admins_std: string;
    admins_pre: string;
    // CTAs
    cta_free: string;
    cta_trial_std: string;
    cta_trial_pre: string;
    cta_contact_secondary: string;
    trial_manual_note: string;
    // formula + calculator
    formula: string;
    calc_title: string;
    calc_units: string;
    calc_result_std: (n: number, m: number | string, y: number | string) => string;
    calc_result_pre: (n: number, m: number | string, y: number | string) => string;
    calc_note: string;
    calc_err: string;
    // comparison table
    compare_title: string;
    row_month_price: string;
    row_year: string;
    year_free_cell: string;
    year_std_cell: string;
    year_pre_cell: string;
    row_billing: string;
    billing_free: string;
    billing_paid: string;
    row_unit_def: string;
    unit_def: string;
    same: string;
    row_admins: string;
    row_trial: string;
    trial_free_cell: string;
    trial_std_cell: string;
    trial_pre_cell: string;
    // shared features section
    feat_sec: string;
    feat_lease: string;
    feat_pay: string;
    feat_repair: string;
    feat_owner: string;
    feat_line: string;
    feat_esign: string;
    feat_kpi: string;
    feat_billing: string;
    feat_yes: string;
    // metered quotas (not finalized)
    meter_esign: string;
    meter_notice: string;
    meter_msg: string;
    meter_ai: string;
    pending: string;
    after_table: string;
    // FAQ
    faq_unit_q: string;
    faq_unit_a: string;
    faq_bill_q: string;
    faq_bill_a: string;
    faq_year_q: string;
    faq_year_a: string;
    faq_start_q: string;
    faq_start_a: string;
    faq_sample_q: string;
    faq_sample_a: string;
    faq_admins_q: string;
    faq_admins_a: string;
    faq_invoice_q: string;
    faq_invoice_a: string;
    faq_partner_q: string;
    faq_partner_a: string;
    faq_activate_q: string;
    faq_activate_a: string;
    // footer
    footer_cta: string;
    legal: string;
    mailto: string;
  };
  apply: {
    title: string;
    lead: string;
    label_company: string;
    label_phone: string;
    label_units: string;
    required: string;
    hint_units: string;
    plan_label: string;
    plan_std: string;
    plan_pre: string;
    plan_unsure: string;
    note_label: string;
    foot: string;
    cta: string;
    err_company: string;
    err_phone: string;
    err_units: string;
    success_title: string;
    success_body: string;
    success_note: string;
    back: string;
  };
  usage: {
    usage_title: string;
    plan_free: string;
    plan_std: string;
    plan_pre: string;
    units_label: string;
    units_free: (n: number) => string;
    units_paid: (n: number) => string;
    meter_esign: string;
    meter_notice: string;
    meter_msg: string;
    meter_ai: string;
    soon: string;
    no_guess: string;
    contact: string;
    view_plans: string;
  };
  admin: {
    admin_queue_title: string;
    admin_paid_on: string;
    admin_paid_save: string;
    admin_paid_clear: string;
    admin_manual_trial: string;
  };
};

const zhTW: PricingInterimCopy = {
  pricing: {
    title: '方案與價格',
    lead: '免費方案最多 5 戶。第 6 戶起，只計算超過 5 戶的部分，可選標準或進階。',
    sub: '只計算有生效租約的戶或房間。空房與範例公司資料不計費。',
    cycle_month: '月繳',
    cycle_year: '年繳（送 1 個月）',
    plan_free: '免費',
    plan_std: '標準',
    plan_pre: '進階',
    badge_rec: '推薦',
    free_price: 'NT$0',
    free_period: '最多 5 戶',
    free_fit: '適合自己管理房屋的屋主（免費戶數以內）',
    std_price_month: 'NT$39',
    pre_price_month: 'NT$59',
    period_month: '每戶每月',
    period_year: '每戶每年（送 1 個月，以 11 個月計）',
    std_year_line: '年繳每戶 NT$429（送 1 個月）',
    pre_year_line: '年繳每戶 NT$649（送 1 個月）',
    std_year_equiv: '相當於每戶每月 NT$35.75',
    pre_year_equiv: '相當於每戶每月 NT$54.08',
    std_fit: '適合中小型管理公司',
    pre_fit: '適合多據點、人數較多的團隊',
    admins_free: '1 位管理者（待接受的邀請也計入）',
    admins_std: '5 位管理者',
    admins_pre: '管理者人數不限',
    cta_free: '免費開始',
    cta_trial_std: '免費試用 3 個月',
    cta_trial_pre: '免費試用 6 個月',
    cta_contact_secondary: '或聯絡我們申請付費',
    trial_manual_note: '試用目前由內部人員手動開通；自助開通會在後續版本提供。',
    formula:
      '第 6 戶起，只計算超過 5 戶的生效租約。例如 8 戶標準方案，每月 (8−5)×NT$39＝NT$117；年繳 NT$1,287（再乘 11 個月）。',
    calc_title: '價格試算',
    calc_units: '生效租約戶數',
    calc_result_std: (n, m, y) => `${n} 戶標準方案：每月 NT$${m}；年繳 NT$${y}。`,
    calc_result_pre: (n, m, y) => `${n} 戶進階方案：每月 NT$${m}；年繳 NT$${y}。`,
    calc_note: '5 戶以內為 NT$0。空房與範例公司不計費。',
    calc_err: '請填 0 或以上的整數戶數。',
    compare_title: '方案比較',
    row_month_price: '每戶每月價格',
    row_year: '年繳（送 1 個月）',
    year_free_cell: '—',
    year_std_cell: '每戶每年 NT$429',
    year_pre_cell: '每戶每年 NT$649',
    row_billing: '計費方式',
    billing_free: '最多 5 戶免費',
    billing_paid: '第 6 戶起只計超過 5 戶的部分',
    row_unit_def: '計費戶數',
    unit_def: '有生效租約的戶或房間；空房、範例公司不計',
    same: '同左',
    row_admins: '管理者人數',
    row_trial: '免費試用',
    trial_free_cell: '—',
    trial_std_cell: '3 個月',
    trial_pre_cell: '6 個月',
    feat_sec: '功能（各方案相同）',
    feat_lease: '物件、租約與已簽 PDF',
    feat_pay: '租金紀錄與繳款回報',
    feat_repair: '報修與派工',
    feat_owner: '屋主月報與費用對帳',
    feat_line: '以 LINE 邀請租客',
    feat_esign: '電子簽署進階（順序、進度、重簽）',
    feat_kpi: '帳齡與營運指標',
    feat_billing: '完整出帳與月結預覽',
    feat_yes: '有',
    meter_esign: '電子簽月額度',
    meter_notice: '付費通知月額度',
    meter_msg: '對話訊息月額度',
    meter_ai: 'AI 月額度',
    pending: '待定',
    after_table:
      '三個方案的核心功能相同，差別只在價格、管理者人數與免費試用期。電子簽、付費通知、對話與 AI 的月額度尚未定案，表上標為待定，不構成承諾。',
    faq_unit_q: '什麼算一戶？',
    faq_unit_a: '有生效租約的戶或房間。已送出但未簽署的租約不計。',
    faq_bill_q: '超過 5 戶怎麼計費？',
    faq_bill_a:
      '第 6 戶起，只計算超過 5 戶的生效租約。例如 8 戶標準方案，每月 (8−5)×NT$39＝NT$117。年繳再乘 11 個月（送 1 個月）。',
    faq_year_q: '年繳怎麼算？',
    faq_year_a:
      '年繳送 1 個月，以 11 個月計。標準每戶每年 NT$429，進階每戶每年 NT$649。同樣只計算超過 5 戶的部分。',
    faq_start_q: '怎麼開始或升級？',
    faq_start_a:
      '5 戶以內可直接免費開始；標準方案可免費試用 3 個月，進階方案可免費試用 6 個月。若要使用標準或進階付費方案，請填申請表或來信 service@condola.app，我們會先提供匯款資訊與專屬參考碼，確認入帳後 1 個工作天內為你開通。',
    faq_sample_q: '範例公司要錢嗎？',
    faq_sample_a: '不用。範例公司不計費，也不會傳訊息給真實租客。',
    faq_admins_q: '管理者人數是什麼？',
    faq_admins_a:
      '管理者人數是指可以進入管理後台的人數，不是出租戶數。待接受的邀請也計入。免費方案 1 位管理者，標準 5 位，進階則管理者人數不限。',
    faq_invoice_q: '可以開發票嗎？',
    faq_invoice_a: '目前提供收據，暫無法開立統一發票。',
    faq_partner_q: '什麼是設計夥伴？',
    faq_partner_a:
      '設計夥伴是與我們一起先行使用產品、並提供回饋的管理公司。若想了解或提出申請，請填寫申請表。',
    faq_activate_q: '付費方案多久開通？',
    faq_activate_a:
      '我們確認入帳後 1 個工作天內為你開通；這 1 個工作天是從款項入帳當天起算，不是從送出申請日起算（工作天為週一至週五，國定假日除外）。',
    footer_cta:
      '本頁不提供線上結帳。付費方案送出申請後，我們會以信件提供匯款資訊；確認入帳後 1 個工作天內為你開通。來信 service@condola.app，或填寫申請表。',
    legal: '本服務為軟體工具，不代為管理物業或收取租金，也不保證法規遵循。',
    mailto: 'service@condola.app',
  },
  apply: {
    title: '申請標準或進階方案',
    lead: '這是申請表，不是線上付款。送出後我們會寄信說明匯款方式；確認入帳後 1 個工作天內為你開通。',
    label_company: '公司名稱',
    label_phone: '電話',
    label_units: '戶數',
    required: '必填',
    hint_units: '指有生效租約的戶或房間；空房不算。',
    plan_label: '想申請的方案（選填）',
    plan_std: '標準',
    plan_pre: '進階',
    plan_unsure: '還不確定',
    note_label: '備註（選填）',
    foot: '本表單不提供線上結帳；付費方案會以信件提供匯款資訊，確認入帳後為你開通。',
    cta: '送出申請',
    err_company: '請填公司名稱。',
    err_phone: '請填一組可聯絡的電話。',
    err_units: '請填戶數，需為 0 或以上的整數。',
    success_title: '你的申請已送達',
    success_body:
      '我們收到你的申請了，會先寄信說明匯款方式與專屬參考碼；確認入帳後 1 個工作天內為你開通。有問題可來信 service@condola.app。',
    success_note: '工作天為週一至週五，國定假日除外；1 個工作天從款項入帳當天起算。',
    back: '回方案頁',
  },
  usage: {
    usage_title: '用量',
    plan_free: '目前方案：免費',
    plan_std: '目前方案：標準',
    plan_pre: '目前方案：進階',
    units_label: '生效租約',
    units_free: (n) => `${n} / 5 戶`,
    units_paid: (n) => `${n} 戶`,
    meter_esign: '電子簽',
    meter_notice: '付費通知',
    meter_msg: '對話訊息',
    meter_ai: 'AI',
    soon: '即將提供',
    no_guess: '額度數字尚未定案，這裡不會顯示猜測值。',
    contact: '聯絡 service@condola.app',
    view_plans: '查看方案說明',
  },
  admin: {
    admin_queue_title: '方案申請佇列',
    admin_paid_on: '入帳日',
    admin_paid_save: '儲存入帳日',
    admin_paid_clear: '清除',
    admin_manual_trial: '試用目前由內部人員手動開通。',
  },
};

const en: PricingInterimCopy = {
  pricing: {
    title: 'Plans & Pricing',
    lead: 'The Free plan covers up to 5 units. From the 6th unit, we only count the units beyond 5, on either Standard or Premium.',
    sub: 'We only count units or rooms with an active lease. Vacant units and sample-company data are not billed.',
    cycle_month: 'Monthly',
    cycle_year: 'Yearly (1 month free)',
    plan_free: 'Free',
    plan_std: 'Standard',
    plan_pre: 'Premium',
    badge_rec: 'Recommended',
    free_price: 'NT$0',
    free_period: 'Up to 5 units',
    free_fit: 'For owners managing their own properties (within the free unit limit).',
    std_price_month: 'NT$39',
    pre_price_month: 'NT$59',
    period_month: 'Per unit / month',
    period_year: 'Per unit / year (1 month free, billed as 11 months)',
    std_year_line: 'NT$429 per unit yearly (1 month free)',
    pre_year_line: 'NT$649 per unit yearly (1 month free)',
    std_year_equiv: 'Equivalent to NT$35.75 per unit / month',
    pre_year_equiv: 'Equivalent to NT$54.08 per unit / month',
    std_fit: 'For small and mid-sized management companies.',
    pre_fit: 'For teams with multiple locations and larger headcount.',
    admins_free: '1 admin (pending invitations count too)',
    admins_std: '5 admins',
    admins_pre: 'Unlimited admins',
    cta_free: 'Start for free',
    cta_trial_std: 'Free 3-month trial',
    cta_trial_pre: 'Free 6-month trial',
    cta_contact_secondary: 'Or contact us to apply for a paid plan',
    trial_manual_note:
      'Trials are currently activated manually by our team; self-service activation will arrive in a later release.',
    formula:
      'From the 6th unit, we only count active leases beyond 5. For example, 8 units on Standard: (8−5)×NT$39 = NT$117 per month; NT$1,287 per year (×11 months).',
    calc_title: 'Price estimate',
    calc_units: 'Units with an active lease',
    calc_result_std: (n, m, y) => `${n} units on Standard: NT$${m} per month; NT$${y} per year.`,
    calc_result_pre: (n, m, y) => `${n} units on Premium: NT$${m} per month; NT$${y} per year.`,
    calc_note: 'Up to 5 units is NT$0. Vacant units and sample companies are not billed.',
    calc_err: 'Please enter a whole number of units, 0 or more.',
    compare_title: 'Plan comparison',
    row_month_price: 'Price per unit / month',
    row_year: 'Yearly (1 month free)',
    year_free_cell: '—',
    year_std_cell: 'NT$429 per unit / year',
    year_pre_cell: 'NT$649 per unit / year',
    row_billing: 'Billing',
    billing_free: 'Up to 5 units free',
    billing_paid: 'From the 6th unit, only units beyond 5 are counted',
    row_unit_def: 'Billable units',
    unit_def: 'Units or rooms with an active lease; vacant units and sample companies excluded',
    same: 'Same as left',
    row_admins: 'Number of admins',
    row_trial: 'Free trial',
    trial_free_cell: '—',
    trial_std_cell: '3 months',
    trial_pre_cell: '6 months',
    feat_sec: 'Features (same across plans)',
    feat_lease: 'Properties, leases, and signed PDFs',
    feat_pay: 'Rent records and payment reporting',
    feat_repair: 'Repair requests and dispatch',
    feat_owner: 'Owner monthly reports and expense reconciliation',
    feat_line: 'Invite tenants via LINE',
    feat_esign: 'Advanced e-signing (order, progress, re-sign)',
    feat_kpi: 'Aging and operational metrics',
    feat_billing: 'Full billing and month-end preview',
    feat_yes: 'Yes',
    meter_esign: 'Monthly e-sign quota',
    meter_notice: 'Monthly paid-notification quota',
    meter_msg: 'Monthly conversation-message quota',
    meter_ai: 'Monthly AI quota',
    pending: 'To be determined',
    after_table:
      'The three plans share the same core features; they differ only in price, number of admins, and free-trial length. Monthly quotas for e-sign, paid notifications, conversations, and AI are not yet finalized and are marked to be determined in the table — they are not a commitment.',
    faq_unit_q: 'What counts as a unit?',
    faq_unit_a: 'A unit or room with an active lease. Leases submitted but not yet signed do not count.',
    faq_bill_q: 'How is billing handled beyond 5 units?',
    faq_bill_a:
      'From the 6th unit, we only count active leases beyond 5. For example, 8 units on Standard: (8−5)×NT$39 = NT$117 per month. Yearly multiplies by 11 months (1 month free).',
    faq_year_q: 'How is yearly billing calculated?',
    faq_year_a:
      'Yearly gives 1 month free and is billed as 11 months. Standard is NT$429 per unit per year, Premium is NT$649 per unit per year. Again, only units beyond 5 are counted.',
    faq_start_q: 'How do I start or upgrade?',
    faq_start_a:
      'Within 5 units you can start for free; Standard offers a free 3-month trial and Premium a free 6-month trial. To use the paid Standard or Premium plan, fill in the application form or email service@condola.app. We will first provide remittance details and a dedicated reference code, and activate your account within 1 business day after we confirm the payment.',
    faq_sample_q: 'Do sample companies cost anything?',
    faq_sample_a: 'No. Sample companies are not billed and will not send messages to real tenants.',
    faq_admins_q: 'What is the number of admins?',
    faq_admins_a:
      'The number of admins is how many people can access the admin console, not the number of rented units. Pending invitations count too. Free includes 1 admin, Standard 5, and Premium has unlimited admins.',
    faq_invoice_q: 'Can you issue an invoice?',
    faq_invoice_a: 'We currently provide receipts and cannot yet issue a unified invoice.',
    faq_partner_q: 'What is a design partner?',
    faq_partner_a:
      'A design partner is a management company that uses the product early alongside us and provides feedback. To learn more or apply, please fill in the application form.',
    faq_activate_q: 'How soon is a paid plan activated?',
    faq_activate_a:
      'We activate your account within 1 business day after we confirm the payment; this 1 business day is counted from the day the payment is received, not from the day you submit the application (business days are Monday to Friday, excluding national holidays).',
    footer_cta:
      'This page does not offer online checkout. After you submit a paid-plan application, we will email you remittance details; we activate your account within 1 business day after we confirm the payment. Email service@condola.app, or fill in the application form.',
    legal:
      'This service is a software tool. It does not manage properties or collect rent on your behalf, and does not guarantee legal compliance.',
    mailto: 'service@condola.app',
  },
  apply: {
    title: 'Apply for a Standard or Premium plan',
    lead: 'This is an application form, not online payment. After you submit, we will email you the remittance method; we activate your account within 1 business day after we confirm the payment.',
    label_company: 'Company name',
    label_phone: 'Phone',
    label_units: 'Number of units',
    required: 'Required',
    hint_units: 'Units or rooms with an active lease; vacant units do not count.',
    plan_label: 'Plan you would like to apply for (optional)',
    plan_std: 'Standard',
    plan_pre: 'Premium',
    plan_unsure: 'Not sure yet',
    note_label: 'Notes (optional)',
    foot: 'This form does not offer online checkout; for paid plans we provide remittance details by email and activate your account after we confirm the payment.',
    cta: 'Submit application',
    err_company: 'Please enter a company name.',
    err_phone: 'Please enter a reachable phone number.',
    err_units: 'Please enter the number of units as a whole number, 0 or more.',
    success_title: 'Your application has been received',
    success_body:
      'We have received your application and will first email you the remittance method and a dedicated reference code; we activate your account within 1 business day after we confirm the payment. Questions? Email service@condola.app.',
    success_note:
      'Business days are Monday to Friday, excluding national holidays; the 1 business day is counted from the day the payment is received.',
    back: 'Back to plans',
  },
  usage: {
    usage_title: 'Usage',
    plan_free: 'Current plan: Free',
    plan_std: 'Current plan: Standard',
    plan_pre: 'Current plan: Premium',
    units_label: 'Active leases',
    units_free: (n) => `${n} / 5 units`,
    units_paid: (n) => `${n} units`,
    meter_esign: 'E-sign',
    meter_notice: 'Paid notifications',
    meter_msg: 'Conversation messages',
    meter_ai: 'AI',
    soon: 'Coming soon',
    no_guess: 'Quota numbers are not finalized yet; we will not show guessed values here.',
    contact: 'Contact service@condola.app',
    view_plans: 'View plan details',
  },
  admin: {
    admin_queue_title: 'Plan application queue',
    admin_paid_on: 'Payment received date',
    admin_paid_save: 'Save payment date',
    admin_paid_clear: 'Clear',
    admin_manual_trial: 'Trials are currently activated manually by our team.',
  },
};

export function pricingInterimCopy(locale: string): PricingInterimCopy {
  return locale === 'zh-TW' ? zhTW : en;
}
