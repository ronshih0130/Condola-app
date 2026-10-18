import { translate, type Dict, type Locale } from "@/i18n";

export function formatMoney(minor: number | string, currency: string, locale: Locale) {
  const value = Number(minor) / 100;
  const decimals = currency === "TWD" ? 0 : 2;
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Absolute amount with an NT$ prefix for TWD, so zero is NT$0 and never −NT$0. */
export function moneyLabel(minor: number | string, currency: string, locale: Locale) {
  const amount = Math.abs(Number(minor));
  if (currency === "TWD") {
    const formatted = new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount / 100);
    return `NT$${formatted}`;
  }
  return formatMoney(amount, currency, locale);
}

export type StatementFigures = {
  opening: number;
  rent: number;
  other: number;
  fee: number;
  expenses: number;
  payouts: number;
  closing: number;
};

/** Month settlement. A negative net is what the owner owes — never a negative payout. */
export function ownerSettlement(row: StatementFigures) {
  const fee = Math.max(0, row.fee);
  const expenses = Math.max(0, row.expenses);
  const rent = Math.max(0, row.rent);
  const other = Math.max(0, row.other);
  const costs = fee + expenses;
  const net = rent + other - costs;
  return {
    opening: row.opening,
    rent,
    other,
    fee,
    expenses,
    payouts: Math.max(0, row.payouts),
    closing: row.closing,
    costs,
    net,
    owes: net < 0 ? -net : 0,
    payable: net > 0 ? net : 0,
  };
}

export function formatRate(minorPerUnit: number | string, currency: string, locale: Locale) {
  const value = Number(minorPerUnit) / 100;
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDate(
  iso: string | Date | null | undefined,
  locale: Locale,
  calendar: "gregorian" | "roc",
  dict: Dict,
) {
  if (!iso) return "";
  const day = typeof iso === "string" ? iso.slice(0, 10) : iso.toISOString().slice(0, 10);
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return "";
  if (calendar === "roc") {
    return translate(dict, "date.roc", { year: year - 1911, month, day: date });
  }
  return new Intl.DateTimeFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}
