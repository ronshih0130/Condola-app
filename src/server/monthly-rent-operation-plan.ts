import { createHash } from 'node:crypto';
export { formatConfiguredMinor, type CurrencyConfig } from './monthly-billing-rules';
import { monthlyBounds, planMonthlyRow, validCurrencyConfig, type CurrencyConfig, type LeaseSource, type RentSource } from './monthly-billing-rules';

export const MONTHLY_RENT_OPERATION_VERSION='monthly-rent-operation-v1';
export type MonthlyRentParty = { partyId:string; contactId:string; contactOrgId:string|null; payerName:string|null; isTenant:boolean|null; archivedAt:string|null; rentShareBp:number|null };
export type MonthlyRentOperationSource = { orgId:string; environment:'live'|'sandbox'; month:string; lease:LeaseSource & {status:string;property_currency:string}; parties:MonthlyRentParty[]; rent:RentSource[]; capped:boolean };
export type MonthlyRentOperation = { version:typeof MONTHLY_RENT_OPERATION_VERSION; leaseId:string; propertyId:string; propertyName:string; payerId:string; payerName:string; currency:string; currencyConfig:CurrencyConfig; amountMinor:string; periodStart:string; periodEnd:string; servicePeriodEndExclusive:string; dueDate:string; digest:string };
export type MonthlyRentUnsupportedReason = 'period_out_of_range'|'source_cap'|'inactive_lease'|'invalid_source'|'invalid_date'|'unsupported_frequency'|'date_conflict'|'partial_or_moveout'|'invalid_currency_config'|'invalid_rent'|'historical_period_unknown'|'coverage_conflict'|'existing_rent'|'due_day_unavailable'|'zero_rent'|'payer_missing'|'payer_ambiguous'|'payer_unusable';
export type MonthlyRentOperationResult = {kind:'supported';operation:MonthlyRentOperation} | {kind:'unsupported';reason:MonthlyRentUnsupportedReason};
const ROW_REASONS:readonly MonthlyRentUnsupportedReason[]=['invalid_date','unsupported_frequency','date_conflict','partial_or_moveout','invalid_currency_config','invalid_rent','historical_period_unknown','coverage_conflict','existing_rent'];

/** Pure snapshot classification, not a reservation or permission to write. */
export function planMonthlyRentOperation(input:MonthlyRentOperationSource):MonthlyRentOperationResult {
  const {lease,orgId,month}=input;
  const period=monthlyBounds(month);
  // Keep all dates in the supported four-digit range used by the monthly classifier.
  if (month==='9999-12') return {kind:'unsupported',reason:'period_out_of_range'};
  const [year,monthNumber]=month.split('-').map(Number);
  const servicePeriodEndExclusive=`${String(monthNumber===12?year+1:year).padStart(4,'0')}-${String(monthNumber===12?1:monthNumber+1).padStart(2,'0')}-01`;
  if (input.capped) return {kind:'unsupported',reason:'source_cap'};
  if (input.rent.some(row=>row.lease_id!==lease.id)) return {kind:'unsupported',reason:'invalid_source'};
  if (lease.status!=='active') return {kind:'unsupported',reason:'inactive_lease'};
  if (!lease.id || !lease.property_id || !lease.property_name.trim() || !/^[A-Z]{3}$/.test(lease.currency.trim()) || lease.property_currency.trim()!==lease.currency.trim()) return {kind:'unsupported',reason:'invalid_source'};
  if (!Number.isInteger(lease.due_day) || lease.due_day<1 || lease.due_day>31) return {kind:'unsupported',reason:'due_day_unavailable'};
  const row=planMonthlyRow(lease,input.rent,[],month);
  if (row.state!=='supported') return {kind:'unsupported',reason:ROW_REASONS.find(reason=>reason===row.reason) ?? 'invalid_source'};
  if (!row.dueDate || row.dueReason) return {kind:'unsupported',reason:'due_day_unavailable'};
  if (!validCurrencyConfig(row.currencyConfig)) return {kind:'unsupported',reason:'invalid_currency_config'};
  if (row.rentMinor===null || BigInt(row.rentMinor)===BigInt(0)) return {kind:'unsupported',reason:'zero_rent'};
  if (input.parties.length!==1) return {kind:'unsupported',reason:input.parties.length===0?'payer_missing':'payer_ambiguous'};
  const payer=input.parties[0];
  if (!payer.partyId || !payer.contactId || payer.contactOrgId!==orgId || payer.isTenant!==true || payer.archivedAt!==null || !payer.payerName?.trim()) return {kind:'unsupported',reason:'payer_unusable'};
  const parties=input.parties.map(p=>({partyId:p.partyId,contactId:p.contactId,contactOrgId:p.contactOrgId,payerName:p.payerName,isTenant:p.isTenant,archivedAt:p.archivedAt,rentShareBp:p.rentShareBp})).sort((a,b)=>a.partyId.localeCompare(b.partyId));
  const rent=input.rent.filter(r=>r.period===null || r.period==='empty' || r.overlaps).map(r=>({leaseId:r.lease_id,invoiceId:r.invoice_id,invoiceNumber:r.invoice_number,lineId:r.line_id,status:r.status,source:r.source,period:r.period,amount:r.amount,currency:r.currency.trim(),overlaps:r.overlaps,exact:r.exact})).sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId)||a.lineId.localeCompare(b.lineId));
  const normalized={version:MONTHLY_RENT_OPERATION_VERSION,org:orgId,environment:input.environment,month,
    lease:{id:lease.id,status:lease.status,propertyId:lease.property_id,propertyName:lease.property_name,propertyCurrency:lease.property_currency.trim(),unitLabel:lease.unit_label,startDate:lease.start_date,endDate:lease.end_date,terminatedOn:lease.terminated_on,movedOutOn:lease.moved_out_on,currency:lease.currency.trim(),currencyConfig:{minorUnit:row.currencyConfig.minorUnit,displayDecimals:row.currencyConfig.displayDecimals},rent:lease.rent,frequency:lease.frequency,dueDay:lease.due_day},parties,rent,period,servicePeriodEndExclusive,dueDate:row.dueDate};
  const digest=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return {kind:'supported',operation:{version:MONTHLY_RENT_OPERATION_VERSION,leaseId:lease.id,propertyId:lease.property_id,propertyName:lease.property_name,payerId:payer.contactId,payerName:payer.payerName,currency:row.currency,currencyConfig:row.currencyConfig,amountMinor:row.rentMinor,periodStart:period.start,periodEnd:period.end,servicePeriodEndExclusive,dueDate:row.dueDate,digest}};
}
