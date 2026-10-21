/** TWD is written NT$20,000. zh-TW Intl would otherwise print $20,000. */
export function formatMajor(major: number, currency: string, locale: string) {
  if (!Number.isFinite(major)) return "";
  if (currency === "TWD") {
    const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(major));
    return `NT$${grouped}`;
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

export function confirmDeposit(monthsRaw: string, rentRaw: string, currency: string, locale: string) {
  const months = Number(monthsRaw);
  const rent = Number(rentRaw);
  const amount =
    Number.isFinite(months) && Number.isFinite(rent) ? formatMajor(months * rent, currency, locale) : "";
  const monthsLabel = monthsRaw.trim();
  if (locale === "zh-TW") return amount ? `${monthsLabel} 個月（${amount}）` : `${monthsLabel} 個月`;
  const unit = months === 1 ? "month" : "months";
  return amount ? `${monthsLabel} ${unit} (${amount})` : `${monthsLabel} ${unit}`;
}
