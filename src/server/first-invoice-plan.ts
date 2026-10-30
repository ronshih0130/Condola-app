import { calculateFirstPeriod, type FirstPeriodInput } from "./first-period-calculation";

export const FIRST_PERIOD_VERSION = "monthly-30-v1";
export type FirstPeriodBasis = FirstPeriodInput & { version: typeof FIRST_PERIOD_VERSION; actor: string; capturedAt: string };
export type FirstInvoiceSource = {
  rentMinor: number;
  depositMinor: number;
  utility: { id: string; amountMinor: number } | null;
  basis: unknown;
};

/** Pure line plan: null basis preserves the existing full-rent invoice path. */
export function firstInvoicePlan(source: FirstInvoiceSource) {
  for (const value of [source.rentMinor,source.depositMinor,source.utility?.amountMinor ?? 0]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid initial invoice amount");
  }
  let calculation: ReturnType<typeof calculateFirstPeriod> | null = null;
  if (source.basis !== null) {
    if (!source.basis || typeof source.basis !== "object" || Array.isArray(source.basis)) throw new TypeError("Invalid initial invoice basis");
    const b=source.basis as Record<string,unknown>;
    if (b.version !== FIRST_PERIOD_VERSION || typeof b.startDate !== "string" || !(typeof b.endDate === "string" || b.endDate === null) || typeof b.monthlyRentMinor !== "number" || typeof b.currency !== "string" || b.rentFrequency !== "monthly" || typeof b.prorateFirstPeriod !== "boolean" || typeof b.actor !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.actor) || typeof b.capturedAt !== "string" || !Number.isFinite(Date.parse(b.capturedAt))) throw new TypeError("Invalid initial invoice basis");
    calculation=calculateFirstPeriod({startDate:b.startDate,endDate:b.endDate,monthlyRentMinor:b.monthlyRentMinor,currency:b.currency,rentFrequency:b.rentFrequency,prorateFirstPeriod:b.prorateFirstPeriod});
  }
  const lines = [
    {type:"rent" as const, amount:calculation?.rentMinor ?? source.rentMinor, allocationId:null as string | null},
    ...(source.depositMinor > 0 ? [{type:"deposit" as const,amount:source.depositMinor,allocationId:null as string | null}] : []),
    ...(source.utility && source.utility.amountMinor > 0 ? [{type:"utility" as const,amount:source.utility.amountMinor,allocationId:source.utility.id}] : []),
  ];
  const totalMinor=lines.reduce((sum,line)=>sum+line.amount,0);
  if (!Number.isSafeInteger(totalMinor)) throw new TypeError("Invalid initial invoice total");
  return { calculation, lines, totalMinor };
}
