/** Local pure candidate for the approved statement-only reconciliation.
 * Caller must establish complete source coverage and freshness separately. */
type Input={depositMinor:number|null;unrelatedDeductions:number[];finalRentMinor:number|null;rentCashMinor:number|null;chargedRentMinor:number|null;sourceCoverage:"verified"|"unknown";outstanding:"resolved"|"unresolved";priorOutcomes:"reconciled"|"unresolved"};
const valid=(n:number)=>Number.isSafeInteger(n)&&n>=0;
export function calculateReconciledRent(input:Input) {
  const amounts=[input.depositMinor,input.finalRentMinor,input.rentCashMinor,input.chargedRentMinor,...input.unrelatedDeductions];
  if(amounts.some(n=>n!==null&&!valid(n)))throw new TypeError("Invalid amount");
  const unknown=input.sourceCoverage!=="verified"||input.outstanding!=="resolved"||input.priorOutcomes!=="reconciled"||input.depositMinor===null||input.finalRentMinor===null||input.rentCashMinor===null||input.chargedRentMinor===null;
  if(unknown)return {authoritative:false as const,netMinor:null,refundMinor:null,topUpMinor:null,chargeAdjustmentMinor:null,rentAdjustmentMinor:null};
  const D=BigInt(input.depositMinor!),F=BigInt(input.finalRentMinor!),R=BigInt(input.rentCashMinor!),C=BigInt(input.chargedRentMinor!);
  const deductions=input.unrelatedDeductions.reduce((sum,n)=>sum+BigInt(n),BigInt(0));
  const chargeAdjustment=F-C, rentAdjustment=R-F, net=D-deductions+rentAdjustment;
  const limit=BigInt(Number.MAX_SAFE_INTEGER);
  if([chargeAdjustment,rentAdjustment,net].some(n=>n>limit||n< -limit))throw new TypeError("Amount overflow");
  return {authoritative:true as const,netMinor:Number(net),refundMinor:Number(net>BigInt(0)?net:BigInt(0)),topUpMinor:Number(net<BigInt(0)?-net:BigInt(0)),chargeAdjustmentMinor:Number(chargeAdjustment),rentAdjustmentMinor:Number(rentAdjustment)};
}
