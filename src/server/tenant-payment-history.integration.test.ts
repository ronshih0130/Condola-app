import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { query, tx, withClient } from './db';
import { buildStoredConsent } from './consent';
import { confirmPayment, recordPayment, rejectPayment, reversePayment } from './domain';
import { tenantPaymentHistory } from './tenant-payment-history';
import { tenantBillLines } from './money';
import { tenantPayeeVisible } from './pay-note';
import { safeMinor, sumMinor } from './tenant-payment-history-rules';
import { prepareUtilityRun, confirmUtilityRun, currentUtilityPeriod } from './utility-posting';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { resetAndSeed } from './seed';
import { ORG_ID, ORG2_ID, USERS } from './ids';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
type OrgControl={id:string;environment:string;live_org_id:string|null;flags:Record<string,unknown>};
type SettingControl={key:string;value:unknown;description:string|null;updated_at:string};
type Controls={database:string;orgs:OrgControl[];settings:SettingControl[];registry:string[]};
let childName:string|undefined,offBaseline:Controls|undefined;
const targetKey='tenant_payment_history';
const seedFlags={branded_line_oa:false,line_alerts:true};
const offFlags={branded_line_oa:false,line_alerts:false};
function ordered(value:unknown):unknown {if(Array.isArray(value))return value.map(ordered);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)]));return value;}
function same(a:unknown,b:unknown):boolean{return JSON.stringify(ordered(a))===JSON.stringify(ordered(b));}
function evidence(name:string,value:unknown) {
 const path=process.env.B018_OUTPUT;if(!path)return;
 if(!path.startsWith('/')||!statSync(path).isDirectory()||realpathSync(path)!==path)throw Error('Child evidence directory rejected');
 const fd=openSync(join(path,name),'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const directory=openSync(path,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
function registryKeys():string[] {
 const registry=[...new Set([...readFileSync('ops/flags.yaml','utf8').matchAll(/^    global_kill:.*?platform_settings\.([A-Za-z0-9_]+)/gm)].map(m=>m[1]))].sort();
 if(registry.length<10||!registry.includes(targetKey)||!registry.includes('company_profile_edit'))throw Error('Incomplete registry');return registry;
}
async function controls(c:Client):Promise<Controls>{
 const database=(await c.query<{database:string;version:number}>(`SELECT current_database() database,current_setting('server_version_num')::int version`)).rows[0];
 if(!childName||database.database!==childName||!/^condola_test_[0-9a-f]{32}$/.test(childName)||![16,17].includes(Math.floor(database.version/10000)))throw Error('Owned child identity mismatch');
 const orgs=(await c.query<OrgControl>(`SELECT id::text,environment::text,live_org_id::text,feature_flags flags FROM organizations ORDER BY id`)).rows;
 const settings=(await c.query<SettingControl>(`SELECT key,value,description,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') updated_at FROM platform_settings ORDER BY key`)).rows;
 return {database:database.database,orgs,settings,registry:registryKeys()};
}
function validateSeed(v:Controls) {
 if(v.orgs.length!==2||!same(v.orgs.map(x=>x.id).sort(),[ORG_ID,ORG2_ID].sort())||v.orgs.some(x=>x.environment!=='live'||x.live_org_id!==null||!same(x.flags,seedFlags)))throw Error('Unexpected seed organizations or flags');
 const allow=new Set([...v.registry,'deposit_settlement','go_live_lock','id_documents.max_retention_days_after_close','id_documents.org_retention_locked']);
 if(v.settings.some(x=>!allow.has(x.key))||v.settings.some(x=>x.key===targetKey))throw Error('Unknown setting or B018 already present');
 // Global-only flags (no org allowlist), e.g. B-031 session_hardening, are OFF as {enabled:false}.
 const globalOnly=new Set(['session_hardening']);
 for(const row of v.settings.filter(x=>v.registry.includes(x.key)))if(!same(row.value,globalOnly.has(row.key)?{enabled:false}:{enabled:false,allowed_org_ids:[]}))throw Error('Unexpected registry flag');
 const settlement=v.settings.filter(x=>x.key==='deposit_settlement');
 if(settlement.length!==1||!same(settlement[0].value,{enabled:false,allowed_org_ids:[]}))throw Error('Unexpected B011 settlement flag');
 for(const [key,value] of [['go_live_lock',false],['id_documents.max_retention_days_after_close',90],['id_documents.org_retention_locked',true]] as const){const found=v.settings.filter(x=>x.key===key);if(found.length!==1||!same(found[0].value,value))throw Error('Protective control mismatch');}
}
function validateFinal(before:Controls,after:Controls){
 if(before.database!==after.database||!same(before.registry,after.registry)||after.orgs.length!==2)throw Error('Child identity or registry changed');
 for(const prior of before.orgs){const row=after.orgs.find(x=>x.id===prior.id);if(!row||row.environment!==prior.environment||row.live_org_id!==prior.live_org_id)throw Error('Child org identity changed');const flags={...row.flags};if(row.id===ORG_ID){if('tenant_payment_history' in flags && flags.tenant_payment_history!==true && flags.tenant_payment_history!==false)throw Error('Unexpected B018 org value');delete flags.tenant_payment_history;}if(!same(flags,prior.flags))throw Error('Child org flags changed');}
 if(!same(after.settings.filter(x=>x.key!==targetKey),before.settings))throw Error('Other child settings changed');
 const changed=after.settings.filter(x=>x.key===targetKey);if(changed.length>1)throw Error('Duplicate B018 setting');
 if(changed.length){const v=changed[0];if(v.description!==null||!(same(v.value,{enabled:true,allowed_org_ids:[ORG_ID]})||same(v.value,{enabled:'true',allowed_org_ids:[]})))throw Error('Unexpected B018 setting');}
}
test.before(async()=>{
 clone=await cloneTestDatabase();childName=decodeURIComponent(new URL(clone.url).pathname.slice(1));
 const keys=['DEMO_MODE','ID_DOC_ENCRYPTION_KEY','ID_DOC_HMAC_KEY','ID_DOC_SIGNING_SECRET','CRON_SECRET'] as const;const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{process.env.DEMO_MODE='true';for(const k of keys.slice(1))process.env[k]=randomBytes(32).toString('hex');await resetAndSeed();}finally{for(const k of keys){const v=saved[k];if(v===undefined)delete process.env[k];else process.env[k]=v;}}
 const c=new Client({connectionString:clone.url});await c.connect();try{
  const before=await controls(c);validateSeed(before);evidence('b018-child-fixture-intent.json',{database:childName,seed:before,change:'only the two validated line_alerts booleans to false'});
  await c.query('BEGIN');try{const changed=await c.query<{id:string}>(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{line_alerts}','false'::jsonb) WHERE id=ANY($1::uuid[]) AND environment='live' AND live_org_id IS NULL AND feature_flags=$2::jsonb RETURNING id::text`,[[ORG_ID,ORG2_ID],JSON.stringify(seedFlags)]);if(changed.rowCount!==2||!same(changed.rows.map(x=>x.id).sort(),[ORG_ID,ORG2_ID].sort()))throw Error('Child flag CAS mismatch');await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}
  const after=await controls(c);const expected={...before,orgs:before.orgs.map(x=>({...x,flags:offFlags}))};if(!same(after,expected))throw Error('Child OFF baseline mismatch');evidence('b018-child-off-baseline.json',after);offBaseline=after;
 }finally{await c.end();}
});
test.after(async()=>{
 if(!clone)return;
 const c=new Client({connectionString:clone.url});let failure:unknown=null;let after:Controls|undefined;
 try{await c.connect();after=await controls(c);if(!offBaseline)throw Error('No validated OFF baseline');validateFinal(offBaseline,after);}catch(error){failure=error;}finally{await c.end().catch(()=>{});}
 try{evidence('b018-child-final-controls.json',{database:childName,status:failure?'quarantined':'validated',after:after??null});}catch(error){failure=failure??error;}
 if(failure){process.stderr.write(`B018 owned child quarantined: ${childName??'unknown'}\n`);throw failure;}
 await clone.cleanup();
});
async function tenant(org=ORG_ID) {
 const userId=randomUUID(),sessionId=randomUUID(),consent=buildStoredConsent('signup');
 await query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[userId,`${randomUUID()}@example.test`]);
 await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sessionId,userId,randomUUID()]);
 await query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,[userId,consent.accepted_at,consent.terms_version,consent.privacy_version,consent.source]);
 const contact=(await query<{id:string}>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES($1,$2,true,'Synthetic tenant') RETURNING id::text`,[org,userId])).rows[0].id;
 const s:Session={userId,sessionId,email:'',name:'Synthetic',kind:'tenant',role:null,orgId:org,liveOrgId:org,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,consent};return {s,contact};
}
async function fixture(contact:string,org=ORG_ID,period={start:'2090-01-01',end:'2090-12-31'}) {
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[org,`Payment ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'Floor','by_room') RETURNING id::text`,[org,p])).rows[0].id;
 const room=(await query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'A') RETURNING id::text`,[org,u])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,'active','imported',$5::date,$6::date,'TWD',0) RETURNING id::text`,[org,p,u,room,period.start,period.end])).rows[0].id;
 await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[org,lease,contact]);return {p,u,room,lease};
}
async function enable(){await query(`INSERT INTO platform_settings(key,value) VALUES('tenant_payment_history',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[ORG_ID]);await query(`UPDATE organizations SET feature_flags=feature_flags||'{"tenant_payment_history":true}'::jsonb WHERE id=$1`,[ORG_ID]);}
async function invoice(p:string,lease:string){const id=(await query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD','2090-03-01','open') RETURNING id::text`,[ORG_ID,p,lease,randomUUID()])).rows[0].id;await query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic rent',100000,100000)`,[ORG_ID,id]);return id;}

test('normal tenant report has personal history and separately projected original insert after current row changes',async()=>{
 const a=await tenant(),b=await tenant(),f=await fixture(a.contact);await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')`,[ORG_ID,f.lease,b.contact]);await invoice(f.p,f.lease);
 assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'current'})).state,'off');await enable();
 const result=await recordPayment(a.s,{leaseId:f.lease,amountMajor:100,paidOn:'2090-01-17',last5:'12345',reference:''});assert.ok('paymentId' in result);if(!('paymentId' in result))throw Error('Missing report');
 const own=await tenantPaymentHistory(a.s,f.lease,{view:'current',reportId:result.paymentId});assert.equal(own.state,'ready');if(own.state!=='ready')throw Error('Unavailable');assert.equal(own.reports.length,1);assert.equal(own.reports[0].status,'submitted');assert.equal(own.bill.pending,true);assert.equal(own.reports[0].original.state,'available');if(own.reports[0].original.state!=='available')throw Error('Original unavailable');const amount=own.reports[0].original.amountMinor;
 await query(`UPDATE payments SET amount_minor=amount_minor+100,paid_on='2090-01-18' WHERE id=$1`,[result.paymentId]);
 const changed=await tenantPaymentHistory(a.s,f.lease,{view:'current',reportId:result.paymentId});assert.equal(changed.state,'ready');if(changed.state!=='ready')throw Error('Unavailable');assert.equal(changed.reports[0].current.amountMinor,amount+100);assert.deepEqual(changed.reports[0].original,{state:'available',amountMinor:amount,currency:'TWD',paidOn:'2090-01-17'});
 // Existing broad RLS permits the co-tenant row; this DTO deliberately does not.
 const broad=await tx(b.s.userId,c=>c.query('SELECT id FROM payments WHERE id=$1',[result.paymentId]),{orgId:ORG_ID,environment:'live'},{readOnly:true});assert.equal(broad.rowCount,1);
 const other=await tenantPaymentHistory(b.s,f.lease,{view:'current'});assert.equal(other.state,'ready');if(other.state==='ready')assert.equal(other.reports.length,0);
 assert.equal((await tenantPaymentHistory(b.s,f.lease,{view:'current',reportId:result.paymentId})).state,'unavailable');
 await query(`INSERT INTO audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,new_row) SELECT org_id,actor_user_id,actor_role,table_name,row_id,action,new_row FROM audit_log WHERE table_name='payments' AND action='insert' AND row_id=$1`,[result.paymentId]);const duplicate=await tenantPaymentHistory(a.s,f.lease,{view:'current',reportId:result.paymentId});assert.equal(duplicate.state,'ready');if(duplicate.state==='ready')assert.equal(duplicate.reports[0].original.state,'unavailable');
 await query(`UPDATE leases SET status='ended' WHERE id=$1`,[f.lease]);const ended=await tenantPaymentHistory(a.s,f.lease,{view:'ended',reportId:result.paymentId});assert.equal(ended.state,'ready');if(ended.state==='ready'){assert.equal(ended.lease.canReport,false);assert.equal(ended.reports[0].id,result.paymentId);}
});

test('fresh tenant context, strict flags and exact selectors fail closed',async()=>{
 const a=await tenant(),b=await tenant(ORG2_ID),f=await fixture(a.contact),foreign=await fixture(b.contact,ORG2_ID);await enable();
 assert.equal((await tenantPaymentHistory(a.s,foreign.lease,{view:'current'})).state,'unavailable');assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'current',cursor:randomUUID()})).state,'unavailable');
 assert.equal((await tenantPaymentHistory({...a.s,kind:'owner'},f.lease,{view:'current'})).state,'unavailable');assert.equal((await tenantPaymentHistory({...a.s,environment:'sandbox'},f.lease,{view:'current'})).state,'unavailable');
 await query(`UPDATE platform_settings SET value='{"enabled":"true","allowed_org_ids":[]}'::jsonb WHERE key='tenant_payment_history'`);assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'current'})).state,'off');await enable();
 await query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[a.s.sessionId]);assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'current'})).state,'unavailable');
});


test('normal rejection, new report, confirmation and reversal preserve distinct history and current balance',async()=>{
 const a=await tenant(),f=await fixture(a.contact);await invoice(f.p,f.lease);await enable();
 const sessionId=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sessionId,USERS.admin,randomUUID()]);
 const staff:Session={userId:USERS.admin,sessionId,email:'',name:'staff',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const first=await recordPayment(a.s,{leaseId:f.lease,amountMajor:100,paidOn:'2090-01-17',last5:'12345',reference:''});if(!('paymentId' in first))throw Error('Missing report');
 await rejectPayment(staff,first.paymentId,'Synthetic reason');const rejected=await tenantPaymentHistory(a.s,f.lease,{view:'current',reportId:first.paymentId});assert.equal(rejected.state,'ready');if(rejected.state!=='ready')throw Error('Unavailable');assert.equal(rejected.reports[0].status,'rejected');assert.equal(rejected.reports[0].rejectionReason,'Synthetic reason');
 const next=await recordPayment(a.s,{leaseId:f.lease,amountMajor:100,paidOn:'2090-01-18',last5:'12345',reference:''});if(!('paymentId' in next))throw Error('Missing report');assert.notEqual(next.paymentId,first.paymentId);
 await confirmPayment(staff,next.paymentId);const confirmed=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(confirmed.state,'ready');if(confirmed.state!=='ready')throw Error('Unavailable');assert.equal(confirmed.reports.find(x=>x.id===next.paymentId)?.status,'confirmed');assert.ok(confirmed.bill.paidMinor>0);assert.equal(confirmed.bill.state,'partial');
 await reversePayment(staff,next.paymentId,'Private staff note');const reversed=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(reversed.state,'ready');if(reversed.state!=='ready')throw Error('Unavailable');assert.equal(reversed.reports.find(x=>x.id===next.paymentId)?.status,'reversed');assert.equal(reversed.reports.find(x=>x.id===next.paymentId)?.reversalReason,'unavailable');assert.ok(reversed.bill.balanceMinor>confirmed.bill.balanceMinor);assert.ok(reversed.reports.some(x=>x.id===first.paymentId));
});

test('same-timestamp reports use an own-row cursor without exposing another tenant',async()=>{
 const a=await tenant(),b=await tenant(),f=await fixture(a.contact);await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')`,[ORG_ID,f.lease,b.contact]);await enable();
 await query(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by,submitted_at) SELECT $1,$2,$3,$4,'TWD',100,'2090-01-01','bank_transfer','submitted','tenant_portal',$5,'2090-01-01T00:00:00Z' FROM generate_series(1,51)`,[ORG_ID,f.p,f.lease,a.contact,a.s.userId]);
 const page=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(page.state,'ready');if(page.state!=='ready')throw Error('Unavailable');assert.equal(page.reports.length,50);assert.ok(page.nextCursor);
 const second=await tenantPaymentHistory(a.s,f.lease,{view:'current',cursor:page.nextCursor!});assert.equal(second.state,'ready');if(second.state!=='ready')throw Error('Unavailable');assert.equal(second.reports.length,1);assert.equal(second.nextCursor,null);assert.equal(new Set([...page.reports,...second.reports].map(x=>x.id)).size,51);
 assert.equal((await tenantPaymentHistory(b.s,f.lease,{view:'current',cursor:page.nextCursor!})).state,'unavailable');
});

test('view modes reject status transitions and later expired or archived caller',async()=>{
 const a=await tenant(),f=await fixture(a.contact);await enable();
 assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'ended'})).state,'unavailable');
 await query(`UPDATE leases SET status='pending_signature' WHERE id=$1`,[f.lease]);const unsigned=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(unsigned.state,'ready');if(unsigned.state==='ready'){assert.equal(unsigned.bill.state,'unsigned');assert.equal(unsigned.lease.canReport,false);assert.equal(unsigned.lease.legacyPayeeVisible,false);}
 await query(`UPDATE leases SET status='draft' WHERE id=$1`,[f.lease]);assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'current'})).state,'unavailable');assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'ended'})).state,'unavailable');
 await query(`UPDATE leases SET status='ended' WHERE id=$1`,[f.lease]);assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'current'})).state,'unavailable');const ended=await tenantPaymentHistory(a.s,f.lease,{view:'ended'});assert.equal(ended.state,'ready');if(ended.state==='ready')assert.equal(ended.lease.canReport,false);
 await query(`UPDATE contacts SET archived_at=clock_timestamp() WHERE id=$1`,[a.contact]);assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'ended'})).state,'unavailable');
 await query(`UPDATE contacts SET archived_at=NULL WHERE id=$1`,[a.contact]);await query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[a.s.sessionId]);assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'ended'})).state,'unavailable');
});

test('mixed currencies fail closed rather than summing unlike balances',async()=>{
 const a=await tenant(),f=await fixture(a.contact);await enable();await invoice(f.p,f.lease);
 await query(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'USD','2090-03-01','open')`,[ORG_ID,f.p,f.lease,randomUUID()]);
 assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'current'})).state,'unavailable');
});

test('signed credit stays visible, offsets open debt and never offers a negative payment',async()=>{
 const a=await tenant(),f=await fixture(a.contact);await enable();
 const credit=(await query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD','2090-03-01','open') RETURNING id::text`,[ORG_ID,f.p,f.lease,randomUUID()])).rows[0].id;
 await query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'credit','Synthetic utility correction',-20000,-20000)`,[ORG_ID,credit]);
 const negative=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(negative.state,'ready');if(negative.state!=='ready')throw Error('Unavailable');assert.equal(negative.bill.state,'credit');assert.equal(negative.bill.balanceMinor,-20000);assert.equal(negative.lease.canReport,false);
 await invoice(f.p,f.lease);const offset=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(offset.state,'ready');if(offset.state!=='ready')throw Error('Unavailable');assert.equal(offset.bill.state,'due');assert.equal(offset.bill.balanceMinor,80000);assert.equal(offset.lease.canReport,true);
});


test('normal paid utility correction produces signed credit and preserves tenant report history',async()=>{
 const period=currentUtilityPeriod(),a=await tenant(),f=await fixture(a.contact,ORG_ID,period);await enable();
 const sessionId=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sessionId,USERS.admin,randomUUID()]);
 const staff:Session={userId:USERS.admin,sessionId,email:'',name:'staff',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`UPDATE rooms SET electricity_method='by_reading',rate_per_kwh=4 WHERE id=$1`,[f.room]);
 const invoiceId=(await query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,bill_to_contact_id,invoice_number,currency,issue_date,due_date,period_start,period_end,status,source,created_by) VALUES($1,$2,$3,$4,$5,'TWD',$6::date,$7::date,$6::date,$7::date,'open','recurring',$8) RETURNING id::text`,[ORG_ID,f.p,f.lease,a.contact,randomUUID(),period.start,period.end,USERS.admin])).rows[0].id;
 await query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic rent',100000,100000)`,[ORG_ID,invoiceId]);
 const input={unitId:f.u,periodStart:period.start,periodEnd:period.end,rateMajor:4,totalKwh:null,billTotalMajor:null,overrideReason:'',readings:[{spaceId:f.room,kwh:20}]};
 const first=await prepareUtilityRun(staff,input);await confirmUtilityRun(staff,first.runId);
 const before=(await query<{balance:string}>(`SELECT balance_minor::text balance FROM invoices WHERE id=$1`,[invoiceId])).rows[0];const balance=Number(before.balance);assert.ok(Number.isSafeInteger(balance)&&balance>0);
 const report=await recordPayment(a.s,{leaseId:f.lease,amountMajor:balance/100,paidOn:period.start,last5:'12345',reference:''});if(!('paymentId' in report))throw Error('Missing report');await confirmPayment(staff,report.paymentId);
 const paid=(await query<{status:string}>(`SELECT status::text FROM invoices WHERE id=$1`,[invoiceId])).rows[0];assert.equal(paid.status,'paid');
 const correction=await prepareUtilityRun(staff,{...input,readings:[{spaceId:f.room,kwh:10}]});assert.equal(correction.runId,first.runId);await confirmUtilityRun(staff,correction.runId);
 const ledger=(await query<{net:string;credits:string}>(`SELECT coalesce(sum(i.balance_minor),0)::text net,(SELECT count(*)::text FROM invoice_lines il JOIN invoices x ON x.org_id=il.org_id AND x.id=il.invoice_id WHERE x.org_id=$1 AND x.lease_id=$2 AND il.charge_type='credit' AND il.amount_minor<0) credits FROM invoices i WHERE i.org_id=$1 AND i.lease_id=$2 AND i.status IN ('open','partially_paid')`,[ORG_ID,f.lease])).rows[0];
 const signed=Number(ledger.net);assert.ok(Number.isSafeInteger(signed)&&signed<0);assert.ok(Number(ledger.credits)>0);
 const captureVector=async(c:Client)=>{
  const invoices=(await c.query<{id:string;status:string;total:string;paid:string;balance:string;currency:string;due_on:string;period_start:string|null;period_end:string|null}>(`SELECT id::text,status::text,total_minor::text total,paid_minor::text paid,balance_minor::text balance,currency::text,due_date::text due_on,period_start::text,period_end::text FROM invoices WHERE org_id=$1 AND lease_id=$2 ORDER BY id`,[ORG_ID,f.lease])).rows;
  const lines=(await c.query<{invoice_id:string;charge_type:string;amount:string;description:string;period_start:string|null}>(`SELECT il.invoice_id::text,il.charge_type::text,il.amount_minor::text amount,il.description,i.period_start::text FROM invoice_lines il JOIN invoices i ON i.org_id=il.org_id AND i.id=il.invoice_id WHERE i.org_id=$1 AND i.lease_id=$2 ORDER BY il.invoice_id,il.line_no`,[ORG_ID,f.lease])).rows;
  const rows=invoices.map(i=>{
   const raw=lines.filter(l=>l.invoice_id===i.id).map(l=>({charge_type:l.charge_type,amount_minor:safeMinor(l.amount),description:l.description,period_start:l.period_start}));
   const displayed=tenantBillLines(raw,safeMinor(i.paid));const rawSum=sumMinor(raw.map(x=>x.amount_minor)),displaySum=sumMinor(displayed.map(x=>x.amountMinor)),canonicalNet=safeMinor(i.total)-safeMinor(i.paid);
   assert.ok(Number.isSafeInteger(canonicalNet));
   return {...i,eligible:i.status==='open'||i.status==='partially_paid',raw:raw.map(x=>({type:x.charge_type,amountMinor:x.amount_minor,periodStart:x.period_start,isRecognizedUtilityCredit:x.charge_type==='credit'&&(x.description??'').startsWith('沖銷電費')})),display:displayed.map(x=>({type:x.chargeType,amountMinor:x.amountMinor,periodStart:x.periodStart??null,isRecognizedUtilityCredit:x.chargeType==='credit'&&x.description.startsWith('沖銷電費')})),rawSum,displaySum,canonicalNet,displayDelta:displaySum-safeMinor(i.balance),rawMatchesTotal:rawSum===safeMinor(i.total),balanceMatchesCanonical:canonicalNet===safeMinor(i.balance),displayMatchesBalance:displaySum===safeMinor(i.balance)};
  });
  return {invoices:rows,openNet:sumMinor(rows.filter(x=>x.eligible).map(x=>safeMinor(x.balance))),openRaw:sumMinor(rows.filter(x=>x.eligible).map(x=>x.rawSum)),openDisplay:sumMinor(rows.filter(x=>x.eligible).map(x=>x.displaySum))};
 };
 const setupVector=await withClient(async c=>{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{const vector=await captureVector(c);await c.query('COMMIT');return vector;}catch(e){await c.query('ROLLBACK');throw e;}});
 const tenantVector=await tx(a.s.userId,captureVector,{orgId:ORG_ID,environment:'live'},{isolation:'repeatable read',readOnly:true});
 const home=await tenantPaymentHistory(a.s,f.lease,{view:'current'}),pay=await tenantPaymentHistory(a.s,f.lease,{view:'current'});
 evidence('b018-utility-correction-input-vector.json',{scope:'synthetic own lease; setup and authenticated tenant scoped projections',setup:setupVector,tenant:tenantVector,sameVisibleFacts:same(setupVector,tenantVector),readerStates:{home:home.state,pay:pay.state}});
 assert.equal(home.state,'ready');assert.equal(pay.state,'ready');if(home.state!=='ready'||pay.state!=='ready')throw Error('Unavailable');assert.deepEqual(home.bill,pay.bill);assert.equal(home.bill.state,'credit');assert.equal(home.bill.balanceMinor,signed);assert.equal(home.lease.canReport,false);assert.equal(home.reports.find(r=>r.id===report.paymentId)?.status,'confirmed');
 const offset=(await query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD',$5::date,'open') RETURNING id::text`,[ORG_ID,f.p,f.lease,randomUUID(),period.end])).rows[0].id;
 await query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic offset',$3::numeric,$3::bigint)`,[ORG_ID,offset,-signed]);
 const net=(await query<{balance:string}>(`SELECT coalesce(sum(balance_minor),0)::text balance FROM invoices WHERE org_id=$1 AND lease_id=$2 AND status IN ('open','partially_paid')`,[ORG_ID,f.lease])).rows[0].balance;assert.equal(net,'0');
 const after=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(after.state,'ready');if(after.state!=='ready')throw Error('Unavailable');assert.equal(after.bill.state,'offset');assert.equal(after.bill.balanceMinor,0);assert.equal(after.lease.canReport,false);assert.equal(after.reports.find(r=>r.id===report.paymentId)?.status,'confirmed');
});


test('pending residual utility credit does not change prior payee audience, while a real deposit does',async()=>{
 const a=await tenant(),f=await fixture(a.contact);await enable();await query(`UPDATE leases SET status='pending_signature' WHERE id=$1`,[f.lease]);
 await query(`INSERT INTO bank_accounts(org_id,property_id,nickname,account_last5,currency,show_to_tenants) VALUES($1,$2,'Synthetic payee','12345','TWD',true)`,[ORG_ID,f.p]);
 const id=(await query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD','2090-03-01','open') RETURNING id::text`,[ORG_ID,f.p,f.lease,randomUUID()])).rows[0].id;
 await query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'credit','沖銷電費 synthetic',-4000,-4000)`,[ORG_ID,id]);
 const credit=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(credit.state,'ready');if(credit.state!=='ready')throw Error('Unavailable');assert.equal(credit.lease.legacyPayeeVisible,false);assert.equal(credit.bill.state,'credit');assert.equal(credit.bill.balanceMinor,-4000);assert.equal(credit.lease.canReport,false);assert.equal(tenantPayeeVisible('pending_signature',false,credit.bill.lines),false);
 await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='tenant_payment_history'`);assert.equal((await tenantPaymentHistory(a.s,f.lease,{view:'current'})).state,'off');assert.equal(tenantPayeeVisible('pending_signature',false,credit.bill.lines),false);
 await enable();await query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,2,'deposit','Synthetic deposit',4000,4000)`,[ORG_ID,id]);
 const sameInvoice=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(sameInvoice.state,'ready');if(sameInvoice.state!=='ready')throw Error('Unavailable');assert.equal(sameInvoice.bill.state,'zero_charge');assert.equal(sameInvoice.bill.balanceMinor,0);assert.equal(sameInvoice.lease.canReport,false);
 const creditId=(await query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD','2090-03-01','open') RETURNING id::text`,[ORG_ID,f.p,f.lease,randomUUID()])).rows[0].id;
 const debitId=(await query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD','2090-03-01','open') RETURNING id::text`,[ORG_ID,f.p,f.lease,randomUUID()])).rows[0].id;
 await query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'credit','Synthetic credit',-4000,-4000),($1,$3,1,'deposit','Synthetic deposit',4000,4000)`,[ORG_ID,creditId,debitId]);
 const offset=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(offset.state,'ready');if(offset.state!=='ready')throw Error('Unavailable');assert.equal(offset.bill.state,'offset');assert.equal(offset.bill.balanceMinor,0);assert.equal(offset.lease.canReport,false);
 await query(`UPDATE invoice_lines SET unit_amount_minor=5000,amount_minor=5000 WHERE org_id=$1 AND invoice_id=$2 AND line_no=2`,[ORG_ID,id]);
 const deposit=await tenantPaymentHistory(a.s,f.lease,{view:'current'});assert.equal(deposit.state,'ready');if(deposit.state!=='ready')throw Error('Unavailable');assert.equal(deposit.bill.state,'due');assert.equal(deposit.bill.balanceMinor,1000);assert.equal(deposit.lease.canReport,true);assert.equal(deposit.lease.legacyPayeeVisible,true);assert.equal(tenantPayeeVisible('pending_signature',false,deposit.bill.lines),true);
 const submitted=await recordPayment(a.s,{leaseId:f.lease,amountMajor:10,paidOn:'2090-01-17',last5:'12345',reference:''});if(!('paymentId' in submitted))throw Error('Missing report');
 const history=await tenantPaymentHistory(a.s,f.lease,{view:'current',reportId:submitted.paymentId});assert.equal(history.state,'ready');if(history.state!=='ready')throw Error('Unavailable');assert.equal(history.bill.balanceMinor,1000);assert.equal(history.bill.pending,true);assert.equal(history.reports[0].status,'submitted');assert.deepEqual(history.reports[0].original,{state:'available',amountMinor:1000,currency:'TWD',paidOn:'2090-01-17'});
});
