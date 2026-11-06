import { assertNoNegativeClaim } from "./monthly-bill-rules";
import type { AdvanceCredit, MonthlyBillPreviewDTO, PeriodDueComponentLine, SourceRefKind } from "./monthly-bill-types";

function parseAmountMinor(value: string): bigint {
  if (typeof value !== "string" || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("amountMinor must be a canonical decimal integer string");
  }
  return BigInt(value);
}

export function composeMonthlyBillPreview(input: {
  orgId: string; leaseId: string; periodYm: string; currency: string;
  plannedRent: { amountMinor: string; planVersion: string; planDigest: string; sourceRefId?: string | null };
  postedUtilities?: Array<{ amountMinor: string; sourceRefId?: string | null; componentKey?: string; currency?: string }>;
  statementSources?: Array<{ amountMinor: string; sourceRefId?: string | null; componentKey?: string; sourceRefKind?: SourceRefKind; currency?: string }>;
  advanceCredits?: AdvanceCredit[];
}): MonthlyBillPreviewDTO {
  const components: PeriodDueComponentLine[] = [
    { componentKey: "rent", amountMinor: input.plannedRent.amountMinor, currency: input.currency, sourceRefKind: "lease_charge", sourceRefId: input.plannedRent.sourceRefId },
    ...(input.postedUtilities ?? []).map((line): PeriodDueComponentLine => ({
      componentKey: line.componentKey ?? "utility",
      amountMinor: line.amountMinor,
      currency: line.currency ?? input.currency,
      sourceRefKind: "manual",
      sourceRefId: line.sourceRefId,
    })),
    ...(input.statementSources ?? []).map((line): PeriodDueComponentLine => ({
      componentKey: line.componentKey ?? "statement",
      amountMinor: line.amountMinor,
      currency: line.currency ?? input.currency,
      sourceRefKind: line.sourceRefKind ?? "other",
      sourceRefId: line.sourceRefId,
    })),
  ];
  const gross = components.reduce((sum, line) => sum + parseAmountMinor(line.amountMinor), BigInt(0));
  const advanceCredits = (input.advanceCredits ?? []).map((credit) => ({ ...credit }));
  let offset = BigInt(0);
  for (const credit of advanceCredits) {
    const amount = parseAmountMinor(credit.amountMinor);
    if (credit.status === "approved") offset += amount;
    else if (credit.status === "clawback") offset -= amount;
  }
  if (offset < BigInt(0)) offset = BigInt(0);
  const grossMinor = gross.toString();
  const creditOffsetMinor = offset.toString();
  const { netMinor, carryMinor } = assertNoNegativeClaim({ grossMinor, creditOffsetMinor });
  return {
    orgId: input.orgId,
    leaseId: input.leaseId,
    periodYm: input.periodYm,
    currency: input.currency,
    components,
    advanceCredits,
    grossMinor,
    creditOffsetMinor,
    netMinor,
    carryMinor,
    planVersion: input.plannedRent.planVersion,
    planDigest: input.plannedRent.planDigest,
  };
}
