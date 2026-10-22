import { translate, type Dict, type Locale } from "@/i18n";

function groupedAmount(minor: number | string, locale: Locale, digits: number) {
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(Number(minor)) / 100);
}

/** char(3) currency codes can arrive padded. TWD is matched after trim. */
function currencyCode(currency: string) {
  return currency.trim().toUpperCase();
}

/** TWD is an absolute NT$ amount, so zero is NT$0 and never −NT$0. Other currencies keep the ICU symbol. */
export function formatMoney(minor: number | string, currency: string, locale: Locale) {
  const code = currencyCode(currency);
  if (code === "TWD") return `NT$${groupedAmount(minor, locale, 0)}`;
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(minor) / 100);
}

/** Absolute amount with an NT$ prefix for TWD, so zero is NT$0 and never −NT$0. */
export function moneyLabel(minor: number | string, currency: string, locale: Locale) {
  const code = currencyCode(currency);
  if (code === "TWD") return formatMoney(minor, code, locale);
  return formatMoney(Math.abs(Number(minor)), code, locale);
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

/** Signed TWD amounts keep the NT$ prefix, including a leading minus for a credit. */
export function signedMoneyLabel(minor: number | string, currency: string, locale: Locale) {
  const value = Number(minor);
  const label = moneyLabel(value, currency, locale);
  return value < 0 ? `-${label}` : label;
}

/** Month settlement. A negative net is what the owner owes — never a negative payout. */
export function ownerSettlement(row: StatementFigures) {
  const fee = Math.max(0, row.fee);
  const expenses = row.expenses;
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
  const code = currencyCode(currency);
  if (code === "TWD") return `NT$${groupedAmount(minorPerUnit, locale, 2)}`;
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(minorPerUnit) / 100);
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
