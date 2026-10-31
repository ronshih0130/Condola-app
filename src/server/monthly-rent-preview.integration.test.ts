import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { buildStoredConsent } from './consent';
import { ORG_ID,ORG2_ID,USERS } from './ids';
import { monthlyRentPreview } from './monthly-rent-preview';
import { monthlyBillingPlan } from './monthly-billing-plan';
import { formatConfiguredMinor } from './monthly-billing-rules';
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
 await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
 await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
 await db.query(`INSERT INTO currencies(code,minor_unit,display_decimals,name) VALUES('JPY',0,0,'Synthetic Yen') ON CONFLICT(code) DO UPDATE SET minor_unit=0,display_decimals=0`);
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
async function financialFacts(){return (await db.query(`SELECT
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM invoices t) invoices,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM invoice_lines t) lines,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM ledger_transactions t) ledger,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM ledger_entries t) entries,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM payments t) payments,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM payment_allocations t) payment_allocations,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM utility_allocation_runs t) utility_runs,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM utility_allocation_lines t) utility_lines,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM lease_charges t) charges,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM owner_statements t) statements,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM owner_statement_lines t) statement_lines,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM audit_log t) audit,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM notifications t) notices,
 (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM deliveries t) deliveries`)).rows[0];}
for(const currency of ['TWD','USD','JPY'])test(`${currency} rent preview uses reference scale, stable digest and no writes`,async()=>{
 const f=await fixture(currency);await party(f);const before=await financialFacts();const preview=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(preview);assert.equal(preview.kind,'supported');if(preview.kind!=='supported')throw Error('unsupported');
 assert.equal(preview.operation.payerId,f.payer);assert.equal(preview.operation.dueDate,'2028-02-29');assert.equal(preview.operation.version,'monthly-rent-operation-v1');assert.equal(formatConfiguredMinor(preview.operation.amountMinor,preview.operation.currencyConfig),currency==='JPY'?'100000':currency==='TWD'?'1000':'1000.00');
 const repeat=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(repeat&&repeat.kind==='supported');if(!repeat||repeat.kind!=='supported')throw Error();assert.equal(repeat.operation.digest,preview.operation.digest);assert.deepEqual(await financialFacts(),before);
 const list=await monthlyBillingPlan(session,'2028-02');assert.ok(list&&list.kind==='complete');if(!list||list.kind!=='complete')throw Error();assert.deepEqual(list.rows.find(r=>r.leaseId===f.lease)?.currencyConfig,preview.operation.currencyConfig);
 if(currency==='JPY') {
  await db.query(`UPDATE currencies SET display_decimals=1 WHERE code='JPY'`);
  const updated=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(updated&&updated.kind==='supported');if(!updated||updated.kind!=='supported')throw Error();assert.notEqual(updated.operation.digest,preview.operation.digest);
  const changed=await monthlyBillingPlan(session,'2028-02');assert.ok(changed&&changed.kind==='complete');if(!changed||changed.kind!=='complete')throw Error();assert.notEqual(changed.digest,list.digest);
  await db.query(`UPDATE currencies SET display_decimals=0 WHERE code='JPY'`);
 }
});
test('primary payer count, archived contact, changed payer and rent evidence fail closed',async()=>{
 const f=await fixture();assert.equal((await monthlyRentPreview(session,f.lease,'2028-02'))?.kind,'unsupported');const first=await party(f);let p=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(p&&p.kind==='supported');if(!p||p.kind!=='supported')throw Error();const digest=p.operation.digest;
 const other=(await db.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,$2) RETURNING id`,[ORG_ID,randomUUID()])).rows[0].id;await party(f,other);
 assert.equal((await monthlyRentPreview(session,f.lease,'2028-02'))?.kind,'unsupported');await db.query(`DELETE FROM lease_parties WHERE id=$1`,[first]);p=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(p&&p.kind==='supported');if(!p||p.kind!=='supported')throw Error();assert.notEqual(p.operation.digest,digest);
 await db.query(`UPDATE contacts SET archived_at=now() WHERE id=$1`,[other]);const archived=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(archived&&archived.kind==='unsupported');if(archived?.kind==='unsupported')assert.equal(archived.reason,'payer_unusable');
 await db.query(`UPDATE contacts SET archived_at=NULL WHERE id=$1`,[other]);
 const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,source) VALUES($1,$2,$3,$4,'TWD',current_date,'open','recurring') RETURNING id`,[ORG_ID,f.property,f.lease,randomUUID()])).rows[0].id;
 await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','fixture',100000,100000)`,[ORG_ID,invoice]);
 const unknown=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(unknown&&unknown.kind==='unsupported');if(unknown?.kind==='unsupported')assert.equal(unknown.reason,'historical_period_unknown');
});
test('actual manager session, linked sandbox, role changes, scope and controls',async()=>{
 const manager=await makeSession(USERS.manager,'manager',ORG_ID,'live',ORG_ID),f=await fixture();await party(f);assert.equal((await monthlyRentPreview(manager,f.lease,'2028-02'))?.kind,'supported');
 await db.query(`UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`,[manager.sessionId]);assert.equal(await monthlyRentPreview(manager,f.lease,'2028-02'),null);await db.query(`UPDATE auth_sessions SET expires_at=now()+interval '1 day' WHERE id=$1`,[manager.sessionId]);
 assert.equal(await monthlyRentPreview({...manager,orgId:ORG2_ID},f.lease,'2028-02'),null);assert.equal(await monthlyRentPreview({...manager,sessionId:randomUUID()},f.lease,'2028-02'),null);assert.equal(await monthlyRentPreview({...manager,environment:'sandbox'},f.lease,'2028-02'),null);assert.equal(await monthlyRentPreview(manager,'invalid','2028-02'),null);assert.equal(await monthlyRentPreview(manager,f.lease,'2028-13'),null);
 const sandbox=(await db.query<{id:string}>(`INSERT INTO organizations(name,country_code,default_currency,feature_flags,environment,live_org_id) VALUES($1,'TW','TWD','{"billing_previews":true}','sandbox',$2) RETURNING id::text`,[randomUUID(),ORG_ID])).rows[0].id;
 const sf=await fixture('TWD',sandbox);await party(sf);await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='billing_previews'`,[ORG_ID,sandbox]);
 const sm={...manager,orgId:sandbox,environment:'sandbox' as const};assert.equal((await monthlyRentPreview(sm,sf.lease,'2028-02'))?.kind,'supported');
 await db.query(`UPDATE org_members SET role='maintenance' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);assert.equal(await monthlyRentPreview(sm,sf.lease,'2028-02'),null);
 await db.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);assert.equal(await monthlyRentPreview(session,f.lease,'2028-02'),null);
});

test('a positive rent line with an empty service range remains unknown in both previews',async()=>{
 await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
 const f=await fixture();await party(f);
 const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,source) VALUES($1,$2,$3,$4,'TWD',current_date,'open','recurring') RETURNING id`,[ORG_ID,f.property,f.lease,randomUUID()])).rows[0].id;
 const line=(await db.query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor,service_period) VALUES($1,$2,1,'rent','fixture',100000,100000,'empty'::daterange) RETURNING id`,[ORG_ID,invoice])).rows[0].id;
 const result=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(result&&result.kind==='unsupported');if(result?.kind==='unsupported')assert.equal(result.reason,'historical_period_unknown');
 const list=await monthlyBillingPlan(session,'2028-02');assert.ok(list&&list.kind==='complete');if(!list||list.kind!=='complete')throw Error();const row=list.rows.find(item=>item.leaseId===f.lease);assert.equal(row?.reason,'historical_period_unknown');assert.ok(row?.evidenceRefs.some(ref=>ref.lineId===line));
});
test('bounded relevant rent evidence returns an explicit cap reason',async()=>{
 await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
 const f=await fixture();await party(f);
 const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,source) VALUES($1,$2,$3,$4,'TWD',current_date,'open','recurring') RETURNING id`,[ORG_ID,f.property,f.lease,randomUUID()])).rows[0].id;
 await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) SELECT $1,$2,n::smallint,'rent','fixture',1,1 FROM generate_series(1,2001) n`,[ORG_ID,invoice]);
 const result=await monthlyRentPreview(session,f.lease,'2028-02');assert.ok(result&&result.kind==='unsupported');if(result?.kind==='unsupported')assert.equal(result.reason,'source_cap');
});

