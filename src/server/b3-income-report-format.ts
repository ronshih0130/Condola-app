import type { Locale } from "../i18n";
/** This schema uses hundredths for money. Do not pass bigint amounts through Number. */
export function reportMajor(minor: string) {
  const value = BigInt(minor), magnitude = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}${magnitude / BigInt(100)}.${(magnitude % BigInt(100)).toString().padStart(2, "0")}`;
}
export function reportMoney(minor: string, currency: string, locale: Locale) {
  const value = BigInt(minor), magnitude = value < BigInt(0) ? -value : value;
  const whole = new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-TW").format(magnitude / BigInt(100));
  const fraction = magnitude % BigInt(100);
  const symbol = currency === "TWD" ? "NT$" : `${currency} `;
  return `${value < BigInt(0) ? "−" : ""}${symbol}${whole}${fraction || currency !== "TWD" ? `.${fraction.toString().padStart(2, "0")}` : ""}`;
}
