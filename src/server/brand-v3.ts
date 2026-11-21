import { cache } from "react";
import { brandV2Enabled, brandV2EnabledForOrg } from "./brand-v2";

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

/**
 * Same rule as brandV3EnabledForOrg (effective v2 — env BRAND_V2 or the org's brand_v2 — and the
 * org's brand_v3 === true), but a failed read THROWS instead of answering "off". Pages use the
 * fail-closed helper above; data readers use this one so a lookup failure becomes "unavailable",
 * never a silent "off" (Brand 3.0 phase 2 spec §6 failure contract).
 */
export async function brandV3ReadForOrg(
  orgId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  lookup: (orgId: string) => Promise<{ v2: unknown; v3: unknown } | undefined> = readOrgBrandFlags,
): Promise<boolean> {
  if (!orgId) return false;
  const flags = await lookup(orgId);
  return (brandV2Enabled(env) || flags?.v2 === true) && flags?.v3 === true;
}

async function readOrgBrandFlags(orgId: string) {
  const { query } = await import("./db");
  const { rows } = await query<{ v2: unknown; v3: unknown }>(
    "SELECT feature_flags -> 'brand_v2' AS v2, feature_flags -> 'brand_v3' AS v3 FROM public.organizations WHERE id = $1",
    [orgId],
  );
  return rows[0];
}
