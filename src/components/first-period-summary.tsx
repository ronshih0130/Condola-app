import { firstInvoicePlan } from "@/server/first-invoice-plan";
import { firstPeriodCopy } from "@/i18n/first-period";
import { moneyLabel } from "@/server/format";
import type { Locale } from "@/i18n";

/** A billing summary is separate from the signed lease document. */
export function FirstPeriodSummary({ basis, locale }: { basis: unknown; locale: Locale }) {
  if (basis === null) return null;
  const copy = firstPeriodCopy(locale);
  let calculation;
  try { calculation = firstInvoicePlan({ rentMinor: 0, depositMinor: 0, utility: null, basis }).calculation; }
  catch { return <p role="alert">{copy.unavailable}</p>; }
  if (!calculation) return null;
  return <section className="card pad" data-testid="first-period-summary">
    <h3>{copy.summary}</h3>
    <p className="hint">{copy.note}</p>
    <p>{copy.period}: {calculation.periodStart} – {calculation.periodEnd}</p>
    <p>{calculation.prorated ? `${copy.formula} (${calculation.days} ${copy.days})` : copy.full}: {moneyLabel(calculation.rentMinor, calculation.currency, locale)}</p>
  </section>;
}
