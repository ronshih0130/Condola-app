import type { Client } from "pg";
import { guardEffectiveSession } from "./b017-custom-role-governance";
import { brandV3ReadForOrg } from "./brand-v3";
import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";
import type { RepairTurn } from "./b3-repair-turn-rules";

export type RepairMatter = RepairTurn & { ticketId: string; viewerCanAct: boolean; timezone: string; place: string };
export type RepairCursor = { since: string | null; ticketId: string };
export type RepairOptions = { ticketId?: string; group?: "mine" | "others"; after?: RepairCursor; limit?: number };
export type StaffRepairTurns = { state: "off" | "unavailable" } | {
  state: "ready"; projection?: "maintenance";
  counts: { holder: RepairTurn["holder"]; step: RepairTurn["step"]; canAct: boolean; count: number }[];
  yourTurn: number; mine: RepairMatter[]; others: RepairMatter[];
  next: { mine: RepairCursor | null; others: RepairCursor | null };
  detail: RepairMatter | { ticketId: string; status: string; holder: null; step: null; viewerCanAct: false; since: null; sinceExact: false } | null;
};
type Deps = { v3?: typeof brandV3ReadForOrg; transaction?: typeof svc };
/** MGT-125/126, PLT-53. Counts and pages are computed by one admitted SQL snapshot. */
/** svc/tx rethrow DB errors through mapDbError, which keeps the SQLSTATE in `cause.code`. */
export function sqlDenied(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "42501" || e?.cause?.code === "42501";
}

type Admitted = { admitted: Session; scope: { orgId: string; environment: Session["environment"] } };
/** Admission shared by every staff repair read; the gateway repeats it inside the snapshot. */
async function admitStaffRepairs(session: Session, options: RepairOptions): Promise<Admitted> {
  const admitted = await guardEffectiveSession(session, "tickets.update");
  assertPerm(admitted, "tickets.update");
  if (admitted.kind !== "staff" || admitted.needsSandbox || !["admin", "manager", "maintenance"].includes(admitted.role ?? ""))
    throw new FlowError("errors.forbidden");
  if ((options.ticketId !== undefined && !isUuid(options.ticketId)) ||
    (options.group !== undefined && !["mine", "others"].includes(options.group)) ||
    (options.after && (!options.group || !isUuid(options.after.ticketId) ||
      (options.after.since !== null && !Number.isFinite(Date.parse(options.after.since))))) ||
    (options.limit !== undefined && !Number.isFinite(options.limit))) throw new FlowError("errors.required");
  const scope = requireOrgScope(admitted);
  if (!("orgId" in scope)) throw new FlowError("errors.forbidden");
  return { admitted, scope: { orgId: scope.orgId, environment: scope.environment ?? admitted.environment } };
}
async function beginRepairSnapshot(client: Client, scope: Admitted["scope"]) {
  await client.query("SET LOCAL statement_timeout = '2s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [scope.orgId, scope.environment]);
}
async function repairSnapshotPage(client: Client, admitted: Session, options: RepairOptions): Promise<Extract<StaffRepairTurns, { state: "ready" }>> {
  const row = (await client.query<{ result: StaffRepairTurns }>(
    "SELECT app.b3_staff_repair_turns($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::text,$8::jsonb,$9::integer) AS result",
    [admitted.orgId, admitted.liveOrgId, admitted.environment, admitted.userId, admitted.sessionId,
      options.ticketId ?? null, options.group ?? null, options.after ?? null, Math.max(1, Math.min(50, Math.trunc(options.limit ?? 50)))],
  )).rows[0];
  if (!row?.result || row.result.state !== "ready") throw new Error("Missing repair snapshot");
  return row.result;
}
function repairReadFailure(error: unknown): { state: "unavailable" } {
  if (error instanceof FlowError && ["errors.forbidden", "errors.required"].includes(error.key)) throw error;
  if (sqlDenied(error)) throw new FlowError("errors.forbidden");
  logServerError("b3_staff_repair_turns", error);
  return { state: "unavailable" };
}

export async function staffRepairTurns(session: Session, options: RepairOptions = {}, deps: Deps = {}): Promise<StaffRepairTurns> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return { state: "off" };
    const { admitted, scope } = await admitStaffRepairs(session, options);
    return await (deps.transaction ?? svc)(admitted.userId, async client => {
      await beginRepairSnapshot(client, scope);
      return repairSnapshotPage(client, admitted, options);
    }, { isolation: "repeatable read" });
  } catch (error) {
    return repairReadFailure(error);
  }
}

/** MGT-149-AC4 (Design Session 2026-11-16): 輪到你 repair rows sort by step first. */
export const REPAIR_MINE_STEPS: readonly RepairTurn["step"][] = ["confirm_cost", "dispatch", "re_estimate", "in_progress"];
/** Every 輪到你 page is read in one snapshot; past this many pages Today fails honestly instead of mis-ordering. */
export const REPAIR_TODAY_MAX_PAGES = 20;
export function repairStepRank(step: RepairTurn["step"]): number {
  const rank = REPAIR_MINE_STEPS.indexOf(step);
  return rank < 0 ? REPAIR_MINE_STEPS.length : rank;
}
/** Step, then exact waits oldest first, then approximate waits by their approximate time, then ticket id. */
export function compareRepairMine(a: RepairMatter, b: RepairMatter): number {
  const time = (m: RepairMatter) => (m.since && Number.isFinite(Date.parse(m.since)) ? Date.parse(m.since) : Infinity);
  return repairStepRank(a.step) - repairStepRank(b.step) || Number(b.sinceExact) - Number(a.sinceExact)
    || (time(a) === time(b) ? 0 : time(a) < time(b) ? -1 : 1) || (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0);
}
/**
 * 今天 repair source (MGT-149). The gateway pages 輪到你 by date; step-first order needs every 輪到你 matter,
 * so all pages are read on the same repeatable-read client (one snapshot, counts unchanged), then the first 50
 * by step are kept. 等別人 keeps the gateway's date order and first page.
 */
export async function staffRepairTodayTurns(session: Session, deps: Deps = {}): Promise<StaffRepairTurns> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return { state: "off" };
    const { admitted, scope } = await admitStaffRepairs(session, {});
    return await (deps.transaction ?? svc)(admitted.userId, async client => {
      await beginRepairSnapshot(client, scope);
      const first = await repairSnapshotPage(client, admitted, {});
      if (first.projection === "maintenance") return { ...first, mine: [], others: [], next: { mine: null, others: null } };
      const mine = [...first.mine];
      let after = first.next.mine, pages = 1;
      while (after) {
        if (++pages > REPAIR_TODAY_MAX_PAGES) throw new Error("Repair turns exceed the Today page bound");
        const page = await repairSnapshotPage(client, admitted, { group: "mine", after });
        mine.push(...page.mine); after = page.next.mine;
      }
      if (mine.length !== first.yourTurn || new Set(mine.map(m => m.ticketId)).size !== mine.length) throw new Error("Repair snapshot pages disagree");
      return { ...first, mine: mine.sort(compareRepairMine).slice(0, 50), next: { mine: null, others: first.next.others } };
    }, { isolation: "repeatable read" });
  } catch (error) {
    return repairReadFailure(error);
  }
}
