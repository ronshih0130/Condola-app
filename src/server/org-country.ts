import { countryByCode, type CountryProfile } from "@/countries";
import { query } from "./db";

export async function loadOrgCountry(orgId: string): Promise<CountryProfile> {
  const row = await query<{ country_code: string | null; settings: { country?: string } | null }>(
    `SELECT country_code, settings FROM organizations WHERE id = $1`,
    [orgId],
  );
  const settings = row.rows[0]?.settings;
  const fromSettings = settings && typeof settings === "object" ? settings.country : "";
  return countryByCode(fromSettings || row.rows[0]?.country_code || "TW");
}
