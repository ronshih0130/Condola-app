import { toMinor } from "@/server/money";

/** TWD rent and the deposit (months × rent) are whole dollars. USD may use cents. */
export function twdAmountsAreWhole(currency: string, rentMajor: number, depositMonths: number) {
  if (currency !== "TWD") return true;
  const rentMinor = toMinor(rentMajor);
  if (!Number.isFinite(rentMinor) || rentMinor % 100 !== 0) return false;
  const depositMinor = Math.round(rentMinor * depositMonths);
  return Number.isFinite(depositMinor) && depositMinor % 100 === 0;
}

/** TWD on the lease wizard is $12,000: a dollar sign, thousands separators, and whole dollars. */
export function formatMajor(major: number, currency: string, locale: string) {
  if (!Number.isFinite(major)) return "";
  if (currency === "TWD") {
    return new Intl.NumberFormat("zh-Hant-TW", {
      style: "currency",
      currency: "TWD",
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(Math.round(major));
  }
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(major);
}

export function confirmSpace(room: { propertyName: string; unitLabel: string; label: string }) {
  return `${room.propertyName} · ${room.unitLabel}${room.label ? ` ${room.label}` : ""}`;
}

export function confirmDeposit(
  monthsRaw: string,
  rentRaw: string,
  currency: string,
  locale: string,
  format: (major: number, currency: string, locale: string) => string = formatMajor,
) {
  const months = Number(monthsRaw);
  const rent = Number(rentRaw);
  const amount = Number.isFinite(months) && Number.isFinite(rent) ? format(months * rent, currency, locale) : "";
  const monthsLabel = monthsRaw.trim();
  if (locale === "zh-TW") return `${monthsLabel} 個月`;
  const unit = months === 1 ? "month" : "months";
  return amount ? `${monthsLabel} ${unit} (${amount})` : `${monthsLabel} ${unit}`;
}
