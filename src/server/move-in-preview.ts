import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { tx, maybe, many } from "./db";
import { billingPreviewAuthorityOn } from "./billing-preview-authority";
import { FlowError } from "./errors";
import { planMoveInSource, readMoveInSource } from "./move-in-plan";
import type { Session } from "./types";

/** The caller supplies the server-loaded session, never request-provided identity or scope. */
export async function moveInPreview(session: Session, leaseId: string) {
  session = await guardEffectiveSession(session, "leases.edit");
  return tx(session.userId, async client => withEffectiveAuthority(client, session, "leases.edit", async () => {
    if (!(await billingPreviewAuthorityOn(client, session))) return null;
    const lease = await maybe<{ status:string; esign_status:string }>(client,
      `SELECT status::text, esign_status::text FROM leases WHERE id=$1 AND org_id=$2`, [leaseId, session.orgId]);
    if (!lease) return null;
    const existing = await maybe<{ id:string; currency:string; total_minor:string }>(client,
      `SELECT id::text, currency, total_minor::text FROM invoices
       WHERE lease_id=$1 AND org_id=$2 AND source='move_in' AND status<>'void' LIMIT 1`, [leaseId, session.orgId]);
    if (existing) {
      const lines = await many<{ type:string; description:string; amount:string; allocation_id:string|null; period_start:string|null; period_end:string|null }>(client,
        `SELECT charge_type::text AS type, description, amount_minor::text AS amount, allocation_line_id::text AS allocation_id,
                lower(service_period)::text AS period_start, (upper(service_period)-1)::text AS period_end
           FROM invoice_lines WHERE invoice_id=$1 AND org_id=$2 ORDER BY line_no`, [existing.id, session.orgId]);
      const totalMinor = Number(existing.total_minor);
      if (!Number.isSafeInteger(totalMinor) || lines.some(line => !Number.isSafeInteger(Number(line.amount)))) return { kind: "unavailable" as const };
      return { kind: "issued" as const, currency: existing.currency, totalMinor,
        lines: lines.map(line => ({ ...line, amount: Number(line.amount) })), calculation: null };
    }
    // B001 completion and paper activation issue only for these prospective states; imported leases do not issue.
    if (!["draft", "pending_signature"].includes(lease.status) || lease.esign_status === "imported") return null;
    const source = await readMoveInSource(client, leaseId);
    let plan;
    try { plan = planMoveInSource(source); }
    catch (error) {
      if ((error instanceof FlowError && error.key === "errors.staleLease") || error instanceof TypeError) return { kind: "unavailable" as const };
      throw error;
    }
    return { kind: "estimate" as const, currency: source.lease.currency, totalMinor: plan.totalMinor,
      lines: plan.lines.map(line => ({ type: line.type, description: line.type, amount: line.amount,
        allocation_id: line.allocationId, period_start: line.type === "rent" ? plan.calculation?.periodStart ?? null : null,
        period_end: line.type === "rent" ? plan.calculation?.periodEnd ?? null : null })), calculation: plan.calculation };
  }), { orgId: session.orgId, environment: session.environment }, { isolation: "repeatable read", readOnly: true });
}
export type MoveInPreview = NonNullable<Awaited<ReturnType<typeof moveInPreview>>>;
