export type CountryCode = "TW";

export type CountryProfile = {
  code: CountryCode;
  nameKey: string;
  currency: "TWD" | "USD";
  callingCode: string;
  timezone: string;
  locale: "zh-TW" | "en";
  jurisdiction: string;
  areaUnit: "ping" | "sqft";
  offered: boolean;
};

/** Add a country here to offer it. Call sites read this list; they do not hard-code Taiwan. */
export const COUNTRIES: readonly CountryProfile[] = [
  {
    code: "TW",
    nameKey: "i_country_tw",
    currency: "TWD",
    callingCode: "+886",
    timezone: "Asia/Taipei",
    locale: "zh-TW",
    jurisdiction: "TW",
    areaUnit: "ping",
    offered: true,
  },
];

export function offeredCountries() {
  return COUNTRIES.filter((country) => country.offered);
}

export function countryByCode(code: string | null | undefined): CountryProfile {
  const normalized = (code ?? "").trim().toUpperCase();
  return COUNTRIES.find((country) => country.code === normalized) ?? COUNTRIES[0];
}

/** Keep an explicit settings.country. Fill it from the org country code when missing. */
export function withOrgCountry(settings: Record<string, unknown> | null | undefined, code: string) {
  const base = settings && typeof settings === "object" ? { ...settings } : {};
  if (typeof base.country === "string" && base.country.trim()) return base;
  return { ...base, country: countryByCode(code).code };
}
