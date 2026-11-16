/** B-070 3b §3 / PLT-52/53. Pure first-match partition; inputs are already authorized. */
export type RepairStatus = "open" | "triaged" | "assigned" | "in_progress" | "on_hold" | "resolved" | "closed" | "cancelled";
export type RepairRule = "R1" | "R2" | "R3" | "R5" | "R6" | "R7a" | "R7b" | "R8-blocked" | "R4" | "R8";
export type RepairHolder = "manager" | "owner" | "vendor" | "none";
export type RepairStep = "done" | "confirm_cost" | "approve_estimate" | "re_estimate" | "dispatch" | "report_cost" | "do_repair" | "in_progress";
export type RepairEvent = "none" | "vendor_proposed" | "company_confirmed" | "vendor_rejected" | "vendor_completion_submitted";
export type RepairTurnInput = {
  status: RepairStatus; approvals: boolean; dispatch: boolean; currentJob: boolean; capability: boolean;
  dispatchAllowed: boolean; retainedEstimate: boolean; requiresOwner: boolean;
  decision: "approved" | "rejected" | "more_information" | null; emergency: boolean;
  reported: boolean; confirmed: boolean; event: RepairEvent;
  submittedAt?: string | null; decidedAt?: string | null; authorizedAt?: string | null;
  reportedAt?: string | null; eventAt?: string | null; jobCreatedAt?: string | null;
  sharingApprovedAt?: string | null; sharingRequired?: boolean; resolvedAt?: string | null; fallbackAt?: string | null;
  /** Must be proven by the caller, not inferred from an immutable timestamp alone. */
  uninterrupted?: boolean;
};
export type RepairTurn = { rule: RepairRule; holder: RepairHolder; step: RepairStep; since: string | null; sinceExact: boolean };
function extreme(values: (string | null | undefined)[], direction: "min" | "max"): string | null {
  const dates = values.filter((x): x is string => !!x && Number.isFinite(Date.parse(x)));
  return dates.sort((a, b) => (Date.parse(a) - Date.parse(b)) * (direction === "min" ? 1 : -1))[0] ?? null;
}
export function repairTurn(i: RepairTurnInput): RepairTurn {
  const D = i.dispatch, J = i.currentJob, E = i.approvals && i.emergency;
  const A = i.approvals ? D && i.dispatchAllowed : D && !i.retainedEstimate;
  const C = !i.retainedEstimate || (i.approvals && D && i.dispatchAllowed);
  const P = J && i.reported && !i.confirmed, U = J && !i.confirmed;
  const event = D && i.approvals ? i.event : "none";
  const W = J && D && i.capability && A && C;
  const make = (rule: RepairRule, holder: RepairHolder, step: RepairStep, since?: string | null, exact = true): RepairTurn =>
    ({ rule, holder, step, since: since ?? null, sinceExact: !!since && exact && i.uninterrupted === true });
  if (i.status === "closed" || i.status === "cancelled") return make("R1", "none", "done", null, false);
  if (P && D && C) return make("R2", "manager", "confirm_cost", i.reportedAt);
  if (i.approvals && i.requiresOwner && !i.decision && !E) return make("R3", "owner", "approve_estimate", i.submittedAt);
  if (i.approvals && (i.decision === "rejected" || i.decision === "more_information") && !E)
    return make("R5", "manager", "re_estimate", i.decidedAt);
  if (J && D && A && C && event === "vendor_rejected") return make("R6", "manager", "dispatch", i.eventAt);
  if (W && U && !i.reported && event === "vendor_completion_submitted") return make("R7a", "vendor", "report_cost", i.eventAt);
  if (W && U && !i.reported) return make("R7b", "vendor", "do_repair", extreme([
    i.jobCreatedAt, i.sharingRequired ? i.sharingApprovedAt : null, i.approvals ? extreme([E ? i.authorizedAt : null,
      i.decision === "approved" ? i.decidedAt : null, !i.requiresOwner ? i.submittedAt : null], "min") : null,
  ], "max"), false);
  if (P || (U && !W) || (E && !J)) return make("R8-blocked", "manager",
    D && (!J || !i.capability || event === "vendor_rejected") ? "dispatch" : "in_progress", i.fallbackAt, false);
  if (i.status === "resolved") return make("R4", "none", "done", i.resolvedAt, false);
  return make("R8", "manager", i.status === "open" || i.status === "triaged" ? "dispatch" : "in_progress", i.fallbackAt, false);
}
/** External projection never manufactures a holder from report/event booleans. */
export function vendorRepairTurn(turn: RepairTurn) {
  if (["R3", "R5", "R8-blocked", "R8"].includes(turn.rule))
    return { state: "restricted" as const, holder: null, step: null, viewerCanAct: false };
  return { state: "ready" as const, holder: turn.holder, step: turn.step, viewerCanAct: turn.rule === "R7a" || turn.rule === "R7b" };
}
