import type { Client } from "pg";
import { one } from "./db";
import { taipeiToday } from "./money";

/**
 * One monthly series for every invoice the firm issues.
 * The lock is shared with move-in and electricity credit invoices.
 * INV-SEED and other non-monthly numbers do not consume the sequence.
 */
export async function nextInvoiceNumber(client: Client, orgId: string, attempt = 0) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('invoice-seq'), hashtext($1))`, [orgId]);
  const today = taipeiToday();
  const ym = `${today.slice(0, 4)}${today.slice(5, 7)}`;
  const row = await one<{ n: string }>(
    client,
    `SELECT coalesce(max((regexp_match(invoice_number, '^INV-' || $2 || '-([0-9]+)$'))[1]::int), 0)::text AS n
       FROM invoices
      WHERE org_id = $1
        AND invoice_number LIKE 'INV-' || $2 || '-%'`,
    [orgId, ym],
  );
  const next = Number(row.n) + 1 + attempt;
  if (!Number.isSafeInteger(next) || next <= 0 || next > 1_000_000) {
    const { FlowError } = await import("./errors");
    throw new FlowError("errors.generic");
  }
  return `INV-${ym}-${String(next).padStart(4, "0")}`;
}
