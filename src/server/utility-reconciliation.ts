import { tx } from "./db";
import { billingPreviewsEnabled } from "./billing-preview-rules";
import { monthBounds } from "./money";
import { assertPerm } from "./perms";
import type { Session } from "./types";

type Inputs = { publicAmountMinor: number; billGapMinor: number; remainderMinor: number };
export function reconcileUtility(bill: number | null, tenant: number, owner: number, inputs: unknown) {
  if (bill === null || !Number.isSafeInteger(bill) || !Number.isSafeInteger(tenant) || !Number.isSafeInteger(owner) || !inputs || typeof inputs !== "object" || Array.isArray(inputs)) return null;
  const raw = inputs as Record<string,unknown>;
  if (![raw.publicAmountMinor,raw.billGapMinor,raw.remainderMinor].every((n) => typeof n === "number" && Number.isSafeInteger(n))) return null;
  const parts = raw as Inputs;
  const difference = bill - tenant - owner - parts.publicAmountMinor - parts.billGapMinor - parts.remainderMinor;
  if (!Number.isSafeInteger(difference)) return null;
  return { bill,tenant,owner,publicAmount:parts.publicAmountMinor,gap:parts.billGapMinor,remainder:parts.remainderMinor,difference };
}

/** Reads saved runs and bill amounts; it never creates or alters a draft. */
export async function utilityReconciliation(session: Session, month: string) {
  assertPerm(session,"stmt.view");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const bounds = monthBounds(month);
  return tx(session.userId, async (client) => {
    if (!(await billingPreviewsEnabled(client,session.orgId))) return null;
    const rows = await client.query<{ id:string; property:string; unit:string; currency:string; start:string; end:string; status:string; bill:string | null; tenant:string; owner:string; inputs:unknown }>(`SELECT r.id::text,p.name AS property,u.label AS unit,r.currency,r.period_start::text AS start,r.period_end::text AS end,r.status::text,b.total_amount_minor::text AS bill,coalesce(sum(l.amount_minor) FILTER (WHERE l.bearer='tenant'),0)::text AS tenant,coalesce(sum(l.amount_minor) FILTER (WHERE l.bearer='owner'),0)::text AS owner,r.inputs FROM utility_allocation_runs r JOIN units u ON u.id=r.unit_id JOIN properties p ON p.id=u.property_id LEFT JOIN utility_bills b ON b.id=r.utility_bill_id LEFT JOIN utility_allocation_lines l ON l.run_id=r.id WHERE r.org_id=$1 AND r.status <> 'void' AND r.period_end >= $2::date AND r.period_start <= $3::date GROUP BY r.id,p.name,u.label,b.total_amount_minor ORDER BY p.name,u.label,r.period_start,r.id`,[session.orgId,bounds.start,bounds.end]);
    return rows.rows.map((r) => ({ ...r, reconciliation:reconcileUtility(r.bill === null ? null : Number(r.bill),Number(r.tenant),Number(r.owner),r.inputs) }));
  },{orgId:session.orgId,environment:session.environment},{isolation:"repeatable read",readOnly:true});
}
