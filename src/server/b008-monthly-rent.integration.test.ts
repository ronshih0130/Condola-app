import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { buildStoredConsent } from './consent';
import { ORG_ID,ORG2_ID,USERS } from './ids';
import { monthlyRentPreview } from './monthly-rent-preview';
import { writeMonthlyRent } from './monthly-rent-writer';
import { recordPeriodDueComponent } from './period-due-components';
import { resetAndSeed } from './seed';
import { disposableDbUrl,withDatabase } from './test-disposable-db';
import type { Session } from './types';

const source=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE),previous=process.env.DATABASE_URL;
let admin:Client,db:Client,name:string,owned=false,session:Session;
test.before(async()=>{
 const template=decodeURIComponent(source.pathname.slice(1));if(!/^[a-z][a-z0-9_]{0,62}$/.test(template))throw Error('Invalid template');
 name=`condola_b008_${randomUUID().replaceAll('-','')}`;admin=new Client({connectionString:withDatabase(source,'postgres')});await admin.connect();await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);owned=true;
 db=new Client({connectionString:withDatabase(source,name)});await db.connect();process.env.DATABASE_URL=withDatabase(source,name);
 const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
 session=await makeSession(USERS.admin,'admin',ORG_ID,'live',ORG_ID);
});
test.after(async()=>{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;await db?.end();if(owned)await admin.query(`DROP DATABASE "${name}"`);await admin?.end();});
async function makeSession(userId:string,role:Session['role'],orgId:string,environment:Session['environment'],liveOrgId:string):Promise<Session>{
 const sid=(await db.query<{id:string}>(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id::text`,[userId,randomUUID()])).rows[0].id;
 const consent=buildStoredConsent('signup');await db.query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,[userId,consent.accepted_at,consent.terms_version,consent.privacy_version,consent.source]);
 return {userId,sessionId:sid,email:'fixture@example.invalid',name:'fixture',kind:'staff',role,orgId,liveOrgId,environment,locale:'en',calendar:'gregorian',leaseId:null,consent};
}
async function fixture(currency='TWD',orgId=ORG_ID){
 const property=(await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW',$3,'Asia/Taipei') RETURNING id`,[orgId,randomUUID(),currency])).rows[0].id;
 const unit=(await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,$3) RETURNING id`,[orgId,property,randomUUID()])).rows[0].id;
 const lease=(await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,due_day) VALUES($1,$2,$3,$3,'active','2028-01-01',$4,100000,31) RETURNING id`,[orgId,property,unit,currency])).rows[0].id;
 const payer=(await db.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,$2) RETURNING id`,[orgId,randomUUID()])).rows[0].id;
 return {orgId,property,unit,lease,payer};
}
async function party(f:Awaited<ReturnType<typeof fixture>>,contact=f.payer){return (await db.query<{id:string}>(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary') RETURNING id`,[f.orgId,f.lease,contact])).rows[0].id;}
async function setFlags(on:boolean){
 await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('billing_previews',$2::boolean,'monthly_rent_posting',$2::boolean) WHERE id=$1`,[ORG_ID,on]);
 await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('billing_previews','monthly_rent_posting')`,[ORG_ID,on]);
}
const tables=['invoices','invoice_lines','ledger_transactions','ledger_entries','app.b008_monthly_rent_occurrences','app.b008_monthly_rent_commands','app.tenant_period_due_components'] as const;
async function counts(){
 const values=await Promise.all(tables.map(async table=>Number((await db.query<{count:string}>(`SELECT count(*) FROM ${table}`)).rows[0].count)));
 return Object.fromEntries(tables.map((table,index)=>[table,values[index]])) as Record<typeof tables[number],number>;
}
async function digest(lease:string){
 const preview=await monthlyRentPreview(session,lease,'2028-02');assert.ok(preview&&preview.kind==='supported');if(!preview||preview.kind!=='supported')throw Error('unsupported');
 return preview.operation.digest;
}
function componentInput(leaseId:string){
 return {leaseId,periodYm:'2028-02',component:{componentKey:randomUUID(),amountMinor:'500',currency:'TWD',sourceRefKind:'manual' as const,sourceRefId:randomUUID()}};
}

test('posting disabled rejects rent and period components without writes',async()=>{
 await setFlags(false);
 await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
 await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
 const f=await fixture();await party(f);const expectedDigest=await digest(f.lease);
 const before=await counts();
 const result=await writeMonthlyRent(session,{leaseId:f.lease,month:'2028-02',requestId:randomUUID(),expectedDigest});
 assert.equal(result.status,'rejected_disabled');
 const component=await recordPeriodDueComponent(session,componentInput(f.lease));
 assert.deepEqual(component,{ok:false,reason:'disabled'});
 assert.deepEqual(await counts(),before);
});
test('posting creates one balanced rent invoice and records a period component',async()=>{
 await setFlags(true);
 const f=await fixture();await party(f);const expectedDigest=await digest(f.lease),before=await counts();
 const transactions=(await db.query<{id:string}>(`SELECT id::text FROM ledger_transactions`)).rows.map(row=>row.id);
 const result=await writeMonthlyRent(session,{leaseId:f.lease,month:'2028-02',requestId:randomUUID(),expectedDigest});
 assert.equal(result.status,'created');assert.ok(result.invoiceId);assert.ok(result.occurrenceId);
 const after=await counts();
 assert.deepEqual(after,{...before,invoices:before.invoices+1,invoice_lines:before.invoice_lines+1,ledger_transactions:before.ledger_transactions+1,ledger_entries:before.ledger_entries+2,'app.b008_monthly_rent_occurrences':before['app.b008_monthly_rent_occurrences']+1,'app.b008_monthly_rent_commands':before['app.b008_monthly_rent_commands']+1});
 const created=(await db.query<{id:string}>(`SELECT id::text FROM ledger_transactions WHERE NOT (id::text=ANY($1::text[]))`,[transactions])).rows;
 assert.equal(created.length,1);
 const entries=(await db.query<{count:string,total:string}>(`SELECT count(*),sum(amount_minor)::text AS total FROM ledger_entries WHERE transaction_id=$1`,[created[0].id])).rows[0];
 assert.equal(Number(entries.count),2);assert.equal(entries.total,'0');
 assert.deepEqual(await recordPeriodDueComponent(session,componentInput(f.lease)),{ok:true});
 assert.deepEqual(await counts(),{...after,'app.tenant_period_due_components':after['app.tenant_period_due_components']+1});
});
test('request replay, occurrence deduplication and conflicting digests fail closed',async()=>{
 await setFlags(true);
 const f=await fixture();await party(f);const expectedDigest=await digest(f.lease),requestId=randomUUID();
 const input={leaseId:f.lease,month:'2028-02',requestId,expectedDigest};
 const first=await writeMonthlyRent(session,input);assert.equal(first.status,'created');assert.ok(first.invoiceId);
 const before=await counts(),replay=await writeMonthlyRent(session,input);
 assert.equal(replay.replay,true);assert.equal(replay.invoiceId,first.invoiceId);assert.deepEqual(await counts(),before);
 const duplicate=await writeMonthlyRent(session,{...input,requestId:randomUUID()});
 assert.equal(duplicate.status,'already_issued');assert.equal(duplicate.invoiceId,first.invoiceId);
 assert.equal((await counts()).invoices,before.invoices);
 const differentDigest=expectedDigest==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64);
 assert.equal((await writeMonthlyRent(session,{...input,expectedDigest:differentDigest})).status,'rejected_conflict');
 assert.equal((await counts()).invoices,before.invoices);
});
test('authenticated cannot access internal tables and unauthorized sessions cannot write',async()=>{
 await setFlags(true);
 const f=await fixture();await party(f);const expectedDigest=await digest(f.lease);
 const beforePermissions=await counts();
 await db.query('BEGIN');
 try{
  await db.query('SET LOCAL ROLE authenticated');
  for(const table of ['app.b008_monthly_rent_occurrences','app.b008_monthly_rent_commands']){
   for(const statement of [`SELECT * FROM ${table}`,`INSERT INTO ${table} DEFAULT VALUES`,`UPDATE ${table} SET id=id`,`DELETE FROM ${table}`]){
    await db.query('SAVEPOINT denied_statement');
    try{
     await assert.rejects(db.query(statement),(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='42501');
    }finally{
     await db.query('ROLLBACK TO SAVEPOINT denied_statement');
     await db.query('RELEASE SAVEPOINT denied_statement');
    }
   }
  }
 }finally{
  await db.query('ROLLBACK');
 }
 assert.deepEqual(await counts(),beforePermissions);
 const manager=await makeSession(USERS.manager,'manager',ORG_ID,'live',ORG_ID);
 const unauthorized:Session[]=[{...session,orgId:ORG2_ID},{...session,environment:'sandbox'},manager,{...session,kind:'tenant'}];
 for(const denied of unauthorized){
  const before=await counts();
  const result=await writeMonthlyRent(denied,{leaseId:f.lease,month:'2028-02',requestId:randomUUID(),expectedDigest});
  assert.notEqual(result.status,'created');
  const component=await recordPeriodDueComponent(denied,componentInput(f.lease));
  assert.equal(component.ok,false);
  if(denied===manager||denied.kind==='tenant'){
   assert.equal(result.status,'rejected_disabled');
   assert.ok(!component.ok);if(!component.ok)assert.equal(component.reason,'forbidden');
  }
  assert.deepEqual(await counts(),before);
 }
});
