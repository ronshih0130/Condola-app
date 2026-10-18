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
