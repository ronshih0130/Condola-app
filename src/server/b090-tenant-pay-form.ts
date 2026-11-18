/**
 * Brand 3.0 B-090 slice 2, RT-REPORT (TEN-53-AC1, AC4, AC6): the report form's pure checks. No imports, so the client
 * form can use them; the server keeps its own checks (recordPayment and the B-087 guard), these only stop a doomed send.
 */

/** Major-unit text for an input (no grouping), from integer minor units. */
export function majorText(minor: number, currency: string): string {
  const sign = minor < 0 ? "-" : "", abs = Math.abs(minor), whole = Math.floor(abs / 100), cents = abs % 100;
  return currency.trim().toUpperCase() === "TWD" && cents === 0 ? `${sign}${whole}` : `${sign}${whole}.${String(cents).padStart(2, "0")}`;
}

/** Parses what the tenant typed (thousands separators allowed) into minor units; null when it is not an amount. */
export function parseAmountMinor(text: string, currency: string): number | null {
  const clean = text.replace(/[,\s，]/g, "");
  const twd = currency.trim().toUpperCase() === "TWD";
  if (!(twd ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/).test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

export type ReportField = "amount" | "paidOn" | "last5";
export type ReportProblem = "amountPositive" | "overLimit" | "required" | "last5";

/** TEN-53-AC6: the client check before anything is sent. The server keeps its own checks (B-087 guard included). */
export function reportProblems(values: { amount: string; paidOn: string; last5: string }, restMinor: number, currency: string): Partial<Record<ReportField, ReportProblem>> {
  const out: Partial<Record<ReportField, ReportProblem>> = {};
  const minor = parseAmountMinor(values.amount, currency);
  if (minor === null || minor <= 0) out.amount = "amountPositive";
  else if (minor > restMinor) out.amount = "overLimit";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.paidOn)) out.paidOn = "required";
  if (currency.trim().toUpperCase() === "TWD" && !/^\d{5}$/.test(values.last5.trim())) out.last5 = "last5";
  return out;
}

/** Which form field a server error (the `error` query the existing action bounces with) belongs to; null = the whole form. */
export function serverErrorField(key: string | undefined): ReportField | null {
  if (key === "errors.amount" || key === "errors.amountTooHigh" || key === "errors.amountOverUnreported") return "amount";
  if (key === "errors.last5") return "last5";
  return null;
}
