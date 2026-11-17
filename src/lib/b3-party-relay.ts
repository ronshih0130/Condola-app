import type { RelayNode, RelaySub } from "./b3-ticket-relay";

/**
 * PLT-52-AC6…AC10 (GS-59…GS-63 = A, Ron 2026-11-17 ~09:00 PT): the relay inside the owner's 核准估價 panel
 * (O-EST, O-EST-EMERG, O-EST-DONE-RELAY, O-EST-BACK-DONE) and the vendor's 這一案 (RV-RELAY, RV-RELAY-WAIT,
 * RV-RELAY-NONE). Pure: the callers pass facts their own admitted readers already proved. Step labels are the
 * TK-RELAY words; subs are roles or the company name, never a personal name (GS-43); no times and no day
 * counts (the owner DTO carries no exact clock, so 「第 n 天」 is never drawn — PLT-52-AC6 "only when exact").
 */
const company = (name: string | null | undefined): RelaySub[] => [name?.trim() ? { kind: "name", text: name.trim() } : { kind: "manager" }];

/** pending: panel opened from the owner's own 要你處理 row and the 核准 action is admitted (spec §6.2 amended). */
export type OwnerRelayState = { kind: "pending" } | { kind: "emergency" }
  | { kind: "decided"; decision: "approved" | "rejected" | "more_information" };

export function ownerEstimateRelay(state: OwnerRelayState, firm: string | null): RelayNode[] {
  const m = company(firm);
  const nodes: RelayNode[] = [
    { party: "t", step: "report", state: "done", subs: [{ kind: "tenant" }] },
    { party: "m", step: "dispatch", state: "done", subs: m },
  ];
  if (state.kind === "pending") nodes.push({ party: "o", step: "approve_estimate", state: "now", subs: [{ kind: "you" }] });
  // GS-60: the vendor may already be working; the owner cannot see it, so no step is current.
  else if (state.kind === "emergency") nodes.push({ party: "o", step: "approve_estimate", state: "next", subs: [], plain: true });
  else nodes.push({ party: "o", step: "approve_estimate", state: "done", subs: [
    state.decision === "approved" ? { kind: "approved" } : state.decision === "rejected" ? { kind: "sent_back" } : { kind: "more_info" }] });
  const handedBack = state.kind === "decided" && state.decision !== "approved";
  // GS-61: the next party gets the clock, never the navy pill; the owner cannot see its progress.
  if (handedBack) nodes.push({ party: "m", step: "re_estimate", state: "next", subs: m, wait: true });
  nodes.push({ party: "v", step: "do_repair", state: "next", subs: [{ kind: "vendor" }],
    wait: state.kind === "decided" && state.decision === "approved", plain: state.kind === "emergency" });
  nodes.push({ party: "m", step: "confirm_cost", state: "next", subs: m, plain: state.kind === "emergency" });
  return nodes;
}

/** The four vendor relays (spec §6.3 canonical rows). R7a is defined but not drawn yet (see vendorRelayDrawn). */
export type VendorRelayKind = "do_repair" | "report_cost" | "confirm_cost" | "dispatch";
type Turn = { state: "ready" | "restricted"; holder: string | null; step: string | null; viewerCanAct: boolean };

/**
 * PLT-52-AC9/AC10: only an admitted `ready` projection with one of the four exact holder/step pairs draws a relay.
 * Restricted (R3, R5, R8-blocked), unavailable, terminal (R1), R4, and the vendor's own step with viewerCanAct
 * false all return null: no relay, never an unmarked one.
 */
export function vendorRelayKind(turn: Turn | null | undefined): VendorRelayKind | null {
  if (!turn || turn.state !== "ready") return null;
  if (turn.holder === "vendor") {
    if (!turn.viewerCanAct) return null;
    return turn.step === "do_repair" ? "do_repair" : turn.step === "report_cost" ? "report_cost" : null;
  }
  if (turn.holder === "manager") return turn.step === "confirm_cost" ? "confirm_cost" : turn.step === "dispatch" ? "dispatch" : null;
  return null;
}

/**
 * R7a's approved frame pairs the relay with the 「開立費用文件」 primary and its lead, but that document page is
 * reached through its own document grant, not this job link; with no destination the frame cannot be drawn as
 * approved, so R7a shows no relay yet (GS-44; OPEN-QUESTIONS OQ-097).
 */
export const vendorRelayDrawn = (kind: VendorRelayKind | null): kind is Exclude<VendorRelayKind, "report_cost"> =>
  kind !== null && kind !== "report_cost";

export function vendorCaseRelay(kind: VendorRelayKind, firm: string | null): RelayNode[] {
  const m = company(firm);
  const vendorStep: RelayNode = kind === "do_repair" ? { party: "v", step: "do_repair", state: "now", subs: [{ kind: "you" }] }
    : kind === "report_cost" ? { party: "v", step: "report_cost", state: "now", subs: [{ kind: "you" }] }
    // R2: the vendor's step is done and handed over (clock, 「已送出」); the company holds 核對費用.
    : kind === "confirm_cost" ? { party: "v", step: "report_cost", state: "done", subs: [{ kind: "sent" }], wait: true }
    : { party: "v", step: "do_repair", state: "next", subs: [{ kind: "vendor" }] };
  return [
    { party: "t", step: "report", state: "done", subs: [{ kind: "tenant" }] },
    { party: "m", step: "dispatch", state: kind === "dispatch" ? "now" : "done", subs: m },
    vendorStep,
    { party: "m", step: "confirm_cost", state: kind === "confirm_cost" ? "now" : "next", subs: m },
  ];
}
