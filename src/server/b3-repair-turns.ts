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
export async function staffRepairTurns(session: Session, options: RepairOptions = {}, deps: Deps = {}): Promise<StaffRepairTurns> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return { state: "off" };
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
    return await (deps.transaction ?? svc)(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [scope.orgId, scope.environment]);
      const row = (await client.query<{ result: StaffRepairTurns }>(
        "SELECT app.b3_staff_repair_turns($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::text,$8::jsonb,$9::integer) AS result",
        [admitted.orgId, admitted.liveOrgId, admitted.environment, admitted.userId, admitted.sessionId,
          options.ticketId ?? null, options.group ?? null, options.after ?? null, Math.max(1, Math.min(50, Math.trunc(options.limit ?? 50)))],
      )).rows[0];
      if (!row?.result || row.result.state !== "ready") throw new Error("Missing repair snapshot");
      return row.result;
    }, { isolation: "repeatable read" });
  } catch (error) {
    if (error instanceof FlowError && ["errors.forbidden", "errors.required"].includes(error.key)) throw error;
    if ((error as { code?: string })?.code === "42501") throw new FlowError("errors.forbidden");
    logServerError("b3_staff_repair_turns", error);
    return { state: "unavailable" };
  }
}
