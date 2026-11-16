import type { RepairRule, RepairStatus, RepairTurn } from "../server/b3-repair-turn-rules";

/**
 * MGT-150 / PLT-52 (TK-RELAY, TK-RELAY-MNT; Round 7 batch 4: TK-RELAY-END, TK-RELAY-BLOCKED,
 * TK-WHY-RULE, TK-RELAY-MOREINFO, TK-RELAY-MNT-STATES). Pure relay projection for /m/tickets/[id].
 * Inputs are already authorized by their readers. GS-44 = A: a state the approved frames do not
 * draw renders nothing, and is named in `hidden` for the design batch.
 */
export type RelayParty = "t" | "m" | "o" | "v";
export type RelayStep = "report" | "dispatch" | "in_progress" | "approve_estimate" | "re_estimate" | "do_repair" | "report_cost" | "confirm_cost";
export type RelaySub = { kind: "name"; text: string } | { kind: "you" } | { kind: "manager" } | { kind: "sent_back" } | { kind: "more_info" };
export type RelayNode = { party: RelayParty; step: RelayStep; state: "done" | "now" | "next"; subs: RelaySub[] };
/** Grey end pill after the last step (TK-RELAY-END). Never a tick. */
export type RelayEnd = "resolved" | "closed" | "cancelled";
export type RelayWhy =
  | "blocked_declined" | "blocked_link"
  | "emergency_open" | "emergency_back"
  | "resolved_owner" | "resolved_vendor" | "resolved_vendor_repair" | "resolved_manager_cost" | "resolved_manager_redispatch"
  | "resolved_need_cost" | "resolved_need_redispatch"
  | "cost_pending";
export type RelayLead = { kind: "re_estimate" | "more_info" | "declined"; name: string };
export type RelayHidden =
  | "snapshot_mismatch" | "decline_reason" | "blocked_no_job" | "resolved_other"
  | "lead_other" | "lead_cannot_act" | "lead_no_name" | "day_count";
export type Decision = "approved" | "rejected" | "more_information";

export type EstimateFacts = {
  turn: Pick<RepairTurn, "rule" | "holder" | "step" | "sinceExact"> & { viewerCanAct: boolean };
  status: RepairStatus;
  /** Current estimate head from the existing manager approval view; null when approvals are OFF or no estimate exists. */
  current: { requiresOwner: boolean; decision: Decision | null; emergency: boolean;
    /** Latest vendor appointment event on the current version (B-021 manager view; not job-bound). */
    eventKind?: string | null; eventAt?: string | null } | null;
  /** Current active job reported a cost that is not confirmed. */
  pendingCost: boolean;
  /** Public job facts (RLS) for blocked and end states. */
  jobs?: { currentCreatedAt: string | null; any: boolean; latestRevoked: boolean; reported: boolean; confirmed: boolean };
  names: { tenant: string | null; vendor: string | null; owner: string | null };
};
export type EstimateRelay = {
  nodes: RelayNode[] | null; end: RelayEnd | null; why: RelayWhy | null; lead: RelayLead | null;
  /** For the aria label: who holds the current step. */
  now: { party: RelayParty; step: RelayStep; you: boolean; name: string | null } | null;
  hidden: RelayHidden[];
};

const name = (text: string | null | undefined): RelaySub[] => text?.trim() ? [{ kind: "name", text: text.trim() }] : [];
const TERMINAL: RepairRule[] = ["R1", "R4"];
const NO_JOBS = { currentCreatedAt: null, any: false, latestRevoked: false, reported: false, confirmed: false };

/** Separate snapshots (turn gateway, approval view) must agree, or nothing is drawn. */
function consistent(f: EstimateFacts): boolean {
  const c = f.current, rule = f.turn.rule;
  // B3: an effective emergency is never an owner or re-estimate turn.
  const impliesR3 = !!c && c.requiresOwner && c.decision === null && !c.emergency;
  const impliesR5 = !!c && c.requiresOwner && (c.decision === "rejected" || c.decision === "more_information") && !c.emergency;
  // The end pill comes from the ticket status read separately: a reopen between the reads must not draw a
  // closed/resolved relay on an open ticket (rules: R1 = closed|cancelled, R4 = resolved).
  if (rule === "R1") return f.status === "closed" || f.status === "cancelled";
  if (rule === "R4") return f.status === "resolved" && !impliesR3 && !impliesR5;
  if (f.status === "closed" || f.status === "cancelled") return false;
  if (rule === "R3") return impliesR3;
  if (rule === "R5") return impliesR5;
  // §3 first-match order: only R1 and R2 legitimately precede R3/R5. A later rule with a head that
  // implies R3/R5 means the head changed between the two reads (e.g. turn R7b, then a new
  // approval-needing estimate): never draw 廠 as current with 屋 dimmed.
  if (rule === "R2") return true;
  return !impliesR3 && !impliesR5;
}

/**
 * TK-RELAY-BLOCKED: why the vendor can't act. R6 is a job-bound rejection (spec §3). R8-blocked on
 * 派工 means no usable capability or a rejection: an event on the current version newer than the
 * current job's creation belongs to that job (one active job at a time); otherwise the link failed.
 */
function blockedKind(f: EstimateFacts, jobs: NonNullable<EstimateFacts["jobs"]>): "declined" | "link" | null {
  if (f.turn.rule === "R6") return "declined";
  if (f.turn.rule !== "R8-blocked" || f.turn.step !== "dispatch") return null;
  if (jobs.currentCreatedAt) {
    const at = f.current?.eventAt ? Date.parse(f.current.eventAt) : NaN;
    return f.current?.eventKind === "vendor_rejected" && at >= Date.parse(jobs.currentCreatedAt) ? "declined" : "link";
  }
  return jobs.any && jobs.latestRevoked ? "link" : null;
}

/** MGT-150-AC1…AC5 (viewer with estimate access). */
export function estimateRelay(f: EstimateFacts): EstimateRelay {
  const hidden: RelayHidden[] = [];
  const out = (nodes: RelayNode[] | null, why: RelayWhy | null, lead: RelayLead | null, end: RelayEnd | null = null): EstimateRelay => {
    const now = nodes?.find(n => n.state === "now");
    return { nodes, end, why, lead, hidden, now: now ? { party: now.party, step: now.step,
      you: now.party === "m" && f.turn.viewerCanAct, name: now.subs.find(s => s.kind === "name")?.text ?? null } : null };
  };
  // PLT-53-AC5 / TK-RELAY-END: the gateway never proves an exact clock, so no 「第 N 天」 is drawn.
  if (f.turn.sinceExact) hidden.push("day_count");
  if (!consistent(f)) { hidden.push("snapshot_mismatch"); return out(null, null, null); }
  const { rule, step } = f.turn, c = f.current, jobs = f.jobs ?? NO_JOBS, canAct = f.turn.viewerCanAct;
  const decided = !!c?.decision, showOwner = c?.requiresOwner === true;
  const blocked = blockedKind(f, jobs);
  const isDispatch = rule === "R6" || ((rule === "R8" || rule === "R8-blocked") && step === "dispatch");

  // TK-WHY-RULE: one line only, by priority blocked → 已緊急處理 → 已標成已解決 → 費用還不能核對.
  const why: (RelayWhy | null)[] = [];
  if (!TERMINAL.includes(rule)) {
    why.push(blocked === "declined" ? "blocked_declined" : blocked === "link" ? "blocked_link" : null);
    if (c?.emergency && c.requiresOwner && c.decision === null) why.push("emergency_open");
    if (c?.emergency && (c.decision === "rejected" || c.decision === "more_information")) why.push("emergency_back");
    if (f.status === "resolved") {
      const resolved: RelayWhy | null = rule === "R3" ? "resolved_owner" : rule === "R7a" ? "resolved_vendor"
        : rule === "R7b" ? "resolved_vendor_repair"
        : rule === "R2" ? canAct ? "resolved_need_cost" : "resolved_manager_cost"
        : isDispatch ? canAct ? "resolved_need_redispatch" : "resolved_manager_redispatch" : null;
      if (!resolved) hidden.push("resolved_other");
      why.push(resolved);
    }
    if (f.pendingCost && (rule === "R3" || rule === "R5" || rule === "R8-blocked")) why.push("cost_pending");
  }
  const line = why.find((w): w is RelayWhy => !!w) ?? null;
  if (blocked === "declined") hidden.push("decline_reason"); // the vendor's 「{原因}」 is not in any readable projection
  if (rule === "R8-blocked" && step === "dispatch" && !blocked) hidden.push("blocked_no_job");

  // 「你」 only on the CURRENT 管 step and only when this viewer can act on it; every other 管 step says 管理方.
  const mgr = (state: RelayNode["state"]): RelaySub[] => state === "now" && canAct ? [{ kind: "you" }] : [{ kind: "manager" }];
  const T: RelayNode = { party: "t", step: "report", state: "done", subs: name(f.names.tenant) };
  const ownerSubs: RelaySub[] = [...name(f.names.owner),
    ...(c?.decision === "rejected" ? [{ kind: "sent_back" } as const] : c?.decision === "more_information" ? [{ kind: "more_info" } as const] : [])];
  const O = (state: RelayNode["state"]): RelayNode[] => showOwner ? [{ party: "o", step: "approve_estimate", state, subs: ownerSubs }] : [];
  // A vendor who declined or lost the link is not shown as the next 廠 (frame: no name after 沒有接).
  const V = (state: RelayNode["state"], s: RelayStep = "do_repair"): RelayNode => ({ party: "v", step: s, state, subs: blocked ? [] : name(f.names.vendor) });
  const M = (s: RelayStep, state: RelayNode["state"]): RelayNode => ({ party: "m", step: s, state, subs: mgr(state) });
  const ownerState = decided ? "done" : "next";

  // TK-RELAY-END: closed/resolved show every step done, cancelled only the steps done before it; a grey end pill, no tick.
  if (rule === "R1" || rule === "R4") {
    let nodes: RelayNode[];
    if (f.status === "cancelled") nodes = [T, ...(jobs.any ? [M("dispatch", "done")] : []), ...(decided ? O("done") : []),
      ...(jobs.reported ? [V("done")] : []), ...(jobs.confirmed ? [M("confirm_cost", "done")] : [])];
    else if (rule === "R1") nodes = [T, M("dispatch", "done"), ...O("done"), V("done"), M("confirm_cost", "done")];
    else nodes = [T, M("dispatch", "done"), ...O("done"), V("done"), ...(jobs.confirmed ? [M("confirm_cost", "done")] : [])];
    return out(nodes, null, null, f.status === "cancelled" ? "cancelled" : rule === "R1" ? "closed" : "resolved");
  }

  let nodes: RelayNode[];
  let lead: RelayLead | null = null;
  const leadFor = (kind: RelayLead["kind"], who: string | null) => {
    if (!canAct) hidden.push("lead_cannot_act");
    else if (!who?.trim()) hidden.push("lead_no_name");
    else lead = { kind, name: who.trim() };
  };
  if (rule === "R3") nodes = [T, M("dispatch", "done"), ...O("now"), V("next"), M("confirm_cost", "next")];
  else if (rule === "R5") {
    // Approved re-estimate frames: 屋 done (退回 / 補資料), 管 重新估價 now, then 廠 到場維修.
    nodes = [T, M("dispatch", "done"), ...O("done"), M("re_estimate", "now"), V("next")];
    leadFor(c?.decision === "more_information" ? "more_info" : "re_estimate", f.names.owner);
  } else if (rule === "R2") nodes = [T, M("dispatch", "done"), ...O(ownerState), V("done"), M("confirm_cost", "now")];
  else if (rule === "R7a" || rule === "R7b") nodes = [T, M("dispatch", "done"), ...O(ownerState), V("now", rule === "R7a" ? "report_cost" : "do_repair"), M("confirm_cost", "next")];
  else if (isDispatch) {
    nodes = [T, M("dispatch", "now"), ...O(ownerState), V("next"), M("confirm_cost", "next")];
    if (blocked === "declined") leadFor("declined", f.names.vendor);
  } else if (rule === "R8" || rule === "R8-blocked") {
    // Manager-held (TK-RELAY-END): the 管 step reads 處理中 instead of 派工, then 廠 and 管 核對費用 as usual.
    nodes = [T, M("in_progress", "now"), ...O(ownerState), V("next"), M("confirm_cost", "next")];
  } else { hidden.push("snapshot_mismatch"); return out(null, null, null); }
  if (!lead && !hidden.some(h => h.startsWith("lead_"))) hidden.push("lead_other");
  return out(nodes, line, lead);
}

/** TK-RELAY-MNT-STATES: the approved progress words for the maintenance head 「狀態：{狀態}」. */
export type MaintenanceStatusWord = "awaiting_dispatch" | "dispatched" | "in_progress" | "on_hold" | "resolved" | "closed" | "cancelled";
export const MAINTENANCE_STATUS_WORD: Record<RepairStatus, MaintenanceStatusWord> = {
  open: "awaiting_dispatch", triaged: "awaiting_dispatch", assigned: "dispatched", in_progress: "in_progress",
  on_hold: "on_hold", resolved: "resolved", closed: "closed", cancelled: "cancelled",
};
export type MaintenanceRelay = { status: RepairStatus; word: MaintenanceStatusWord; nodes: RelayNode[]; end: RelayEnd | null; hidden: RelayHidden[] };
/**
 * MGT-150-AC2 / PLT-52-AC4 (TK-RELAY-MNT, TK-RELAY-MNT-STATES). The signature admits ONLY public
 * ticket facts: no owner, estimate, decision, emergency, job, event, flag or timing input exists to
 * change it. The relay follows the ticket's own status; no 屋 step; no timing; no why-line.
 */
export function maintenanceRelay(input: { status: RepairStatus; names: { tenant: string | null; vendor: string | null } }): MaintenanceRelay {
  const T: RelayNode = { party: "t", step: "report", state: "done", subs: name(input.names.tenant) };
  const M = (step: RelayStep, state: RelayNode["state"]): RelayNode => ({ party: "m", step, state, subs: [{ kind: "manager" }] });
  const V = (state: RelayNode["state"]): RelayNode => ({ party: "v", step: "do_repair", state, subs: name(input.names.vendor) });
  const word = MAINTENANCE_STATUS_WORD[input.status];
  const make = (nodes: RelayNode[], end: RelayEnd | null = null): MaintenanceRelay => ({ status: input.status, word, nodes, end, hidden: [] });
  switch (input.status) {
    case "open": case "triaged": return make([T, M("dispatch", "now"), V("next"), M("confirm_cost", "next")]);
    case "assigned": case "in_progress": case "on_hold": return make([T, M("dispatch", "done"), V("now"), M("confirm_cost", "next")]);
    case "resolved": return make([T, M("dispatch", "done"), V("done")], "resolved");
    case "closed": return make([T, M("dispatch", "done"), V("done"), M("confirm_cost", "done")], "closed");
    case "cancelled": return make([T], "cancelled");
  }
}
