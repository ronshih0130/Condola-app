import { inclusiveDays, monthBounds } from "./money";

export type FirstPeriodInput = {
  startDate: string;
  endDate: string | null;
  monthlyRentMinor: number;
  currency: string;
  rentFrequency: string;
  prorateFirstPeriod: boolean;
};

/** One currency-rounded result, with no intermediate daily rounding. */
export function calculateFirstPeriod(input: FirstPeriodInput) {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000-") && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
  if (!validDate(input.startDate) || (input.endDate !== null && (!validDate(input.endDate) || input.endDate < input.startDate)) || !Number.isSafeInteger(input.monthlyRentMinor) || input.monthlyRentMinor < 0 || typeof input.prorateFirstPeriod !== "boolean") throw new TypeError("Invalid first-period source");
  const currency = input.currency.trim().toUpperCase();
  if (currency !== "TWD" && currency !== "USD") throw new TypeError("Unsupported first-period currency");
  const month = monthBounds(input.startDate.slice(0,7));
  const end = input.endDate && input.endDate < month.end ? input.endDate : month.end;
  const days = inclusiveDays(input.startDate,end,month.start,month.end);
  const fullMonth = input.startDate === month.start && end === month.end;
  const prorated = input.prorateFirstPeriod && !fullMonth;
  if (input.prorateFirstPeriod && input.rentFrequency !== "monthly") throw new TypeError("Unsupported first-period rent frequency");
  const quantum = currency === "TWD" ? 100 : 1;
  if (currency === "TWD" && input.monthlyRentMinor % 100 !== 0) throw new TypeError("Invalid first-period TWD rent");
  const numerator = BigInt(input.monthlyRentMinor) * BigInt(days);
  const divisor = BigInt(30 * quantum);
  const rounded = ((numerator + divisor / BigInt(2)) / divisor) * BigInt(quantum);
  const rent = prorated ? Number(rounded) : input.monthlyRentMinor;
  if (!Number.isSafeInteger(rent)) throw new TypeError("Invalid first-period amount");
  return { periodStart:input.startDate, periodEnd:end, days, denominator:30, currency, monthlyRentMinor:input.monthlyRentMinor, prorateFirstPeriod:input.prorateFirstPeriod, fullMonth, prorated, rentMinor:rent };
}
