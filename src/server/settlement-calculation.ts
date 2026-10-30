/** B011 statement arithmetic. All amounts are integer currency minor units. */
export type FinalRentInput = {
  country: string; currency: string; frequency: string; monthlyMinor: number;
  periodStart: string; periodEnd: string; leaseStart: string; moveOut: string;
};
function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) throw new TypeError("Invalid date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) throw new TypeError("Invalid date");
  return parsed.getTime();
}
function minor(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid amount"); return value; }
/** Period bounds must come from the agreed source, never inferred from a due date. */
export function calculateFinalRent(input: FinalRentInput) {
  if (input.country !== "TW" || input.currency !== "TWD" || input.frequency !== "monthly") throw new TypeError("Unsupported automatic rule");
  const monthly = minor(input.monthlyMinor);
  if (monthly % 100 !== 0) throw new TypeError("Fractional TWD requires manual amount");
  const start = date(input.periodStart), end = date(input.periodEnd), leaseStart = date(input.leaseStart), moveOut = date(input.moveOut);
  if (end < start || moveOut < start || moveOut > end || moveOut < leaseStart || leaseStart > end) throw new TypeError("Invalid period");
  const periodDays = Math.floor((end-start)/86400000)+1;
  if (periodDays < 28 || periodDays > 31) throw new TypeError("Ambiguous monthly period");
  const activeStart = Math.max(start,leaseStart);
  const days = Math.floor((moveOut-activeStart)/86400000)+1;
  if (days < 1 || days > 31) throw new TypeError("Invalid period");
  const fullPeriod = activeStart === start && moveOut === end;
  const rounded = ((BigInt(monthly) * BigInt(days) + BigInt(1500)) / BigInt(3000)) * BigInt(100);
  const partial = rounded > BigInt(monthly) ? BigInt(monthly) : rounded;
  const amount = fullPeriod ? monthly : Number(partial);
  if (!Number.isSafeInteger(amount)) throw new TypeError("Amount overflow");
  return { periodStart:input.periodStart,periodEnd:input.periodEnd,activeStart:new Date(activeStart).toISOString().slice(0,10),moveOut:input.moveOut,days,fullPeriod,amountMinor:amount };
}
/** Deduction amounts are the current, explicitly evidenced item values. */
export function calculateSettlement(depositMinor: number | null, deductions: number[]) {
  if (depositMinor === null) return { authoritative:false as const,netMinor:null,refundMinor:null,topUpMinor:null };
  const deposit=BigInt(minor(depositMinor));
  const total=deductions.reduce((sum,item)=>sum+BigInt(minor(item)),BigInt(0));
  const net=deposit-total;
  if (net > BigInt(Number.MAX_SAFE_INTEGER) || net < -BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("Amount overflow");
  return { authoritative:true as const,netMinor:Number(net),refundMinor:Number(net>BigInt(0)?net:BigInt(0)),topUpMinor:Number(net<BigInt(0)?-net:BigInt(0)) };
}
