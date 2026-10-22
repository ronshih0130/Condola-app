import type { Client } from "pg";
import { one } from "./db";
import { taipeiToday } from "./money";

/**
 * One monthly series for every invoice the firm issues.
 * The lock is shared with move-in and electricity credit invoices.
 * INV-SEED and other non-monthly numbers do not consume the sequence.
 */
export async function nextInvoiceNumber(client: Client, orgId: string, attempt = 0) {
  const [number] = await reserveInvoiceNumbers(client, orgId, 1, attempt);
  return number;
}

/** Allocates `count` monthly numbers in one lock. Suffixes are bigint so a long series does not overflow int. */
export async function reserveInvoiceNumbers(client: Client, orgId: string, count: number, attempt = 0) {
  if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(attempt) || attempt < 0) {
    const { FlowError } = await import("./errors");
    throw new FlowError("errors.generic");
  }
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('invoice-seq'), hashtext($1))`, [orgId]);
  const today = taipeiToday();
  const ym = `${today.slice(0, 4)}${today.slice(5, 7)}`;
  const row = await one<{ n: string }>(
    client,
    `SELECT coalesce(max((regexp_match(invoice_number, '^INV-' || $2 || '-([0-9]+)$'))[1]::bigint), 0)::text AS n
       FROM invoices
      WHERE org_id = $1
        AND invoice_number LIKE 'INV-' || $2 || '-%'`,
    [orgId, ym],
  );
  const start = Number(row.n) + 1 + attempt;
  const last = start + count - 1;
  if (!Number.isSafeInteger(last) || start <= 0 || last > 1_000_000) {
    const { FlowError } = await import("./errors");
    throw new FlowError("errors.generic");
  }
  const numbers: string[] = [];
  for (let index = 0; index < count; index += 1) {
    numbers.push(`INV-${ym}-${String(start + index).padStart(4, "0")}`);
  }
  return numbers;
}
