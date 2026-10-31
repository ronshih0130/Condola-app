import type { Client } from "pg";
import { maybe, one } from "./db";
import { FlowError } from "./errors";
import { firstInvoicePlan } from "./first-invoice-plan";

export type FirstPeriodLeaseSource = { first_period_basis: unknown; rent_amount_minor: string; currency: string; start_date: string; end_date: string | null; rent_frequency: string; prorate_first_period: boolean };
export function validateFirstPeriodSource(lease: FirstPeriodLeaseSource, checkEnd: boolean) {
  if (lease.first_period_basis === null) return;
  if (!lease.first_period_basis || typeof lease.first_period_basis !== "object" || Array.isArray(lease.first_period_basis)) throw new FlowError("errors.staleLease");
  const basis = lease.first_period_basis as Record<string, unknown>;
  if (basis.monthlyRentMinor !== Number(lease.rent_amount_minor) || basis.currency !== lease.currency.trim() ||
      basis.startDate !== lease.start_date || basis.rentFrequency !== lease.rent_frequency ||
      basis.prorateFirstPeriod !== lease.prorate_first_period || (checkEnd && basis.endDate !== lease.end_date)) throw new FlowError("errors.staleLease");
  try { firstInvoicePlan({ rentMinor: 0, depositMinor: 0, utility: null, basis }); }
  catch { throw new FlowError("errors.staleLease"); }
}


export async function readMoveInSource(client: Client, leaseId: string) {
  const lease = await one<{
    property_id: string;
    org_id: string;
    currency: string;
    rent_amount_minor: string;
    deposit_amount_minor: string;
    start_date: string;
    end_date: string;
    rent_frequency: string;
    prorate_first_period: boolean;
    first_period_basis: unknown;
  }>(
    client,
    `SELECT property_id::text, org_id::text, currency, rent_amount_minor::text, deposit_amount_minor::text, start_date::text, end_date::text,
            rent_frequency::text, prorate_first_period, first_period_basis
       FROM leases WHERE id = $1`,
    [leaseId],
  );
  // A confirmed electricity split already has its own invoice line. Attaching that
  // allocation again violates invoice_lines_alloc_uniq and rolls the countersign back.
  const allocation = await maybe<{ id: string; amount_minor: string }>(
    client,
    `SELECT l.id, l.amount_minor::text
       FROM utility_allocation_lines l
      WHERE l.lease_id = $1 AND l.amount_minor > 0
        AND l.posted_invoice_line_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoice_lines il WHERE il.allocation_line_id = l.id
        )
      ORDER BY l.amount_minor DESC
      LIMIT 1`,
    [leaseId],
  );
  return { lease, allocation };
}

export function planMoveInSource({ lease, allocation }: Awaited<ReturnType<typeof readMoveInSource>>) {
  validateFirstPeriodSource(lease, false);
  const plan = firstInvoicePlan({ rentMinor: Number(lease.rent_amount_minor), depositMinor: Number(lease.deposit_amount_minor),
    utility: allocation ? { id: allocation.id, amountMinor: Number(allocation.amount_minor) } : null, basis: lease.first_period_basis });
  return plan;
}

export async function readMoveInPlan(client: Client, leaseId: string) {
  const source = await readMoveInSource(client, leaseId);
  return { ...source, plan: planMoveInSource(source) };
}
