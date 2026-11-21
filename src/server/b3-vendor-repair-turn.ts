import type { Client } from "pg";
import { brandV3ReadForOrg } from "./brand-v3";
import { svc } from "./db";
import { logServerError } from "./errors";
import { loadVendorJob, loadVendorJobOn, type OpenJob, type VendorJobPage } from "./vendor-repair";
import { resolveVendorJobState, resolveVendorJobStateOn, type VendorJobState } from "./vendor-job";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import type { RepairEvent, RepairHolder, RepairStep } from "./b3-repair-turn-rules";
export type VendorRepairTurn = { state: "ready" | "restricted"; holder: RepairHolder | null; step: RepairStep | null;
  viewerCanAct: boolean; dispatchAllowed: boolean; currentEvent: RepairEvent };
export type VendorRepairLoad = { state: "unavailable" } | { state: "ready"; job: VendorJobPage | null;
  turn: VendorRepairTurn | null; legacyState?: VendorJobState | null; actionState?: VendorJobState | null };
/**
 * V-TOKEN loader API, deliberately not wired into gated UI. OFF keeps the legacy loaders.
 * The outside lookup routes the flag only; ON repeats everything on one writable RR client.
 * No openJob/forgetClosedSecret call occurs on the ON path.
 */
export async function loadVendorRepairTurns(token: string): Promise<VendorRepairLoad> {
  if (!vendorTokenAcceptable(token)) return { state: "ready", job: null, turn: null };
  try {
    const hash = hashVendorToken(token);
    const org = await svc(null, async client => (await client.query<{ org_id: string }>(
      "SELECT org_id::text FROM app.open_vendor_job($1::text)", [hash])).rows[0]);
    if (!org) return { state: "ready", job: null, turn: null };
    if (!(await brandV3ReadForOrg(org.org_id))) {
      const job = await loadVendorJob(token);
      const allowed = job && (!job.vendorLink || (job.vendorLink.sharingApproved && job.vendorLink.capability === "write"));
      return { state: "ready", job, turn: null, legacyState: allowed ? await resolveVendorJobState(token) : null };
    }
    return await svc(null, client => loadVendorRepairTurnsOn(client, token, org.org_id), { isolation: "repeatable read" });
  } catch (error) {
    logServerError("b3_vendor_repair_turn", error);
    return { state: "unavailable" };
  }
}

/** Internal: complete ON read on caller's writable RR transaction. Barrier supports real two-connection tests. */
export async function loadVendorRepairTurnsOn(client: Client, token: string, orgId: string,
  afterCapability?: () => Promise<void>): Promise<VendorRepairLoad> {
  const hash = hashVendorToken(token);

  await client.query("SET LOCAL statement_timeout = '2s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  const opened = (await client.query<OpenJob>(
    "SELECT job_id::text,org_id::text,ticket_id::text,vendor_name,contact_window,expires_at::text,reported_at::text,reported_cost_minor::text FROM app.open_vendor_job($1::text)", [hash])).rows[0];
  if (!opened || opened.org_id !== orgId) throw new Error("Vendor admission changed");
  const on = await brandV3ReadForOrg(opened.org_id, process.env, async id => (await client.query<{ v2: unknown; v3: unknown }>(
    "SELECT feature_flags->'brand_v2' v2,feature_flags->'brand_v3' v3 FROM public.organizations WHERE id=$1", [id])).rows[0]);
  if (!on) throw new Error("Vendor presentation changed");
  const job = await loadVendorJobOn(client, token, opened);
  if (!job) return { state: "ready" as const, job: null, turn: null };
  if (job.vendorLink && (!job.vendorLink.sharingApproved || job.vendorLink.capability !== "write"))
    return { state: "ready" as const, job, turn: null };
  await afterCapability?.();
  const turn = (await client.query<{ turn: VendorRepairTurn | null }>(
    "SELECT app.b3_vendor_repair_turn($1::text) AS turn", [hash])).rows[0]?.turn;
  if (!turn || Date.parse(opened.expires_at) <= Date.now()) throw new Error("Vendor admission changed");
  const actionState = await resolveVendorJobStateOn(client, token);
  if (Date.parse(opened.expires_at) <= Date.now()) throw new Error("Vendor admission changed");
  // Explicit allowlist: never spread the gateway or an internal action DTO to a browser.
  return { state: "ready" as const, job, actionState: actionState ? { ...actionState,
    currentEvent: turn.currentEvent, dispatchAllowed: turn.dispatchAllowed, locked: !turn.dispatchAllowed } : null,
    turn: { state: turn.state, holder: turn.holder, step: turn.step,
    viewerCanAct: turn.viewerCanAct, dispatchAllowed: turn.dispatchAllowed, currentEvent: turn.currentEvent } };

}
