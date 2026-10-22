/**
 * Acceptance money rules, in whole NT$.
 * Move-out rent is monthly rent × days ÷ 30, rounded half-up once at the end,
 * then capped at one month of rent.
 * 管理公司經手租金 is rent whose recipient is the management company. Deposits are excluded.
 */

export type BillSlice = { period: string; remaining: number };

export type PaymentBalance = {
  status: "部分付款" | "已繳清";
  remaining: number;
  text: string | null;
};

export type DepositResult = {
  shortfall: number;
  refund: number;
  warning: boolean;
  text: string | null;
};

export type HandledRentRow = {
  recipient: "company" | "owner" | string;
  type: "rent" | "deposit" | string;
  amount: number;
};

/** Half-up division of two integers, applied once. */
export function divHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) {
    throw new Error("divHalfUp expects a positive integer denominator");
  }
  if (numerator === 0) return 0;
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  return sign * Math.floor((abs + Math.floor(denominator / 2)) / denominator);
}

export function formatTwd(amount: number): string {
  const negative = amount < 0;
  const body = Math.abs(amount).toLocaleString("en-US");
  return negative ? `\u2212NT$${body}` : `NT$${body}`;
}

export function paymentBalance(bill: number, payments: number[]): PaymentBalance {
  const paid = payments.reduce((sum, amount) => sum + amount, 0);
  const remaining = bill - paid;
  if (remaining <= 0) return { status: "已繳清", remaining: 0, text: null };
  if (paid > 0) return { status: "部分付款", remaining, text: `尚未繳 ${formatTwd(remaining)}` };
  return { status: "部分付款", remaining, text: `尚未繳 ${formatTwd(remaining)}` };
}

export function allocateOldestFirst(bills: BillSlice[], amount: number): BillSlice[] {
  const sorted = bills
    .map((bill, index) => ({ bill, index }))
    .sort((a, b) => a.bill.period.localeCompare(b.bill.period) || a.index - b.index);
  let left = amount;
  const next = sorted.map(({ bill }) => {
    const take = Math.min(Math.max(left, 0), Math.max(bill.remaining, 0));
    left -= take;
    return { period: bill.period, remaining: bill.remaining - take };
  });
  return next;
}

export function validPaymentDate(date: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  return date <= today;
}

/** Inclusive civil-day count. The last day counts. */
export function inclusiveDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    throw new Error("inclusiveDays expects an ordered ISO civil range");
  }
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * Whole NT$. Multiply first, divide by 30 once, half-up once, then cap at one month.
 * A 31-day month at 18,000 is 18,000, not 18,600.
 */
export function prorateRent(monthlyRent: number, days: number): number {
  if (!Number.isInteger(monthlyRent) || monthlyRent < 0 || !Number.isInteger(days) || days < 0) {
    throw new Error("prorateRent expects a non-negative whole NT$ rent and a non-negative day count");
  }
  if (monthlyRent === 0 || days === 0) return 0;
  const raw = divHalfUp(monthlyRent * days, 30);
  return raw > monthlyRent ? monthlyRent : raw;
}

export function depositBalance(deposit: number, deductions: number[]): DepositResult {
  const taken = deductions.reduce((sum, amount) => sum + amount, 0);
  const shortfall = Math.max(0, taken - deposit);
  const refund = Math.max(0, deposit - taken);
  return {
    shortfall,
    refund,
    warning: shortfall > 0,
    text: shortfall > 0 ? `補付 ${formatTwd(shortfall)}` : null,
  };
}

export function settlementClosing(input: {
  opening: number;
  rent: number;
  expenses: number;
  payouts: number;
}): number {
  return input.opening + input.rent - input.expenses - input.payouts;
}

export function nextOpening(previousClosing: number): number {
  return previousClosing;
}

export function companyHandledRent(rows: HandledRentRow[]): number {
  return rows.reduce((sum, row) => {
    if (row.recipient !== "company" || row.type !== "rent") return sum;
    return sum + row.amount;
  }, 0);
}

export function validDueDay(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= 28;
}

export function defaultDueDay(day: number | undefined): number {
  return day === undefined ? 5 : day;
}

export function overdueDays(due: string, today: string): number {
  const start = Date.parse(`${due}T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}
