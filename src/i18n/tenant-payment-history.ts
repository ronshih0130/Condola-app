/** Tenant-facing payment history labels; stored reports are not proof of receipt. */
export function tenantPaymentHistoryCopy(locale: string) {
  return locale === 'zh-TW' ? {
    title: '我的付款回報', currentBill: '目前未結帳單餘額', currentBillNote: '此餘額反映目前帳單，不是回報當時的餘額。',
    unavailable: '目前無法取得付款回報與帳單資料，請稍後再試。', empty: '目前沒有可顯示的付款回報。',
    unsigned: '合約尚未簽署，帳單尚未開立。', noInvoice: '目前沒有已開立的帳單。', nonpayable: '目前沒有可付款的已開立帳單。',
    zeroCharge: '目前帳單沒有應付金額。', credit: '目前有帳單抵扣餘額', creditBalance: '目前抵扣餘額', offset: '帳單費用與抵扣相抵，目前無需付款。', due: '待付款', partial: '部分款項已確認', paid: '帳單已結清', overdue: '已逾期',
    pending: '已回報，待管理方確認', pendingNote: '回報不代表款項已確認；確認前，帳單餘額不會因回報而改變。',
    submitted: '已回報，待管理方確認', confirmed: '已確認', rejected: '未通過確認', reversed: '確認已撤銷',
    recordedAmount: '目前紀錄金額', paidOn: '原回報填寫的付款日期', recordedPaidOn: '目前紀錄的付款日期', submittedAt: '回報時間', confirmedAt: '確認時間',
    originalUnavailable: '原始回報內容無法確認；以上顯示目前紀錄。', original: '原始回報', rejectionReason: '未通過原因',
    rejectionReasonUnavailable: '未通過原因無法顯示。', reversalReasonUnavailable: '撤銷原因目前無法顯示。',
    reportAgain: '重新回報付款', reportAgainNote: '重新回報會建立一筆新紀錄，原回報仍會保留。',
    reportDetails: '查看此回報', next: '下一頁', first: '返回第一頁', billLines: '目前帳單項目', paidAmount: '已確認金額',
    monthlyDue: '每月應繳總額', monthlyDueNote: '依已開立帳單列出：租金、水電與其他費用，扣除帳單上的抵扣（含帳單已列出的代墊）與已確認的繳款。Condola 只顯示紀錄，不經手任何款項。', dueTotal: '應繳總額', dueGross: '費用合計', dueOffset: '抵扣（含代墊）', duePaid: '已確認繳款', dueCarry: '本月抵扣與繳款超出本月費用的部分（不計入本月應繳，也不會自動套用到其他月份）', dueNetNote: '各月份分別計算；實際未結金額以上方「目前未結帳單餘額」為準。', duePaidSource: (no: string) => `帳單 ${no} 已確認繳款`, dueSource: (no: string, line: number) => `來源：帳單 ${no} 第 ${line} 項`, dueKeys: { rent: '租金', utility: '水電', deposit: '押金', other: '其他費用', offset: '抵扣' } as Record<string, string>,
  } : {
    title: 'My payment reports', currentBill: 'Current outstanding balance', currentBillNote: 'This is the current bill balance, not the balance when a report was submitted.',
    unavailable: 'Payment reports and bill details are currently unavailable. Please try again later.', empty: 'There are no payment reports to show.',
    unsigned: 'The lease is not signed and a bill has not been issued.', noInvoice: 'There is no issued bill at present.', nonpayable: 'There is no payable issued bill at present.',
    zeroCharge: 'There is no charge due on the current bill.', credit: 'A bill credit is available', creditBalance: 'Current bill credit', offset: 'Charges and credits offset; no payment is due.', due: 'Payment due', partial: 'Partially confirmed', paid: 'Bill settled', overdue: 'Overdue',
    pending: 'Reported, awaiting management confirmation', pendingNote: 'A report does not confirm payment. The bill balance does not change because of a report until it is confirmed.',
    submitted: 'Reported, awaiting management confirmation', confirmed: 'Confirmed', rejected: 'Not confirmed', reversed: 'Confirmation reversed',
    recordedAmount: 'Currently recorded amount', paidOn: 'Payment date entered in original report', recordedPaidOn: 'Currently recorded payment date', submittedAt: 'Report submitted', confirmedAt: 'Confirmed at',
    originalUnavailable: 'The original report cannot be verified; the current record is shown above.', original: 'Original report', rejectionReason: 'Reason not confirmed',
    rejectionReasonUnavailable: 'The reason is unavailable.', reversalReasonUnavailable: 'The reason for reversal is unavailable.',
    reportAgain: 'Report payment again', reportAgainNote: 'A new report will be created and the earlier report will remain.',
    reportDetails: 'View this report', next: 'Next page', first: 'Back to first page', billLines: 'Current bill items', paidAmount: 'Confirmed amount',
    monthlyDue: 'Monthly total due', monthlyDueNote: 'From issued bills: rent, utilities and other charges, less credits on the bill (including tenant advances already on the bill) and confirmed payments. Condola only shows records and does not handle money.', dueTotal: 'Total due', dueGross: 'Charges', dueOffset: 'Credits (incl. advances)', duePaid: 'Confirmed payments', dueCarry: 'Credits and payments above this month\'s charges (not part of this month\'s total and not applied to other months automatically)', dueNetNote: 'Each month is calculated separately; the current outstanding balance above is the amount actually open.', duePaidSource: (no: string) => `Confirmed payment, bill ${no}`, dueSource: (no: string, line: number) => `Source: bill ${no}, item ${line}`, dueKeys: { rent: 'Rent', utility: 'Utilities', deposit: 'Deposit', other: 'Other charges', offset: 'Credit' } as Record<string, string>,
  };
}
