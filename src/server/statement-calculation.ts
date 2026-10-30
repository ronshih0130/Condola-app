import { createHash } from "node:crypto";
import type { Client } from "pg";
import { stableStringify } from "@/idempotency";
import { many, maybe } from "./db";
import { FlowError } from "./errors";
import { STATEMENT_EXPENSE_SQL } from "./expenses";
import { attributePayment, managementFeeMinor, monthBounds } from "./money";

type Property = { property_id: string; ownership_id: string; effective_from: string; effective_to: string | null; currency: string; name: string; owner_version: string; property_version: string };
type Payment = { id: string; property_id: string; property_name: string; version: string; status: string; paid_on: string; amount_minor: string };
type Allocation = { id: string; version: string; amount_minor: string; invoice_id: string; invoice_version: string; invoice_status: string };
type Charge = { id: string; version: string; charge_type: string; amount_minor: string; description: string; service_period: string | null; quantity: string; unit_amount_minor: string };
type Expense = { id: string; version: string; amount_minor: string; description: string | null; category: string; property_id: string; status: string; incurred_on: string; ticket_id: string | null };
type Rule = { id: string; agreement_id: string; agreement_version: string; version: string; kind: string; hybrid_mode: string | null; percent_bp: number | null; fixed_amount_minor: string | null; minimum_minor: string | null; name: string };
export type StatementCalculation = {
  orgId: string; ownerContactId: string; start: string; end: string; currency: string;
  properties: Property[]; payments: Array<Payment & { allocations: Array<Allocation & { lines: Charge[]; attributed: { rent: number; utility: number; deposit: number; other: number }; residual: number }>; unallocated: number }>;
  expenses: Expense[]; rule: Rule | null; previous: { id: string; version: string; closing_balance_minor: string } | null;
  propertyAmounts: Array<{ propertyId: string; name: string; rent: number; utility: number; other: number }>;
  rent: number; other: number; fee: number; expenseTotal: number; opening: number; closing: number; fingerprint: string;
};

/** Read source rows and calculate exactly the amounts used to issue a statement. */
export async function calculateStatement(client: Client, orgId: string, ownerContactId: string, month: string, expensePredicate = STATEMENT_EXPENSE_SQL): Promise<StatementCalculation> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new FlowError("errors.required");
  const bounds = monthBounds(month);
  const properties = await many<Property>(client, `SELECT po.property_id::text,po.id::text AS ownership_id,po.effective_from::text,po.effective_to::text,p.currency,p.name,po.xmin::text AS owner_version,p.xmin::text AS property_version FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND po.owner_contact_id=$2 AND (po.effective_to IS NULL OR po.effective_to >= $3::date) ORDER BY po.property_id,po.effective_from,po.id`, [orgId,ownerContactId,bounds.start]);
  if (!properties.length) throw new FlowError("errors.notFound");
  const currencies = [...new Set(properties.map((p) => p.currency))];
  if (currencies.length !== 1) throw new FlowError("errors.currency");
  const currency = currencies[0], propertyIds = properties.map((p) => p.property_id);
  const selected = await many<Payment>(client, `SELECT p.id::text,l.property_id::text,pr.name AS property_name,p.xmin::text AS version,p.status::text,p.paid_on::text,p.amount_minor::text FROM payments p JOIN leases l ON l.id=p.lease_id JOIN properties pr ON pr.id=l.property_id WHERE p.org_id=$1 AND p.status='confirmed' AND p.currency=$2 AND p.paid_on BETWEEN $3 AND $4 AND l.property_id=ANY($5::uuid[]) ORDER BY p.id`, [orgId,currency,bounds.start,bounds.end,propertyIds]);
  const buckets = new Map(properties.map((p) => [p.property_id,{ propertyId:p.property_id,name:p.name,rent:0,utility:0,other:0 }]));
  const payments: StatementCalculation["payments"] = [];
  for (const payment of selected) {
    const selectedAllocations = await many<Allocation>(client, `SELECT a.id::text,a.xmin::text AS version,a.amount_minor::text,a.invoice_id::text,i.xmin::text AS invoice_version,i.status::text AS invoice_status FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id WHERE a.payment_id=$1 ORDER BY a.id`, [payment.id]);
    const allocations: StatementCalculation["payments"][number]["allocations"] = [];
    for (const allocation of selectedAllocations) {
      const lines = await many<Charge>(client, `SELECT id::text,xmin::text AS version,charge_type::text,amount_minor::text,description,service_period::text,quantity::text,unit_amount_minor::text FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no,id`, [allocation.invoice_id]);
      const attributed = attributePayment(lines.map((l) => ({ charge_type:l.charge_type,amount_minor:Number(l.amount_minor),description:l.description })), Number(allocation.amount_minor));
      const bucket = buckets.get(payment.property_id)!;
      bucket.rent += attributed.rent; bucket.utility += attributed.utility; bucket.other += attributed.other;
      const residual = Number(allocation.amount_minor) - attributed.rent - attributed.utility - attributed.deposit - attributed.other;
      allocations.push({ ...allocation, lines, attributed, residual });
    }
    payments.push({ ...payment, allocations, unallocated: Number(payment.amount_minor) - allocations.reduce((sum, allocation) => sum + Number(allocation.amount_minor), 0) });
  }
  const propertyAmounts = [...buckets.values()];
  const rent = propertyAmounts.reduce((s,p) => s+p.rent,0), other = propertyAmounts.reduce((s,p) => s+p.utility+p.other,0);
  const expenses = await many<Expense>(client, `SELECT id::text,xmin::text AS version,amount_minor::text,description,category,property_id::text,status::text,incurred_on::text,ticket_id::text FROM expenses WHERE org_id=$1 AND property_id=ANY($2::uuid[]) AND ${expensePredicate} AND app.repair_cost_on_statement(ticket_id,org_id) AND incurred_on BETWEEN $3 AND $4 AND currency=$5 ORDER BY id`, [orgId,propertyIds,bounds.start,bounds.end,currency]);
  const expenseTotal = expenses.reduce((s,e) => s+Number(e.amount_minor),0);
  const rule = await maybe<Rule>(client, `SELECT fr.id::text,ma.id::text AS agreement_id,ma.xmin::text AS agreement_version,fr.xmin::text AS version,fr.kind::text,fr.hybrid_mode::text,fr.percent_bp,fr.fixed_amount_minor::text,fr.minimum_minor::text,fr.name FROM management_agreements ma JOIN fee_rules fr ON fr.id=ma.fee_rule_id WHERE ma.org_id=$1 AND ma.owner_contact_id=$2 AND (ma.property_id IS NULL OR ma.property_id=ANY($3::uuid[])) AND ma.effective_from <= $4 AND (ma.effective_to IS NULL OR ma.effective_to > $4) ORDER BY ma.property_id NULLS LAST LIMIT 1`, [orgId,ownerContactId,propertyIds,bounds.end]);
  const fee = rule ? managementFeeMinor(rule,rent) : 0;
  const previous = await maybe<StatementCalculation["previous"] & object>(client, `SELECT id::text,xmin::text AS version,closing_balance_minor::text FROM owner_statements WHERE owner_contact_id=$1 AND currency=$2 AND status='issued' AND period_end < $3::date ORDER BY period_end DESC LIMIT 1`, [ownerContactId,currency,bounds.start]);
  const opening = Number(previous?.closing_balance_minor ?? 0), closing = opening+rent+other-fee-expenseTotal;
  const data = { orgId, ownerContactId, start:bounds.start,end:bounds.end,currency,properties,payments,expenses,rule,previous,propertyAmounts,rent,other,fee,expenseTotal,opening,closing };
  return { ...data, fingerprint:createHash("sha256").update(stableStringify(data)).digest("hex") };
}
