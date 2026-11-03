import assert from 'node:assert/strict';
import test from 'node:test';
import { historyFlagEnabled, safeMinor, summarizeBill } from './tenant-payment-history-rules';
const day=new Date('2026-03-09T06:30:00Z');
test('bill states retain overdue independently from partial and respect local date',()=>{
 const row={status:'partially_paid',total:100,paid:20,balance:80,dueOn:'2026-03-08'};
 assert.deepEqual(summarizeBill('active',[row],'America/Los_Angeles',day),{state:'partial',overdue:false,balanceMinor:80,paidMinor:20});
 assert.equal(summarizeBill('active',[row],'Asia/Taipei',day).overdue,true);
 assert.equal(summarizeBill('active',[],'UTC',day).state,'no_invoice');
 assert.equal(summarizeBill('active',[{...row,status:'written_off'}],'UTC',day).state,'nonpayable');
 assert.equal(summarizeBill('pending_signature',[],'UTC',day).state,'unsigned');
 assert.deepEqual(summarizeBill('pending_signature',[row],'UTC',day),{state:'partial',overdue:true,balanceMinor:80,paidMinor:20});
 assert.equal(summarizeBill('active',[{...row,status:'open',total:0,paid:0,balance:0}],'UTC',day).state,'zero_charge');
 assert.equal(summarizeBill('active',[{...row,status:'paid',paid:100,balance:0}],'UTC',day).state,'paid');
 assert.throws(()=>summarizeBill('active',[{...row,balance:81}],'UTC',day));
 assert.throws(()=>safeMinor('9007199254740992'));
});
test('feature setting is strict and absence or malformed allowlists stay off',()=>{
 const id='10000000-0000-4000-8000-000000000001', flag={tenant_payment_history:true};
 assert.equal(historyFlagEnabled({enabled:true,allowed_org_ids:[id]},flag,id),true);
 for(const g of [null,{enabled:'true',allowed_org_ids:[id]},{enabled:true,allowed_org_ids:[id,3]},{enabled:true,allowed_org_ids:[]}])assert.equal(historyFlagEnabled(g,flag,id),false);
 assert.equal(historyFlagEnabled({enabled:true,allowed_org_ids:[id]},{tenant_payment_history:'true'},id),false);
});

test('old settlement cannot mark an unpaid current invoice partial, and signed credits offset due',()=>{
 const old={status:'paid',total:100,paid:100,balance:0,dueOn:'2026-02-01'};
 const due={status:'open',total:200,paid:0,balance:200,dueOn:'2026-03-01'};
 assert.deepEqual(summarizeBill('active',[old,due],'UTC',day),{state:'due',overdue:true,balanceMinor:200,paidMinor:0});
 const credit={status:'open',total:-250,paid:0,balance:-250,dueOn:'2026-03-01'};
 assert.deepEqual(summarizeBill('active',[old,credit],'UTC',day),{state:'credit',overdue:false,balanceMinor:-250,paidMinor:0});
 assert.deepEqual(summarizeBill('active',[old,due,{...credit,total:-50,balance:-50}],'UTC',day),{state:'due',overdue:true,balanceMinor:150,paidMinor:0});
 assert.equal(summarizeBill('active',[due,{...credit,total:-200,balance:-200}],'UTC',day).state,'offset');
});


test('pending issued balances remain real while no invoice, credit and offset are distinct',()=>{
 const charge={status:'open',total:5000,paid:0,balance:5000,dueOn:'2026-03-08'};
 const credit={status:'open',total:-4000,paid:0,balance:-4000,dueOn:'2026-03-08'};
 assert.deepEqual(summarizeBill('pending_signature',[charge],'UTC',day),{state:'due',overdue:true,balanceMinor:5000,paidMinor:0});
 assert.equal(summarizeBill('pending_signature',[credit],'UTC',day).state,'credit');
 assert.equal(summarizeBill('pending_signature',[credit,{...charge,total:4000,balance:4000}],'UTC',day).state,'offset');
 assert.deepEqual(summarizeBill('pending_signature',[credit,charge],'UTC',day),{state:'due',overdue:true,balanceMinor:1000,paidMinor:0});
 assert.equal(summarizeBill('pending_signature',[{...charge,total:0,balance:0}],'UTC',day).state,'zero_charge');
});
