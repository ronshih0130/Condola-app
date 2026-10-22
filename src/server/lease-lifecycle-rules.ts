import { addDays, toMinor } from "./money";
import { twdRentIsWhole } from "@/lease-confirm";

/** Stored on organizations.feature_flags. On only for the sample company and beta orgs. */
export const LEASE_LIFECYCLE_FLAG = "lease_lifecycle";

/** Expiry list and renewal window. */
export const RENEW_WITHIN_DAYS = 90;

export const COPY = {
  listTitle: "續約和退租",
  window: "90 天內到期",
  statusAll: "全部狀態",
  colParty: "租客／物件",
  colEnd: "到期日",
  colDays: "剩餘天數",
  colStatus: "狀態",
  undecided: "未決定",
  renewing: "續約中",
  scheduled: "已排定退租",
  renew: "續約",
  moveOut: "退租",
  pendingNote: "新租約待簽",
  settle: "押金結算",
  emptyTitle: "90 天內沒有到期的租約",
  emptyBody: "租約到期前 90 天會出現在這裡。",
  stepTerms: "1 新條件",
  stepConfirm: "2 確認",
  stepDate: "1 退租日",
  stepHandover: "2 點交",
  stepSettle: "3 押金結算",
  newStart: "新租期開始",
  newEnd: "新租期結束",
  rentSection: "租金",
  oldRent: "原月租金",
  newRent: "新月租金",
  depositSection: "押金（另列）",
  oldDeposit: "原押金",
  newDeposit: "新押金",
  next: "下一步",
  cancel: "取消",
  confirmTitle: "確認續約",
  term: "租期",
  monthlyRent: "月租金",
  deposit: "押金",
  oldLease: "舊租約",
  create: "建立新租約",
  back: "返回修改",
  reason: "退租原因",
  reasonExpired: "租約到期不續約",
  reasonEarly: "提前退租",
  reasonOther: "其他",
  moveOutDate: "退租日",
  moveOutRent: "退租租金",
  handover: "點交時間",
  schedule: "排定退租",
  depositHeld: "押金（屋主保管）",
  deductions: "扣抵項目",
  addDeduction: "新增扣抵項目",
  confirmSettle: "確認結算",
  ownerRefund: "屋主應退還租客",
  ownerRefundDone: "屋主退還租客",
  shortfallTitle: "押金不足扣抵",
  shortfallRow: "租客還需補付屋主",
  deductionTotal: "扣抵合計",
  electricity: "電費（租期內最後一期）",
  doneTitle: "退租完成",
  refundDate: "退還日期",
  vacantPower: "空房期間電費",
  vacantPowerNote: "之後列為「電費（空房／未簽約）」",
  download: "下載押金結算單 PDF",
  disclaimer: "Condola 只提供管理軟體，不經手任何款項。",
  periodRentSuffix: "租金",
} as const;

export function leaseLifecycleEnabled(input: { environment: string; planTier: string }) {
  return input.environment === "sandbox" || input.planTier === "beta";
}

export function daysBetween(later: string, earlier: string) {
  const end = Date.parse(`${later.slice(0, 10)}T00:00:00Z`);
  const start = Date.parse(`${earlier.slice(0, 10)}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/** Active leases whose end date is today through the next 90 days. */
export function leaseInExpiryWindow(input: { status: string; endDate: string | null; today: string }) {
  if (input.status !== "active" || !input.endDate) return false;
  const days = daysBetween(input.endDate, input.today);
  return days >= 0 && days <= RENEW_WITHIN_DAYS;
}

export function remainingDaysLabel(days: number) {
  return `${days} 天`;
}

/** The next term starts the day after the old lease ends and keeps the same length. */
export function nextRenewalTerm(start: string, end: string) {
  const span = daysBetween(end, start);
  const nextStart = addDays(end, 1);
  return { start: nextStart, end: addDays(nextStart, span) };
}

export function renewalDatesOk(oldEnd: string, start: string, end: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start > oldEnd && end >= start;
}

export function dueDayOk(day: number) {
  return Number.isInteger(day) && day >= 1 && day <= 28;
}

export function dueDayLabel(day: number) {
  return `每月 ${day} 日繳租`;
}

/** {YYYY}年{M}月 — month is not zero-padded. */
export function periodLabel(iso: string) {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return `${year}年${month}月`;
}

export function periodRentLabel(iso: string) {
  return `${periodLabel(iso)} ${COPY.periodRentSuffix}`;
}

export function nt(major: number) {
  const formatted = new Intl.NumberFormat("zh-Hant-TW", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(Math.round(Math.abs(major)));
  return `NT$${formatted}`;
}

export function renewalTitle(tenant: string) {
  return `續約：${tenant}`;
}

export function renewalSuccess(start: string) {
  return `新租約已建立，${periodLabel(start)} 起的帳單會依新租金產生。`;
}

export function depositConfirm(amount: string, delta: string) {
  return `${amount}（差額 ${delta}）`;
}

export function depositIncreaseHint(amount: string) {
  return `押金差額 ${amount}，款項到帳後請在繳租紀錄登記為「押金」。`;
}

export function depositDecreaseHint(amount: string) {
  return `押金減少 ${amount}，由屋主直接退給租客。`;
}

export function oldLeaseNote(end: string) {
  return `${end} 結束後保留為歷史紀錄`;
}

export function moveOutTitle(tenant: string) {
  return `退租：${tenant}`;
}

export function settlementTitle(tenant: string) {
  return `押金結算：${tenant}`;
}

/** Move-out cannot be before the lease starts. */
export function moveOutDateOk(startDate: string, moveOutOn: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(moveOutOn) && moveOutOn >= startDate;
}

export function moveOutTooEarly(startDate: string) {
  return `無法排定退租：退租日早於租約開始日（${startDate}）。`;
}

/**
 * Days in the move-out month, including the move-out day.
 * The count starts on the 1st, or on the lease start when that is later.
 * 2026-11-01 through 2026-11-17 is 17 days.
 */
export function moveOutRentSpan(leaseStart: string, moveOutOn: string) {
  if (!moveOutDateOk(leaseStart, moveOutOn)) return null;
  const monthStart = `${moveOutOn.slice(0, 7)}-01`;
  const start = leaseStart > monthStart ? leaseStart : monthStart;
  if (moveOutOn < start) return null;
  const days = daysBetween(moveOutOn, start) + 1;
  return {
    start,
    end: moveOutOn,
    days,
    startDay: Number(start.slice(8, 10)),
    endDay: Number(moveOutOn.slice(8, 10)),
  };
}

/** 月租 ÷ 30 × 天數, rounded to a whole NT$. */
export function prorateRentMajor(monthlyMajor: number, days: number) {
  if (!Number.isInteger(monthlyMajor) || monthlyMajor < 0) return null;
  if (!Number.isInteger(days) || days <= 0) return null;
  return Math.round((monthlyMajor * days) / 30);
}

export function rentFormula(monthlyMajor: number, days: number, amountMajor: number) {
  return `${nt(monthlyMajor)} ÷ 30 × ${days} 天 ＝ ${nt(amountMajor)}`;
}

export function midTermHint(moveOutOn: string, amountMajor: number) {
  return `退租日在租期中：${periodLabel(moveOutOn)} 租金按天數計算為 ${nt(amountMajor)}，帳單會自動更新。`;
}

export function overrideNote(originalMajor: number, nextMajor: number) {
  return `原金額 ${nt(originalMajor)}，已改為 ${nt(nextMajor)}`;
}

/** Taipei wall time, YYYY-MM-DD HH:mm. */
export function formatStamp(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

export function overrideStamp(actor: string, date: Date) {
  return `已手動修改（${actor}・${formatStamp(date)}）`;
}

export function unpaidRentLabel(moveOutOn: string, startDay: number, endDay: number) {
  return `未繳租金 ${periodLabel(moveOutOn)}（${startDay}–${endDay} 日）`;
}

export function repairLabel(item: string, photos: number) {
  return `修繕：${item}（附照片 ${photos} 張）`;
}

export function shortfallBody(amountMajor: number) {
  return `扣款超過押金，租客還需補付 ${nt(amountMajor)}`;
}

export function moveOutDone(tenant: string, moveOutOn: string) {
  return `${tenant} 已於 ${moveOutOn} 退租。押金結算已登記，物件改為空房。`;
}

export function refundDateLabel(date: string) {
  return `${date}（已登記）`;
}

export function moneyMajor(majorRaw: number, currency: string) {
  if (!Number.isFinite(majorRaw) || majorRaw < 0) return null;
  if (!twdRentIsWhole(currency, majorRaw)) return null;
  const minor = toMinor(majorRaw);
  if (!Number.isInteger(minor) || minor < 0) return null;
  return minor;
}

export function majorOf(minor: number, currency: string) {
  return currency.trim().toUpperCase() === "TWD" ? Math.round(minor / 100) : minor / 100;
}

export function settleAmounts(depositMinor: number, deductionMinor: number) {
  if (!Number.isInteger(depositMinor) || depositMinor < 0) return null;
  if (!Number.isInteger(deductionMinor) || deductionMinor < 0) return null;
  const refundMinor = Math.max(depositMinor - deductionMinor, 0);
  const shortfallMinor = Math.max(deductionMinor - depositMinor, 0);
  return { refundMinor, shortfallMinor, deductionsMinor: deductionMinor };
}

export type EndReason = "expired" | "early" | "other";

export function endReasonLabel(reason: EndReason) {
  if (reason === "expired") return COPY.reasonExpired;
  if (reason === "early") return COPY.reasonEarly;
  return COPY.reasonOther;
}
