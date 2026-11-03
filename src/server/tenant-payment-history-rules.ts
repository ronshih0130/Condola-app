import { localReminderDate } from './reminder-foundation';

export type BillState = 'unsigned' | 'no_invoice' | 'nonpayable' | 'zero_charge' | 'credit' | 'offset' | 'due' | 'partial' | 'paid';
export type InvoiceAmount = { status:string; total:number; paid:number; balance:number; dueOn:string };
export function safeMinor(value: string | number): number {
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error('Invalid amount');
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error('Amount out of range');
  return n;
}
export function sumMinor(values: number[]): number { let sum=0; for(const n of values) { if (!Number.isSafeInteger(n) || !Number.isSafeInteger(sum+n)) throw new Error('Amount out of range'); sum+=n; } return sum; }
export function historyFlagEnabled(global: unknown, org: unknown, orgId: string): boolean {
  if (!global || typeof global!=='object' || Array.isArray(global) || !org || typeof org!=='object' || Array.isArray(org)) return false;
  const g=global as Record<string,unknown>,o=org as Record<string,unknown>,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return g.enabled===true && Array.isArray(g.allowed_org_ids) && g.allowed_org_ids.every(x=>typeof x==='string' && uuid.test(x)) && g.allowed_org_ids.includes(orgId) && o.tenant_payment_history===true;
}
export function summarizeBill(leaseStatus:string,invoices:InvoiceAmount[],timezone:string,at:Date):{state:BillState;overdue:boolean;balanceMinor:number;paidMinor:number} {
  const today=localReminderDate(at,timezone);
  for(const i of invoices) if (![i.total,i.paid,i.balance].every(Number.isSafeInteger)||i.paid<0||i.balance!==i.total-i.paid) throw new Error('Inconsistent invoice');
  if(leaseStatus==='pending_signature'||leaseStatus==='draft')return {state:'unsigned',overdue:false,balanceMinor:0,paidMinor:0};
  const payable=invoices.filter(i=>['open','partially_paid','paid'].includes(i.status));
  if(!payable.length)return {state:invoices.length?'nonpayable':'no_invoice',overdue:false,balanceMinor:0,paidMinor:0};
  for(const i of payable) {
    if ((i.status==='paid' && (i.total<=0||i.balance>0)) || (i.status==='partially_paid' && i.paid<=0) || (i.status==='open' && (i.paid!==0 || (i.total>0 && i.balance<=0)))) throw new Error('Inconsistent invoice state');
  }
  // The normal report writer uses signed balances only from these open rows.
  const outstanding=payable.filter(i=>i.status==='open'||i.status==='partially_paid');
  const balanceMinor=sumMinor(outstanding.map(i=>i.balance));
  const paidMinor=sumMinor(outstanding.map(i=>i.paid));
  const overdue=balanceMinor>0 && outstanding.some(i=>i.balance>0 && i.dueOn<today);
  let state:BillState;
  if(balanceMinor<0)state='credit';
  else if(balanceMinor===0 && outstanding.some(i=>i.balance<0))state='offset';
  else if(balanceMinor>0)state=paidMinor>0?'partial':'due';
  else if(outstanding.length>0)state='zero_charge';
  else state=payable.some(i=>i.status==='paid')?'paid':'zero_charge';
  return {state,overdue,balanceMinor,paidMinor};
}
