import type { RepairRule, RepairStatus, RepairTurn } from "../server/b3-repair-turn-rules";

/**
 * MGT-150 / PLT-52 (TK-RELAY, TK-RELAY-MNT). Pure relay projection for /m/tickets/[id].
 * Inputs are already authorized by their readers. GS-44 = A: a state the approved frames do not
 * draw renders nothing (no relay, no line), and is named in `hidden` for the design batch.
 */
export type RelayParty = "t" | "m" | "o" | "v";
export type RelayStep = "report" | "dispatch" | "approve_estimate" | "re_estimate" | "do_repair" | "report_cost" | "confirm_cost";
export type RelaySub = { kind: "name"; text: string } | { kind: "you" } | { kind: "manager" } | { kind: "sent_back" };
export type RelayNode = { party: RelayParty; step: RelayStep; state: "done" | "now" | "next"; subs: RelaySub[] };
export type RelayWhy = "cost_pending" | "resolved_owner" | "resolved_vendor" | "emergency_open" | "emergency_back";
export type RelayHidden =
  | "snapshot_mismatch" | "done" | "manager_in_progress" | "blocked_reason" | "blocked_cost" | "cost_not_eligible"
  | "resolved_other" | "why_conflict" | "more_information_sub" | "lead_other" | "lead_cannot_act" | "lead_no_name"
  | "day_count" | "maintenance_status" | "dispatcher_name";
export type Decision = "approved" | "rejected" | "more_information";

export type EstimateFacts = {
  turn: Pick<RepairTurn, "rule" | "holder" | "step" | "sinceExact"> & { viewerCanAct: boolean };
  status: RepairStatus;
  /** Current estimate head from the existing manager approval view; null when approvals are OFF or no estimate exists. */
  current: { requiresOwner: boolean; decision: Decision | null; emergency: boolean } | null;
  /** Current active job reported a cost that is not confirmed. */
  pendingCost: boolean;
  names: { tenant: string | null; vendor: string | null; owner: string | null };
};
export type EstimateRelay = {
  nodes: RelayNode[] | null; why: RelayWhy | null;
  lead: { kind: "re_estimate"; owner: string } | null;
  /** For the aria label: who holds the current step. */
  now: { party: RelayParty; step: RelayStep; you: boolean; name: string | null } | null;
  hidden: RelayHidden[];
};

const name = (text: string | null | undefined): RelaySub[] => text?.trim() ? [{ kind: "name", text: text.trim() }] : [];
const TERMINAL: RepairRule[] = ["R1", "R4"];

/** Separate snapshots (turn gateway, approval view) must agree, or nothing is drawn. */
function consistent(f: EstimateFacts): boolean {
  const c = f.current, rule = f.turn.rule;
  // B3: an effective emergency is never an owner or re-estimate turn.
  const impliesR3 = !!c && c.requiresOwner && c.decision === null && !c.emergency;
  const impliesR5 = !!c && c.requiresOwner && (c.decision === "rejected" || c.decision === "more_information") && !c.emergency;
  if (rule === "R3") return impliesR3;
  if (rule === "R5") return impliesR5;
  // §3 first-match order: only R1 and R2 legitimately precede R3/R5. A later rule with a head that
  // implies R3/R5 means the head changed between the two reads (e.g. turn R7b, then a new
  // approval-needing estimate): never draw 廠 as current with 屋 dimmed.
  if (rule === "R1" || rule === "R2") return true;
  return !impliesR3 && !impliesR5;
}

/** MGT-150-AC1, AC3, AC4, AC5 (viewer with estimate access). */
export function estimateRelay(f: EstimateFacts): EstimateRelay {
  const hidden: RelayHidden[] = [];
  const out = (nodes: RelayNode[] | null, why: RelayWhy | null, lead: EstimateRelay["lead"]): EstimateRelay => {
    const now = nodes?.find(n => n.state === "now");
    return { nodes, why, lead, hidden, now: now ? { party: now.party, step: now.step,
      you: now.party === "m" && f.turn.viewerCanAct, name: now.subs.find(s => s.kind === "name")?.text ?? null } : null };
  };
  if (f.turn.sinceExact) hidden.push("day_count"); // PLT-53-AC5: never a day count here; no exact clock is drawn for the page.
  if (!consistent(f)) { hidden.push("snapshot_mismatch"); return out(null, null, null); }
  const { rule, step } = f.turn, c = f.current;
  const decided = !!c?.decision, showOwner = c?.requiresOwner === true;
  if (c?.decision === "more_information") hidden.push("more_information_sub");

  // Why-line candidates (MGT-150-AC3). At most one is shown; two at once is not drawn.
  const why: RelayWhy[] = [];
  if (f.pendingCost && (rule === "R3" || rule === "R5")) why.push("cost_pending");
  // A vendor cost report itself marks the ticket resolved, so the cost line takes precedence over
  // 「已標成已解決，但還在等屋主核准估價。」 for the same R3 (assumption, recorded for the design batch).
  if (f.status === "resolved" && rule === "R3" && !why.includes("cost_pending")) why.push("resolved_owner");
  if (f.status === "resolved" && rule === "R7a") why.push("resolved_vendor");
  if (c?.emergency && c.requiresOwner && c.decision === null && !TERMINAL.includes(rule)) why.push("emergency_open");
  if (c?.emergency && (c.decision === "rejected" || c.decision === "more_information") && !TERMINAL.includes(rule)) why.push("emergency_back");
  if (f.status === "resolved" && !TERMINAL.includes(rule) && !["R3", "R7a", "R2"].includes(rule)) hidden.push("resolved_other");
  if (rule === "R8-blocked") hidden.push(f.pendingCost ? "blocked_cost" : "blocked_reason");
  if (rule === "R2" && !f.turn.viewerCanAct) hidden.push("cost_not_eligible");
  if (why.length > 1) hidden.push("why_conflict");
  const line = why.length === 1 ? why[0] : null;

  if (TERMINAL.includes(rule)) { hidden.push("done"); return out(null, null, null); }
  const isDispatch = (rule === "R8" || rule === "R8-blocked") ? step === "dispatch" : rule === "R6";
  if ((rule === "R8" || rule === "R8-blocked") && step !== "dispatch") { hidden.push("manager_in_progress"); return out(null, null, null); }

  // 「你」 only on the CURRENT 管 step and only when this viewer can act on it (same rule as the
  // aria label and 「輪到你」); every other 管 step, done or upcoming, says 管理方 (Design Session
  // OQ-080 / batch 3 redraw: who dispatched is not attributed to a person).
  const mgr = (state: RelayNode["state"]): RelaySub[] =>
    state === "now" && f.turn.viewerCanAct ? [{ kind: "you" }] : [{ kind: "manager" }];
  const T: RelayNode = { party: "t", step: "report", state: "done", subs: name(f.names.tenant) };
  const ownerSubs: RelaySub[] = [...name(f.names.owner), ...(c?.decision === "rejected" ? [{ kind: "sent_back" } as const] : [])];
  const O = (state: RelayNode["state"]): RelayNode[] => showOwner ? [{ party: "o", step: "approve_estimate", state, subs: ownerSubs }] : [];
  const V = (state: RelayNode["state"], s: RelayStep = "do_repair"): RelayNode => ({ party: "v", step: s, state, subs: name(f.names.vendor) });
  const M1 = (state: RelayNode["state"]): RelayNode => ({ party: "m", step: "dispatch", state, subs: mgr(state) });
  const M2 = (state: RelayNode["state"]): RelayNode => ({ party: "m", step: "confirm_cost", state, subs: mgr(state) });
  const ownerState = decided ? "done" : "next";

  let nodes: RelayNode[];
  let lead: EstimateRelay["lead"] = null;
  if (rule === "R3") nodes = [T, M1("done"), ...O("now"), V("next"), M2("next")];
  else if (rule === "R5") {
    // The approved re-estimate frame: 屋 done (退回), 管 重新估價 now, then 廠 到場維修.
    nodes = [T, M1("done"), ...O("done"), { party: "m", step: "re_estimate", state: "now", subs: mgr("now") }, V("next")];
    if (!f.turn.viewerCanAct) hidden.push("lead_cannot_act");
    else if (!f.names.owner?.trim()) hidden.push("lead_no_name");
    else lead = { kind: "re_estimate", owner: f.names.owner.trim() };
  } else if (rule === "R2") nodes = [T, M1("done"), ...O(ownerState), V("done"), M2("now")];
  else if (rule === "R7a" || rule === "R7b") nodes = [T, M1("done"), ...O(ownerState), V("now", rule === "R7a" ? "report_cost" : "do_repair"), M2("next")];
  else if (isDispatch) nodes = [T, M1("now"), ...O(ownerState), V("next"), M2("next")];
  else { hidden.push("snapshot_mismatch"); return out(null, null, null); }
  if (rule !== "R5") hidden.push("lead_other");
  if (nodes.some(n => n.party === "m" && n.step === "dispatch" && n.state === "done")) hidden.push("dispatcher_name");
  return out(nodes, line, lead);
}

export type MaintenanceRelay = { status: RepairStatus; nodes: RelayNode[] | null; hidden: RelayHidden[] };
/**
 * MGT-150-AC2 / PLT-52-AC4 (TK-RELAY-MNT). The signature admits ONLY public ticket facts:
 * no owner, estimate, decision, emergency, event, flag or timing input exists to change it.
 * The marker follows the ticket's own status; no 屋 step; no timing; no why-line.
 */
export function maintenanceRelay(input: { status: RepairStatus; names: { tenant: string | null; vendor: string | null } }): MaintenanceRelay {
  const T: RelayNode = { party: "t", step: "report", state: "done", subs: name(input.names.tenant) };
  const V = (state: RelayNode["state"]): RelayNode => ({ party: "v", step: "do_repair", state, subs: name(input.names.vendor) });
  const M2: RelayNode = { party: "m", step: "confirm_cost", state: "next", subs: [{ kind: "manager" }] };
  if (input.status === "in_progress")
    return { status: input.status, hidden: [], nodes: [T, { party: "m", step: "dispatch", state: "done", subs: [] }, V("now"), M2] };
  if (input.status === "open" || input.status === "triaged")
    return { status: input.status, hidden: [], nodes: [T, { party: "m", step: "dispatch", state: "now", subs: [] }, V("next"), M2] };
  return { status: input.status, hidden: ["maintenance_status"], nodes: null };
}
