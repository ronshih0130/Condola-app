import assert from 'node:assert/strict';
import test from 'node:test';
import { planMonthlyRentOperation, type MonthlyRentOperationSource } from './monthly-rent-operation-plan';

const source:MonthlyRentOperationSource={orgId:'org',environment:'live',month:'2028-02',capped:false,
 lease:{id:'lease',status:'active',property_currency:'USD',property_id:'property',property_name:'Property',unit_label:'Unit',start_date:'2020-01-01',end_date:null,terminated_on:null,moved_out_on:null,currency:'USD',currency_config:{minorUnit:2,displayDecimals:2},rent:'900719925474099312345',frequency:'monthly',due_day:31},
 parties:[{partyId:'party',contactId:'payer',contactOrgId:'org',payerName:'Payer',isTenant:true,archivedAt:null,rentShareBp:null}],rent:[]};
test('positive full-month rent binds payer, property, currency configuration and source',()=>{
 const plan=planMonthlyRentOperation(source);assert.equal(plan.kind,'supported');if(plan.kind!=='supported')throw Error();
 assert.equal(plan.operation.amountMinor,'900719925474099312345');assert.equal(plan.operation.dueDate,'2028-02-29');assert.equal(plan.operation.periodEnd,'2028-02-29');assert.equal(plan.operation.servicePeriodEndExclusive,'2028-03-01');
 assert.deepEqual(planMonthlyRentOperation(source),plan);
 for(const changed of [
  {...source,parties:[{...source.parties[0],contactId:'another'}]},
  {...source,lease:{...source.lease,property_id:'another'}},
  {...source,lease:{...source.lease,currency:'JPY',property_currency:'JPY',currency_config:{minorUnit:0,displayDecimals:0}}},
  {...source,lease:{...source.lease,rent:'123'}},
 ]) {const next=planMonthlyRentOperation(changed);assert.equal(next.kind,'supported');if(next.kind==='supported')assert.notEqual(next.operation.digest,plan.operation.digest);}
});
test('unsupported inputs have no operation digest',()=>{
 const unknown={lease_id:'lease',invoice_id:'i',invoice_number:'I',line_id:'l',status:'open',source:'move_in',period:null,amount:'1',currency:'USD',overlaps:false,exact:false};
 const cases:[MonthlyRentOperationSource,string][]=[
  [{...source,parties:[]},'payer_missing'],[{...source,parties:[...source.parties,{...source.parties[0],partyId:'p2'}]},'payer_ambiguous'],
  [{...source,parties:[{...source.parties[0],archivedAt:'2026-01-01'}]},'payer_unusable'],
  [{...source,parties:[{...source.parties[0],contactOrgId:'foreign'}]},'payer_unusable'],
  [{...source,parties:[{...source.parties[0],isTenant:false}]},'payer_unusable'],
  [{...source,lease:{...source.lease,property_currency:'TWD'}},'invalid_source'],[{...source,lease:{...source.lease,rent:'0'}},'zero_rent'],[{...source,lease:{...source.lease,start_date:'2028-02-02'}},'partial_or_moveout'],
  [{...source,lease:{...source.lease,moved_out_on:'2028-02-20'}},'partial_or_moveout'],[{...source,lease:{...source.lease,frequency:'quarterly'}},'unsupported_frequency'],
  [{...source,lease:{...source.lease,due_day:30}},'due_day_unavailable'],[{...source,lease:{...source.lease,currency_config:{minorUnit:8,displayDecimals:2}}},'invalid_currency_config'],
  [{...source,rent:[unknown]},'historical_period_unknown'],[{...source,rent:[{...unknown,period:'empty'}]},'historical_period_unknown'],[{...source,rent:[{...unknown,period:'[2028-02-01,2028-03-01)',overlaps:true,exact:true,status:'void'}]},'coverage_conflict'],
  [{...source,rent:[{...unknown,period:'[2028-02-01,2028-03-01)',overlaps:true,exact:true}]},'existing_rent'],
  [{...source,month:'9999-12'},'period_out_of_range'],[{...source,capped:true},'source_cap'],[{...source,lease:{...source.lease,status:'ended'}},'inactive_lease'],
 ];
 for(const [item,reason] of cases)assert.deepEqual(planMonthlyRentOperation(item),{kind:'unsupported',reason});
});
