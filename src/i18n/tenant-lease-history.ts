export function tenantLeaseHistoryCopy(locale: string) {
  return locale === 'zh-TW' ? {
    title: '已結束合約的歷史紀錄', link: '查看已結束合約', empty: '此帳戶目前沒有可顯示的已結束合約。',
    unavailable: '目前無法取得歷史紀錄，請稍後再試。', next: '下一頁', first: '返回第一頁', emptyPage: '此頁已沒有可顯示的紀錄。',
    back: '返回歷史清單', dates: '合約期間', noEnd: '無固定結束日期', ended: '已結束', archived: '已封存', inherited: '上層已封存',
    papers: '保留的紙本簽署檔案', papersUnavailable: '目前無法取得簽署檔案。', noPapers: '目前沒有可存取的簽署檔案。',
    uploaded: '上傳時間', current: '目前版本', prior: '歷史版本', download: '查看或下載 PDF',
  } : {
    title: 'Ended lease history', link: 'View ended leases', empty: 'There are no ended leases to show for this account.',
    unavailable: 'History is currently unavailable. Please try again later.', next: 'Next page', first: 'Back to first page', emptyPage: 'There are no records on this page.',
    back: 'Back to history', dates: 'Lease dates', noEnd: 'No fixed end date', ended: 'Ended', archived: 'Archived', inherited: 'Parent archived',
    papers: 'Retained signed paper files', papersUnavailable: 'Signed files are currently unavailable.', noPapers: 'There are no signed files currently available.',
    uploaded: 'Uploaded', current: 'Current version', prior: 'Earlier version', download: 'View or download PDF',
  };
}
