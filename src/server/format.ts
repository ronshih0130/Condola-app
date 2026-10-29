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

/** Billing month in front of an electricity line, as `2026年11月` with no zero-padded month. A label that already starts with that month stays as it is. */
export function electricityMonthLabel(period: string | null | undefined, description: string) {
  const text = description.trim();
  const match = period?.match(/^(\d{4})-(\d{2})/);
  const monthNumber = match ? Number(match[2]) : 0;
  if (!match || monthNumber < 1 || monthNumber > 12 || !text) return text;
  const month = `${match[1]}年${monthNumber}月`;
  if (text === month || text.startsWith(`${month} `)) return text;
  return `${month} ${text}`;
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

/** Signed TWD amounts keep the NT$ prefix. A negative uses an ASCII hyphen, and zero stays NT$0. */
export function signedMoneyLabel(minor: number | string, currency: string, locale: Locale) {
  const value = Number(minor);
  const label = moneyLabel(value, currency, locale);
  return value < 0 ? `-${label}` : label;
}

/** Statement page and statement PDF only. A negative uses U+2212, and zero stays NT$0. */
export function statementSignedMoney(minor: number | string, currency: string, locale: Locale) {
  const value = Number(minor);
  const label = moneyLabel(value, currency, locale);
  return value < 0 ? `\u2212${label}` : label;
}

/** Select the signed amount typography for the active brand. */
export function signedMoney(minor: number | string, currency: string, locale: Locale, v2: boolean) {
  return v2
    ? statementSignedMoney(minor, currency, locale)
    : signedMoneyLabel(minor, currency, locale);
}

/** Period movement stored on owner_statements: rent + other − fee − expenses − payouts. */
export function statementPeriodNet(row: Pick<StatementFigures, "rent" | "other" | "fee" | "expenses" | "payouts">) {
  return row.rent + row.other - row.fee - row.expenses - row.payouts;
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
