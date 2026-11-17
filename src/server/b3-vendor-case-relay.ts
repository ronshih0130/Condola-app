import { brandV3ReadForOrg } from "./brand-v3";
import { loadVendorRepairTurnsOn } from "./b3-vendor-repair-turn";
import { loadVendorCase, vendorCaseStage } from "./b105-vendor-case";
import { svc } from "./db";
import { logServerError } from "./errors";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import { vendorRelayKind, type VendorRelayKind } from "../lib/b3-party-relay";

/**
 * PLT-52-AC9/AC10 (GS-62, GS-63): the relay kind for the vendor's 這一案, read in ONE writable REPEATABLE READ
 * snapshot (spec §6.3): token admission, brand_v3, capability, the M3 turn projection and the B-105 case all use
 * the same client. Only an `open` case with one of the four exact projections draws; anything else — OFF, not
 * admitted, restricted, terminal, a read failure or a snapshot disagreement — returns null and no relay is drawn.
 */
export async function loadVendorCaseRelay(token: string): Promise<VendorRelayKind | null> {
  if (!vendorTokenAcceptable(token)) return null;
  try {
    return await svc(null, async client => {
      const org = (await client.query<{ org_id: string }>(
        "SELECT org_id::text FROM app.open_vendor_job($1::text)", [hashVendorToken(token)])).rows[0]?.org_id;
      if (!org) return null;
      const on = await brandV3ReadForOrg(org, process.env, async id => (await client.query<{ v2: unknown; v3: unknown }>(
        "SELECT feature_flags->'brand_v2' v2,feature_flags->'brand_v3' v3 FROM public.organizations WHERE id=$1", [id])).rows[0]);
      if (!on) return null;
      const loaded = await loadVendorRepairTurnsOn(client, token, org);
      if (loaded.state !== "ready" || !loaded.job || !loaded.turn) return null;
      const read = await loadVendorCase(token, async (sql, params) =>
        (await client.query<{ r: unknown }>(sql, params)).rows[0]?.r ?? null);
      if (read?.state !== "ready" || vendorCaseStage(read.value) !== "open") return null;
      return vendorRelayKind(loaded.turn);
    }, { isolation: "repeatable read" });
  } catch (error) {
    logServerError("b3_vendor_case_relay", error);
    return null;
  }
}
