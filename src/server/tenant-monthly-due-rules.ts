import { assertNoNegativeClaim } from "./monthly-bill-rules";

/**
 * FR-Q6-01 / CAP-T-16: tenant monthly total amount due (應繳總額), display/record only.
 * Every component comes from an issued invoice line (its source reference) and every
 * amount is an integer minor-unit bigint. Condola moves no money.
 */
export type DueComponentKey = "rent" | "utility" | "deposit" | "other" | "offset";
export type DueSourceLine = {
  invoiceId: string; invoiceNumber: string; periodStart: string | null; dueOn: string; currency: string;
  invoicePaidMinor: string; lineNo: number; chargeType: string; amountMinor: string; description: string | null;
};
export type DueComponent = { key: DueComponentKey; amountMinor: string; description: string | null; source: { kind: "invoice_line"; invoiceNumber: string; lineNo: number; chargeType: string } };
export type MonthlyDuePeriod = {
  periodYm: string; currency: string; components: DueComponent[];
  grossMinor: string; offsetMinor: string; paidMinor: string; dueMinor: string; carryMinor: string;
  invoiceNumbers: string[];
  /** Confirmed payments per invoice, each with its source bill (CAP-T-16 per-component sources). */
  payments: Array<{ invoiceNumber: string; paidMinor: string }>;
};

const INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
function big(value: string): bigint {
  if (typeof value !== "string" || !INTEGER.test(value)) throw new TypeError("amount must be an integer minor-unit string");
  return BigInt(value);
}
function componentKey(chargeType: string, amount: bigint): DueComponentKey {
  if (amount < BigInt(0)) return "offset";
  if (chargeType === "rent" || chargeType === "utility" || chargeType === "deposit") return chargeType;
  return "other";
}

/** Group open-invoice lines by billing month (period_start, else due date) and total them in BigInt. */
export function monthlyDuePeriods(lines: DueSourceLine[]): MonthlyDuePeriod[] {
  const byPeriod = new Map<string, { currency: string; components: DueComponent[]; paid: Map<string, bigint>; numbers: Map<string, string> }>();
  for (const line of lines) {
    const month = (line.periodStart ?? line.dueOn).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError("invalid billing month");
    const amount = big(line.amountMinor), paid = big(line.invoicePaidMinor);
    if (paid < BigInt(0)) throw new TypeError("paid amount cannot be negative");
    const bucket = byPeriod.get(month) ?? { currency: line.currency, components: [] as DueComponent[], paid: new Map<string, bigint>(), numbers: new Map<string, string>() };
    if (bucket.currency !== line.currency) throw new TypeError("one currency per period");
    bucket.paid.set(line.invoiceId, paid); bucket.numbers.set(line.invoiceId, line.invoiceNumber);
    if (amount !== BigInt(0)) bucket.components.push({
      key: componentKey(line.chargeType, amount), amountMinor: amount.toString(), description: line.description,
      source: { kind: "invoice_line" as const, invoiceNumber: line.invoiceNumber, lineNo: line.lineNo, chargeType: line.chargeType },
    });
    byPeriod.set(month, bucket);
  }
  return [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([periodYm, b]) => {
    const gross = b.components.filter((c) => c.key !== "offset").reduce((s, c) => s + BigInt(c.amountMinor), BigInt(0));
    const offset = b.components.filter((c) => c.key === "offset").reduce((s, c) => s - BigInt(c.amountMinor), BigInt(0));
    const paid = [...b.paid.values()].reduce((s, v) => s + v, BigInt(0));
    // Offsets and payments both reduce what is owed this month; a surplus is shown as an excess, never a negative claim.
    // Months are independent here; the tenant's net outstanding balance remains the existing bill balance.
    const { netMinor, carryMinor } = assertNoNegativeClaim({ grossMinor: gross.toString(), creditOffsetMinor: (offset + paid).toString() });
    return {
      periodYm, currency: b.currency, components: b.components,
      grossMinor: gross.toString(), offsetMinor: offset.toString(), paidMinor: paid.toString(), dueMinor: netMinor, carryMinor,
      invoiceNumbers: [...new Set(b.components.map((c) => c.source.invoiceNumber))],
      payments: [...b.paid.entries()].filter(([, v]) => v !== BigInt(0)).map(([id, v]) => ({ invoiceNumber: b.numbers.get(id) as string, paidMinor: v.toString() })),
    };
  });
}
