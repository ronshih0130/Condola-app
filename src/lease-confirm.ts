import { toMinor } from "@/server/money";

/** TWD rent is a whole dollar. USD may use cents. */
export function twdRentIsWhole(currency: string, rentMajor: number) {
  if (currency !== "TWD") return true;
  const rentMinor = toMinor(rentMajor);
  return Number.isFinite(rentMinor) && rentMinor % 100 === 0;
}

/** 0, 0.5, 1, 1.5, … are allowed. 1.3 is not. */
export function depositMonthsOnHalfStep(months: number) {
  if (!Number.isFinite(months) || months < 0) return false;
  const doubled = months * 2;
  return Math.abs(doubled - Math.round(doubled)) < 1e-6;
}

/** TWD deposit dollars are round(rent × months). Other currencies keep cents. */
export function depositAmountMinor(currency: string, rentMajor: number, depositMonths: number) {
  if (currency === "TWD") return toMinor(Math.round(rentMajor * depositMonths));
  return Math.round(toMinor(rentMajor) * depositMonths);
}

/** TWD on the lease wizard is NT$12,000: an NT$ prefix, thousands separators, and whole dollars. */
export function formatMajor(major: number, currency: string, locale: string) {
  if (!Number.isFinite(major)) return "";
  const code = currency.trim().toUpperCase();
  if (code === "TWD") {
    const formatted = new Intl.NumberFormat("zh-Hant-TW", {
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(Math.round(Math.abs(major)));
    return `NT$${formatted}`;
  }
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(major);
}

export function confirmSpace(room: { propertyName: string; unitLabel: string; label: string }) {
  return `${room.propertyName} · ${room.unitLabel}${room.label ? ` ${room.label}` : ""}`;
}

/** Copy the room at the moment it is picked. A later vacant-room refresh must not erase it. */
export function nextSpaceSnapshot<T extends { id: string }>(rooms: readonly T[], roomId: string, current: T | null): T | null {
  if (!roomId) return null;
  const match = rooms.find((item) => item.id === roomId);
  if (match) return { ...match };
  return current?.id === roomId ? current : null;
}

/** Step 8 reads this snapshot, including after the room leaves the vacant list. */
export function confirmSpaceFromSnapshot<T extends { id: string }>(roomId: string, snapshot: T | null): T | null {
  if (!roomId || snapshot?.id !== roomId) return null;
  return snapshot;
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
  const product = Number.isFinite(months) && Number.isFinite(rent) ? months * rent : Number.NaN;
  const major = currency === "TWD" ? Math.round(product) : product;
  const amount = Number.isFinite(major) ? format(major, currency, locale) : "";
  const monthsLabel = monthsRaw.trim();
  if (locale === "zh-TW") return amount ? `${monthsLabel} 個月（${amount}）` : `${monthsLabel} 個月`;
  const unit = months === 1 ? "month" : "months";
  return amount ? `${monthsLabel} ${unit} (${amount})` : `${monthsLabel} ${unit}`;
}
