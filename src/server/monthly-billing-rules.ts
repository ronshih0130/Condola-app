export type CurrencyConfig = { minorUnit:number; displayDecimals:number };
export function validCurrencyConfig(value:CurrencyConfig|null|undefined): value is CurrencyConfig {
  return !!value && Number.isInteger(value.minorUnit) && value.minorUnit>=0 && value.minorUnit<=4 && Number.isInteger(value.displayDecimals) && value.displayDecimals>=0 && value.displayDecimals<=4;
}
/** Stored integer to exact decimal; display defaults never discard a significant digit. */
export function formatConfiguredMinor(value:string,config:CurrencyConfig):string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !validCurrencyConfig(config)) throw new TypeError('Invalid money or currency configuration');
  const scale=config.minorUnit, padded=value.padStart(scale+1,'0');
  const whole=scale ? padded.slice(0,-scale) : padded;
  let fraction=scale ? padded.slice(-scale) : '';
  while (fraction.length>config.displayDecimals && fraction.endsWith('0')) fraction=fraction.slice(0,-1);
  fraction=fraction.padEnd(config.displayDecimals,'0');
  return fraction ? `${whole}.${fraction}` : whole;
}
export type LeaseSource = { id:string; property_id:string; property_name:string; unit_label:string; start_date:string; end_date:string|null; terminated_on:string|null; moved_out_on:string|null; currency:string; rent:string; frequency:string; due_day:number; currency_config:CurrencyConfig|null };
export type RentSource = { lease_id:string; invoice_id:string; invoice_number:string; line_id:string; status:string; source:string; period:string|null; amount:string; currency:string; overlaps:boolean; exact:boolean };
export type ComponentSource = { lease_id:string; id:string; kind:'charge'|'utility'; state:string; readiness:'unresolved'|'existing_posted'|'unposted'; reason:string };
export function formatMinor(value:string,currency:string):string { if(!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid money'); const padded=value.padStart(3,'0'); const whole=padded.slice(0,-2), fraction=padded.slice(-2); return currency==='TWD' && fraction==='00' ? whole : `${whole}.${fraction}`; }
export type MonthlyRow = { leaseId:string; propertyId:string; propertyName:string; unitLabel:string; currency:string; currencyConfig:CurrencyConfig|null; rentMinor:string|null; dueDate:string|null; dueReason:string|null; state:'supported'|'existing'|'unresolved'; reason:string|null; evidenceRefs:{invoiceId:string;invoiceNumber:string;lineId:string}[]; components:ComponentSource[] };
export function monthlyBounds(month:string) {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000-')) throw new TypeError('Invalid month');
  const [y,m]=month.split('-').map(Number); const d=new Date(0); d.setUTCFullYear(y,m,0); d.setUTCHours(0,0,0,0);
  return { start:`${month}-01`, end:`${month}-${String(d.getUTCDate()).padStart(2,'0')}` };
}
export function validIsoDate(value:string):boolean { if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000-')) return false; const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10)===value; }
export function utilityReadiness(input:{postedValid:boolean; linkedValid:boolean; linkPresent:boolean; pointersPresent:boolean; runStatus:string}):{readiness:ComponentSource['readiness'];reason:string} { if((input.pointersPresent && !input.postedValid) || (input.linkPresent && !input.linkedValid)) return {readiness:'unresolved',reason:'utility_unclear'}; if(input.postedValid || input.linkedValid) return {readiness:'existing_posted',reason:'utility_linked'}; if(input.runStatus==='draft'||input.runStatus==='approved') return {readiness:'unposted',reason:'utility_unposted'};return {readiness:'unresolved',reason:'utility_unclear'}; }
export function planMonthlyRow(lease:LeaseSource, sources:RentSource[], components:ComponentSource[], month:string):MonthlyRow {
  const {start,end}=monthlyBounds(month); const max=Number(end.slice(-2));
  const day=lease.due_day===31 ? max : lease.due_day;
  const dueDate=day>=1 && day<=max ? `${month}-${String(day).padStart(2,'0')}` : null;
  let reason:string|null=null, state:MonthlyRow['state']='unresolved';
  if (![lease.start_date,lease.end_date,lease.terminated_on,lease.moved_out_on].every(d=>d===null||validIsoDate(d))) reason='invalid_date';
  else if (lease.frequency!=='monthly') reason='unsupported_frequency';
  else if ((lease.end_date!==null && lease.end_date<lease.start_date) || (lease.terminated_on!==null && lease.terminated_on<lease.start_date) || (lease.moved_out_on!==null && lease.moved_out_on<lease.start_date)) reason='date_conflict';
  else if (lease.start_date>start || (lease.end_date!==null && lease.end_date<end) || (lease.terminated_on!==null && lease.terminated_on<=end) || (lease.moved_out_on!==null && lease.moved_out_on<=end)) reason='partial_or_moveout';
  else if (!validCurrencyConfig(lease.currency_config)) reason='invalid_currency_config';
  else if (!/^(0|[1-9][0-9]*)$/.test(lease.rent)) reason='invalid_rent';
  else if (sources.some(s=>s.period===null || s.period==='empty')) reason='historical_period_unknown';
  else {
    const overlap=sources.filter(s=>s.overlaps);
    if (overlap.some(s=>(s.status==='written_off' || s.status==='void') || s.currency.trim()!==lease.currency.trim()) || overlap.length>1 || overlap.some(s=>!s.exact)) reason='coverage_conflict';
    else if (overlap.length===1) {state='existing';reason='existing_rent';}
    else state='supported';
  }
  return {leaseId:lease.id,propertyId:lease.property_id,propertyName:lease.property_name,unitLabel:lease.unit_label,currency:lease.currency.trim(),currencyConfig:validCurrencyConfig(lease.currency_config)?lease.currency_config:null,rentMinor:state==='supported'?lease.rent:null,dueDate,evidenceRefs:sources.filter(s=>s.period===null || s.period==='empty' || s.overlaps).map(s=>({invoiceId:s.invoice_id,invoiceNumber:s.invoice_number,lineId:s.line_id})),dueReason:dueDate?null:'due_day_unavailable',state,reason,components};
}
