/** B-025 vendor document entry. Receipt ≠ tax invoice; Condola does not handle money. */
export function vendorDocumentsCopy(locale: string) {
  return locale === 'en' ? {
    title: 'Receipt and completion statement', ticket: 'Work order', items: 'Items', total: 'Work order total',
    buyer: 'Buyer', buyerOwner: 'Owner (owner-entered receipt title)', buyerCompany: 'Company', titleMissing: 'The owner has not entered a receipt title yet; a receipt cannot be issued.',
    paidTitle: 'Payments you have recorded for this work order', paid: 'Recorded as paid', remaining: 'Remaining', noMarks: 'Nothing recorded yet.',
    recordLabel: 'Amount paid to you (whole currency units)', record: 'Record payment', partialNote: 'Partial payments only accumulate. A receipt can be issued only once the work order is paid in full.',
    preview: 'Preview', previewNote: 'Preview does not use a document number.', issueStatement: 'Issue completion statement', issueReceipt: 'Issue receipt',
    oneStep: 'Confirm paid in full on site and issue receipt', needFull: 'A receipt needs the full amount recorded first.', notEligible: 'Your profile can issue completion statements only.',
    documents: 'Issued documents', none: 'No documents yet.', voided: 'Voided', issued: 'Issued', download: 'Download PDF', voidReason: 'Reason for voiding', void: 'Void', reissue: 'Reissue',
    receipt: 'Receipt', statement: 'Completion statement', notTax: 'A receipt is not a tax invoice.', unavailable: 'This is unavailable. Refresh and try again.', loading: 'Working…', done: 'Done.', invalid: 'Enter a whole positive amount.', itemsUnavailable: 'This work order has several priced items; the management company needs to prepare the document rows before you can issue it here.',
  } : {
    title: '收據與完工明細', ticket: '工單', items: '項目', total: '工單總額',
    buyer: '買受人', buyerOwner: '屋主（屋主自行填寫的收據抬頭）', buyerCompany: '公司', titleMissing: '屋主尚未填寫收據抬頭，暫時無法開立收據。',
    paidTitle: '你為此工單記錄的付款', paid: '已記錄付款', remaining: '尚未付清', noMarks: '尚未記錄。',
    recordLabel: '對方已付給你的金額（整數）', record: '記錄付款', partialNote: '部分付款只會累計；工單全額付清後才能開立收據。',
    preview: '預覽', previewNote: '預覽不會使用文件編號。', issueStatement: '開立完工明細', issueReceipt: '開立收據',
    oneStep: '現場確認已全額付款並開立收據', needFull: '開立收據前需先記錄全額付款。', notEligible: '你的資料目前只能開立完工明細。',
    documents: '已開立文件', none: '尚無文件。', voided: '已作廢', issued: '已開立', download: '下載 PDF', voidReason: '作廢原因', void: '作廢', reissue: '重新開立',
    receipt: '收據', statement: '完工明細', notTax: '收據不是發票。', unavailable: '目前無法完成。請重新整理後再試。', loading: '處理中…', done: '已完成。', invalid: '請輸入正整數金額。', itemsUnavailable: '此工單有多個計價項目，需由管理方先建立文件明細後，才能在這裡開立。',
  };
}
