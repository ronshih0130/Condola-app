import { guardEffectiveSession, withEffectiveReadAuthority, effectiveReadOptions } from "./b017-custom-role-governance";
import { staffRepairTurns, type StaffRepairTurns } from "./b3-repair-turns";
import type { RepairStatus } from "./b3-repair-turn-rules";
import { maybe, tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import { managerApprovalView, type ManagerApprovalRow } from "./repair-approval";
import { isUuid } from "./repair-rules";
import { displaySampleName } from "./sandbox-data";
import type { Session } from "./types";
import { estimateRelay, maintenanceRelay, type Decision, type EstimateRelay, type MaintenanceRelay } from "../lib/b3-ticket-relay";

export type TicketRelay =
  | { state: "off" | "unavailable" | "forbidden" }
  | { state: "ready"; view: "estimate"; relay: EstimateRelay }
  | { state: "ready"; view: "maintenance"; relay: MaintenanceRelay };

type PublicFacts = { tenant: string | null; vendor: string | null };
type EstimateRead = PublicFacts & { status: RepairStatus; pendingCost: boolean; owner: string | null };
type Deps = {
  turns?: (session: Session, options: { ticketId: string }) => Promise<StaffRepairTurns>;
  approvals?: (session: Session, input: { ticketId: string }) => Promise<ManagerApprovalRow[]>;
  publicFacts?: (session: Session, ticketId: string) => Promise<PublicFacts | null>;
  estimateFacts?: (session: Session, ticketId: string, decidedBy: string | null) => Promise<EstimateRead | null>;
};
const STATUSES: RepairStatus[] = ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"];
const DECISIONS: Decision[] = ["approved", "rejected", "more_information"];

/** Reporter and vendor names only: facts already on the ticket page for every tickets.update viewer. */
async function readPublicFacts(input: Session, ticketId: string): Promise<PublicFacts | null> {
  const session = await guardEffectiveSession(input, "tickets.update");
  assertPerm(session, "tickets.update");
  return tx(session.userId, client => withEffectiveReadAuthority(client, session, "tickets.update", () =>
    maybe<PublicFacts>(client, `SELECT rc.display_name AS tenant, t.vendor_name AS vendor
       FROM maintenance_tickets t
       LEFT JOIN contacts rc ON rc.org_id = t.org_id AND rc.id = t.reported_by_contact_id
      WHERE t.org_id = $1 AND t.id = $2`, [session.orgId, ticketId])),
  requireOrgScope(session), effectiveReadOptions(session));
}

/**
 * Estimate viewers only (never called for maintenance): ticket status, whether the current job's
 * reported cost is unconfirmed, and the owner's display name: the decider when a decision exists,
 * otherwise the property's first current owner (the same choice submit_estimate designates).
 */
async function readEstimateFacts(input: Session, ticketId: string, decidedBy: string | null): Promise<EstimateRead | null> {
  const session = await guardEffectiveSession(input, "tickets.update");
  assertPerm(session, "tickets.update");
  // Estimate facts are for native admin/manager only (the b013_manager_view ceiling), never maintenance.
  const native = session.customRole?.nativeRole ?? session.role;
  if (session.kind !== "staff" || !native || !["admin", "manager"].includes(native)) throw new FlowError("errors.forbidden");
  return tx(session.userId, client => withEffectiveReadAuthority(client, session, "tickets.update", () =>
    maybe<EstimateRead>(client, `SELECT t.status::text AS status, coalesce(j.vendor_name, t.vendor_name) AS vendor,
         rc.display_name AS tenant,
         coalesce(j.id IS NOT NULL AND j.reported_at IS NOT NULL AND j.confirmed_at IS NULL, false) AS "pendingCost",
         CASE WHEN $3::uuid IS NOT NULL THEN
           (SELECT c.display_name FROM property_owners po
              JOIN contacts c ON c.org_id = po.org_id AND c.id = po.owner_contact_id
             WHERE po.org_id = t.org_id AND po.property_id = t.property_id AND c.is_owner AND c.user_id = $3::uuid
             ORDER BY po.id LIMIT 1)
         ELSE
           (SELECT c.display_name FROM property_owners po
              JOIN contacts c ON c.org_id = po.org_id AND c.id = po.owner_contact_id
              JOIN organizations o ON o.id = po.org_id
             WHERE po.org_id = t.org_id AND po.property_id = t.property_id AND c.is_owner AND c.archived_at IS NULL
               AND c.user_id IS NOT NULL AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
               AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
             ORDER BY po.id LIMIT 1)
         END AS owner
       FROM maintenance_tickets t
       LEFT JOIN contacts rc ON rc.org_id = t.org_id AND rc.id = t.reported_by_contact_id
       LEFT JOIN repair_vendor_jobs j ON j.org_id = t.org_id AND j.ticket_id = t.id AND j.active AND j.revoked_at IS NULL
      WHERE t.org_id = $1 AND t.id = $2`, [session.orgId, ticketId, decidedBy])),
  requireOrgScope(session), effectiveReadOptions(session));
}

const clean = (value: string | null | undefined) => value?.trim() ? displaySampleName(value.trim()) : null;

/**
 * MGT-150 (TK-RELAY, TK-RELAY-MNT). Admission is the 3b staff snapshot (brandV3ReadForOrg, then
 * guardEffectiveSession + assertPerm('tickets.update'), then the gateway's own B-017/B-013 checks).
 * The maintenance branch reads only the gateway's status projection and public ticket names; it
 * never calls the approval view or the estimate facts read, so hidden state cannot reach it.
 */
export async function loadTicketRelay(session: Session, ticketId: string, deps: Deps = {}): Promise<TicketRelay> {
  if (!isUuid(ticketId)) return { state: "forbidden" };
  try {
    const turns = await (deps.turns ?? staffRepairTurns)(session, { ticketId });
    if (turns.state !== "ready") return { state: turns.state };
    const detail = turns.detail;
    // Unknown or cross-org ticket: no existence leak.
    if (!detail || String(detail.ticketId).toLowerCase() !== ticketId.toLowerCase()) return { state: "forbidden" };
    if (turns.projection === "maintenance") {
      if (!("status" in detail) || !STATUSES.includes(detail.status as RepairStatus)) return { state: "unavailable" };
      const facts = await (deps.publicFacts ?? readPublicFacts)(session, ticketId);
      if (!facts) return { state: "forbidden" };
      return { state: "ready", view: "maintenance", relay: maintenanceRelay({ status: detail.status as RepairStatus,
        names: { tenant: clean(facts.tenant), vendor: clean(facts.vendor) } }) };
    }
    if (!("rule" in detail)) return { state: "unavailable" };
    const rows = await (deps.approvals ?? managerApprovalView)(session, { ticketId });
    const head = rows.filter(r => r.is_current);
    if (head.length > 1) return { state: "unavailable" };
    const current = head[0] ?? null;
    if (current && current.decision !== null && !DECISIONS.includes(current.decision as Decision)) return { state: "unavailable" };
    const facts = await (deps.estimateFacts ?? readEstimateFacts)(session, ticketId,
      current?.decision && current.decided_by && isUuid(current.decided_by) ? current.decided_by : null);
    if (!facts) return { state: "forbidden" };
    if (!STATUSES.includes(facts.status)) return { state: "unavailable" };
    return { state: "ready", view: "estimate", relay: estimateRelay({
      turn: { rule: detail.rule, holder: detail.holder, step: detail.step, sinceExact: detail.sinceExact, viewerCanAct: detail.viewerCanAct },
      status: facts.status,
      current: current ? { requiresOwner: current.requires_owner_decision === true, decision: (current.decision as Decision | null) ?? null,
        emergency: current.emergency_category !== null && current.emergency_category !== undefined } : null,
      pendingCost: facts.pendingCost === true,
      names: { tenant: clean(facts.tenant), vendor: clean(facts.vendor), owner: clean(facts.owner) },
    }) };
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") return { state: "forbidden" };
    logServerError("b3_ticket_relay", error);
    return { state: "unavailable" };
  }
}
