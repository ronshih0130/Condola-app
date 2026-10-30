import type { Client } from "pg";
import { one } from "./db";
import { importErrorDetailsEnabled } from "./import-feature";
import { resolveImportRegion, type ImportRegionRecord } from "./import-region";

/** Read canonical context inside each scoped API transaction. This is an as-of read;
 * managers do not gain organization UPDATE authority merely to import rows. */
export async function loadImportRegion(client: Client, orgId: string) {
  if (process.env.IMPORT_ERROR_DETAILS_ENABLED !== "true") return null;
  const org = await one<ImportRegionRecord & { feature_flags: unknown }>(client,
    `SELECT o.country_code, coalesce(o.jurisdiction_id, j.id)::text AS jurisdiction_id,
            j.code AS jurisdiction_code, j.country_code AS jurisdiction_country,
            o.default_currency, o.timezone, o.feature_flags
       FROM organizations o
       LEFT JOIN jurisdictions j ON (o.jurisdiction_id = j.id OR
         (o.jurisdiction_id IS NULL AND j.code = o.country_code::text))
      WHERE o.id = $1`, [orgId]);
  if (!importErrorDetailsEnabled(process.env.IMPORT_ERROR_DETAILS_ENABLED, org.feature_flags)) return null;
  return resolveImportRegion(org);
}
