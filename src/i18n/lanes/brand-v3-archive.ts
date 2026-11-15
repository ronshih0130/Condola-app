// R2-ARCH / R2-ARCH-ONE / R2-ARCH-ACT, approved 2026-11-14 20:50 PT.
export function archiveV3Copy(locale:string) {
 return locale==='zh-TW' ? {
  title:'封存',lead:'封存了 {n} 筆：物件 {a}、單位 {b}、屋主 {c}。',
  retained:'封存不是刪除：歷史租約、繳款和附件都還查得到。',
  all:'全部',property:'物件',unit:'單位',owner:'屋主',name:'名稱',kind:'種類',archived:'封存',view:'查看',
  empty:'沒有封存的資料。',detailLead:'{name}已經封存。',
  detailHint:'{date} 由{name}封存。資料和歷史都還在，只是不會出現在日常列表。',
  leases:'歷史租約',other:'其他紀錄',blocked:'現在還不能封存',
  activeLease:'還有 {n} 份進行中的租約，先處理租約才能封存。',leaseAction:'查看租約',close:'關閉',cancel:'取消',
  // P52 (PENDING-RON PR-018): wording not specified by these rows; effect follows AC3.
  confirm:'封存後不會出現在日常列表、今天和搜尋中。歷史都還在，管理者可以還原。',
  inherit:'封存物件後，底下的單位和房間也會因上層封存而隱藏。',
  unknownActor:'未確認的成員',unknownDate:'日期尚未確認',
  ownerUnavailable:'屋主封存尚未提供，這裡只顯示既有封存紀錄。',
  // P52 (PENDING-RON PR-018): non-lease blocker action labels; sentences reuse archiveCopy.
  signingAction:'查看簽署',repairAction:'查看維修',dispatchAction:'查看派工',utilityAction:'查看水電作業',
  // MGT-112 loading/error conventions, reused by the adjacent property page.
  loading:'載入中',failed:'資料載入失敗',retry:'再試一次',
 } : {
  // P52 (PENDING-RON PR-018): English translations of the approved zh-TW rows.
  title:'Archive',lead:'{n} archived: {a} properties, {b} units, {c} owners.',
  retained:'Archiving is not deletion: historical leases, payments and attachments remain accessible.',
  all:'All',property:'Properties',unit:'Units',owner:'Owners',name:'Name',kind:'Kind',archived:'Archived',view:'View',
  empty:'No archived records.',detailLead:'{name} is archived.',
  detailHint:'Archived on {date} by {name}. Data and history remain; this item is hidden from daily lists.',
  leases:'Historical leases',other:'Other records',blocked:'Cannot archive yet',
  activeLease:'There are {n} ongoing leases. Address them before archiving.',leaseAction:'View leases',close:'Close',cancel:'Cancel',
  confirm:'Archiving hides this item from daily lists, Today and search. History remains accessible; an administrator can restore it.',
  inherit:'Units and rooms inherit the archived state of their property.',unknownActor:'Unconfirmed member',unknownDate:'Date not confirmed',
  ownerUnavailable:'Owner archiving is not available yet. Only existing archive records are shown.',
  signingAction:'View signing',repairAction:'View repair',dispatchAction:'View dispatch',utilityAction:'View utility work',
  loading:'Loading',failed:'Could not load data',retry:'Try again',
 };
}
export function archiveText(template:string,values:Record<string,string|number>) {
 return template.replace(/\{(\w+)\}/g,(match,key:string)=>values[key]===undefined?match:String(values[key]));
}
