import { cache } from "react";
import { brandV2EnabledForOrg } from "./brand-v2";

const readOrgBrandV3Flag = cache(async (orgId: string): Promise<unknown> => {
  const { query } = await import("./db");
  const { rows } = await query<{ flag: unknown }>(
    "SELECT feature_flags -> 'brand_v3' AS flag FROM public.organizations WHERE id = $1",
    [orgId],
  );
  return rows[0]?.flag;
});

/** Presentation only: exact organization opt-in, on top of effective v2. */
export async function brandV3EnabledForOrg(
  orgId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  lookupV3: (orgId: string) => Promise<unknown> = readOrgBrandV3Flag,
  v2: typeof brandV2EnabledForOrg = brandV2EnabledForOrg,
): Promise<boolean> {
  if (!orgId) return false;
  try {
    return (await v2(orgId, env)) && (await lookupV3(orgId)) === true;
  } catch {
    return false;
  }
}
