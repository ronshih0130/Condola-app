import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { ORG_ID, USERS } from './ids';
import type { Session } from './types';
import { ownerTransferView, recordOwnerTransfer as recordScoped, reverseOwnerTransfer as reverseScoped } from './owner-transfers';
import type { TransferInput,ReverseInput } from './owner-transfer-input';
const scope=(s:Session)=>({userId:s.userId,orgId:s.orgId,liveOrgId:s.liveOrgId,environment:s.environment});
const recordOwnerTransfer=(s:Session,i:TransferInput)=>recordScoped(s,i,scope(s));
const reverseOwnerTransfer=(s:Session,i:ReverseInput)=>reverseScoped(s,i,scope(s));
import { closeMonth } from './domain';
import { ensureSandbox } from './sandbox';
import { ORG2_ID } from './ids';
disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});test.after(async()=>{await clone.cleanup();});
async function blockedPid(c:Client,owner:number,exclude:number[],relation:boolean) {
 for(let i=0;i<100;i++){
  // Refresh PostgreSQL's transaction-cached activity snapshot before polling.
  await c.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
  const r=await c.query<{pid:number}>(`SELECT a.pid FROM pg_stat_activity a WHERE a.datname=current_database() AND $1=ANY(pg_blocking_pids(a.pid)) AND NOT(a.pid=ANY($2::int[])) AND ($3::boolean=false AND a.query LIKE 'SELECT pg_advisory_xact_lock%' OR $3::boolean=true AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted AND l.relation='public.ledger_entries'::regclass)) ORDER BY a.pid`,[owner,exclude,relation]);
  if(r.rows.length===1)return r.rows[0].pid;await new Promise(resolve=>setTimeout(resolve,50));
 }throw new Error('Expected owned blocked operation not observed');
}
async function bounded<T>(p:Promise<T>):Promise<T> {let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Operation did not drain')),10000);})]);}finally{if(timer)clearTimeout(timer);}}
async function ordered(c:Client,org:string,first:()=>Promise<unknown>,second:()=>Promise<unknown>) {
 let held=false,primary:unknown,failed=false,cleanup:unknown;const jobs:Promise<unknown>[]=[];
 try{await c.query('BEGIN');held=true;await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:owner-transfer-month:${org}`]);const owner=(await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  jobs.push(first());jobs[0].catch(()=>{});const a=await blockedPid(c,owner,[],false);
  jobs.push(second());jobs[1].catch(()=>{});await blockedPid(c,owner,[a],false);await c.query('COMMIT');held=false;
 }catch(e){primary=e;failed=true;}
 const cleanupErrors:unknown[]=[];if(held){try{await c.query('ROLLBACK');}catch(e){cleanupErrors.push(e);try{await c.end();}catch(closeError){cleanupErrors.push(closeError);}}}try{await bounded(Promise.allSettled(jobs));}catch(e){cleanupErrors.push(e);}if(cleanupErrors.length)cleanup=new AggregateError(cleanupErrors,'Coordinator cleanup failed');
 if(failed&&cleanup)throw new AggregateError([primary,cleanup],'Order and cleanup failed');if(failed)throw primary;if(cleanup)throw cleanup;
 const results=await Promise.all(jobs);return results;
}
test('staff recording, exact replay, reversal, close and legacy extra entries fail closed',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();let testError:unknown,testFailed=false;try{
 const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'admin',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
 await c.query(`DELETE FROM platform_settings WHERE key='owner_transfers'`);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"owner_transfers":true}'::jsonb WHERE id=$1`,[ORG_ID]);assert.equal(await ownerTransferView(s),null);
 await c.query(`INSERT INTO platform_settings(key,value) VALUES('owner_transfers',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,123)))`,[ORG_ID]);assert.equal(await ownerTransferView(s),null);
 await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='owner_transfers'`,[ORG_ID]);
 const view=await ownerTransferView(s);assert.ok(view);const option=view.options[0];assert.ok(option);assert.equal(await ownerTransferView({...s,role:'manager'}),null);assert.equal(await ownerTransferView({...s,sessionId:randomUUID()}),null);assert.equal(await ownerTransferView({...s,needsSandbox:true}),null);
 const date='2090-01-01';await c.query(`UPDATE property_owners SET effective_from='2000-01-01',effective_to=NULL WHERE property_id=$1 AND owner_contact_id=$2`,[option.propertyId,option.ownerId]);
 const input={requestId:randomUUID(),propertyId:option.propertyId,ownerId:option.ownerId,effectiveDate:date,amount:'12',reference:'synthetic',expectedCurrency:option.currency,expectedMinorUnit:option.minorUnit};
 const sessionFor=async(userId:string,role:Session['role'],kind:Session['kind']='staff',expired=false,revoked=false):Promise<Session>=>{const id=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp()+($4::int * interval '1 hour'),CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END)`,[id,userId,randomUUID(),expired?-1:1,revoked]);return {...s,userId,role,kind,sessionId:id};};
 const accountant=await sessionFor(USERS.accountant,'accountant'),manager=await sessionFor(USERS.manager,'manager'),tenant=await sessionFor(USERS.tenant,null,'tenant'),owner=await sessionFor(USERS.owner,null,'owner'),expired=await sessionFor(USERS.admin,'admin','staff',true),revoked=await sessionFor(USERS.admin,'admin','staff',false,true);
 const acctInput={...input,requestId:randomUUID()};assert.equal((await recordOwnerTransfer(accountant,acctInput)).state,'recorded');assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1 AND created_by=$2`,[acctInput.requestId,USERS.accountant])).rowCount,1);
 const sandboxId=await ensureSandbox(s);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='owner_transfers'`,[ORG_ID,sandboxId]);
 const sandbox={...s,orgId:sandboxId,liveOrgId:ORG_ID,environment:'sandbox' as const};assert.ok(await ownerTransferView(sandbox));
 for(const denied of [manager,tenant,owner,expired,revoked,{...s,orgId:ORG2_ID,liveOrgId:ORG2_ID},sandbox]){const deniedInput={...input,requestId:randomUUID()};assert.equal((await recordOwnerTransfer(denied,deniedInput)).state,denied===sandbox?'invalid':'unavailable');assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1`,[deniedInput.requestId])).rowCount,0);}
 // A mounted tab's rendered actor scope is not authority for a new session.
 const staleActorInput={...input,requestId:randomUUID()};
 assert.equal((await recordScoped(accountant,staleActorInput,scope(s))).state,'unavailable');
 assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1`,[staleActorInput.requestId])).rowCount,0);
 assert.equal((await recordScoped(s,staleActorInput,scope(accountant))).state,'unavailable');
 const wrongDate={...input,requestId:randomUUID(),effectiveDate:'1900-01-01'};
 assert.equal((await recordOwnerTransfer(s,wrongDate)).state,'invalid');assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1`,[wrongDate.requestId])).rowCount,0);
 const stale={...input,requestId:randomUUID(),expectedMinorUnit:(option.minorUnit+1)%5};assert.equal((await recordOwnerTransfer(s,stale)).state,'stale');assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1`,[stale.requestId])).rowCount,0);
 assert.equal((await recordOwnerTransfer(s,{...input,requestId:randomUUID(),effectiveDate:'2090-02-30'})).state,'invalid');
 const [a,b]=await Promise.all([recordOwnerTransfer(s,input),recordOwnerTransfer(s,input)]);assert.equal(a.state,'recorded');assert.equal(b.state,'recorded');assert.equal((await recordOwnerTransfer(s,{...input,amount:'13'})).state,'unavailable');
 // Recovery is tied to the original stored currency/scale and actor, not the current owner roster.
 await c.query(`UPDATE contacts SET archived_at=clock_timestamp() WHERE id=$1`,[option.ownerId]);
 await c.query(`UPDATE currencies SET minor_unit=$2 WHERE code=$1`,[option.currency,(option.minorUnit+1)%5]);
 assert.equal((await recordOwnerTransfer(s,input)).state,'recorded');
 await c.query(`UPDATE currencies SET minor_unit=$2 WHERE code=$1`,[option.currency,option.minorUnit]);
 await c.query(`UPDATE contacts SET archived_at=NULL WHERE id=$1`,[option.ownerId]);
 const counts=await c.query(`SELECT count(*)::int n,array_agg(memo ORDER BY id) memos FROM ledger_entries WHERE transaction_id=$1`,[input.requestId]);assert.equal(counts.rows[0].n,2);assert.deepEqual(counts.rows[0].memos,[`b014:v1:scale=${option.minorUnit}`,`b014:v1:scale=${option.minorUnit}`]);assert.equal((await recordOwnerTransfer(accountant,input)).state,'unavailable');const refreshed=await sessionFor(USERS.admin,'admin');assert.equal((await recordScoped(refreshed,input,scope(s))).state,'recorded');
 const staleReverse={requestId:randomUUID(),originalId:input.requestId,effectiveDate:'2090-02-01',reason:'stale actor'};
 assert.equal((await reverseScoped(accountant,staleReverse,scope(s))).state,'unavailable');assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1`,[staleReverse.requestId])).rowCount,0);
 const rev={requestId:randomUUID(),originalId:input.requestId,effectiveDate:'2090-02-01',reason:'Correction'};const [r1,r2]=await Promise.all([reverseOwnerTransfer(s,rev),reverseOwnerTransfer(s,rev)]);assert.equal(r1.state,'reversed');assert.equal(r2.state,'reversed');assert.equal((await reverseOwnerTransfer(s,{...rev,requestId:randomUUID()})).state,'unavailable');
 await closeMonth(s,'2091-01','synthetic');assert.equal((await recordOwnerTransfer(s,{...input,requestId:randomUUID(),effectiveDate:'2090-12-01'})).state,'closed');assert.equal((await reverseOwnerTransfer(s,{...rev,requestId:randomUUID(),effectiveDate:'2090-12-01'})).state,'closed');
 // Enqueue both real operations behind an owned advisory lock; observing each
 // blocked backend before release forces both lock orders without app hooks.
 for(const [month,closeFirst] of [['2093-01',true],['2094-01',false]] as const){
  const write={...input,requestId:randomUUID(),effectiveDate:`${month}-05`};
  const [first,second]=await ordered(c,ORG_ID,closeFirst?()=>closeMonth(s,month,'race'):()=>recordOwnerTransfer(s,write),closeFirst?()=>recordOwnerTransfer(s,write):()=>closeMonth(s,month,'race'));
  const result=(closeFirst?second:first) as Awaited<ReturnType<typeof recordOwnerTransfer>>;assert.equal(result.state,closeFirst?'closed':'recorded');
  assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1`,[write.requestId])).rowCount,closeFirst?0:1);
 }
 for(const [month,closeFirst] of [['2095-01',true],['2096-01',false]] as const){
  const original={...input,requestId:randomUUID(),effectiveDate:`${month}-05`};assert.equal((await recordOwnerTransfer(s,original)).state,'recorded');
  const reversal={requestId:randomUUID(),originalId:original.requestId,effectiveDate:`${month}-06`,reason:'lock race'};
  const [first,second]=await ordered(c,ORG_ID,closeFirst?()=>closeMonth(s,month,'race'):()=>reverseOwnerTransfer(s,reversal),closeFirst?()=>reverseOwnerTransfer(s,reversal):()=>closeMonth(s,month,'race'));
  const result=(closeFirst?second:first) as Awaited<ReturnType<typeof reverseOwnerTransfer>>;assert.equal(result.state,closeFirst?'closed':'reversed');
  assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1`,[reversal.requestId])).rowCount,closeFirst?0:1);
 }
 // A legacy writer does not take the application advisory lock. Block the
 // reversal's insert, append balanced entries to its already-read original,
 // and verify its final revalidation rolls the attempted reversal back.
 const later={...input,requestId:randomUUID(),effectiveDate:'2098-01-01'};assert.equal((await recordOwnerTransfer(s,later)).state,'recorded');
 const pendingReverse={requestId:randomUUID(),originalId:later.requestId,effectiveDate:'2098-02-01',reason:'late source change'};
 let held=false,primary:unknown,failed=false,cleanup:unknown;let pending:ReturnType<typeof reverseOwnerTransfer>|undefined;
 try{await c.query('BEGIN');held=true;await c.query('LOCK TABLE ledger_entries IN SHARE ROW EXCLUSIVE MODE');
  const owner=(await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;pending=reverseOwnerTransfer(s,pendingReverse);pending.catch(()=>{});await blockedPid(c,owner,[],true);
  await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,property_id) VALUES ($1,$2,'cash_clearing',1,$3,$4),($1,$2,'cash_clearing',-1,$3,$4)`,[ORG_ID,later.requestId,option.currency,option.propertyId]);
  await c.query('COMMIT');held=false;assert.equal((await bounded(pending)).state,'unavailable');assert.equal((await c.query(`SELECT id FROM ledger_transactions WHERE id=$1`,[pendingReverse.requestId])).rowCount,0);
 }catch(e){primary=e;failed=true;}
 const cleanupErrors:unknown[]=[];if(held){try{await c.query('ROLLBACK');}catch(e){cleanupErrors.push(e);try{await c.end();}catch(closeError){cleanupErrors.push(closeError);}}}if(pending){try{await bounded(Promise.allSettled([pending]));}catch(e){cleanupErrors.push(e);}}if(cleanupErrors.length)cleanup=new AggregateError(cleanupErrors,'Legacy coordinator cleanup failed');
 if(failed&&cleanup)throw new AggregateError([primary,cleanup],'Legacy check and cleanup failed');if(failed)throw primary;if(cleanup)throw cleanup;
 await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,property_id) VALUES ($1,$2,'cash_clearing',1,$3,$4),($1,$2,'cash_clearing',-1,$3,$4)`,[ORG_ID,input.requestId,option.currency,option.propertyId]);
 assert.equal(await ownerTransferView(s),null);assert.equal((await recordOwnerTransfer(s,input)).state,'unavailable');assert.equal((await reverseOwnerTransfer(s,rev)).state,'unavailable');
 // Closing remains available when this feature is OFF, but recovery is not.
 await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='owner_transfers'`);
 assert.equal((await recordOwnerTransfer(s,input)).state,'unavailable');await closeMonth(s,'2100-01','flag off');
 for(const bad of [expired,revoked]){await assert.rejects(closeMonth(bad,'2101-01','denied'));assert.equal((await c.query(`SELECT id FROM month_closes WHERE org_id=$1 AND period_month='2101-01-01'`,[ORG_ID])).rowCount,0);}
 await c.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);assert.equal(await ownerTransferView(s),null);
 }catch(e){testError=e;testFailed=true;}let closeError:unknown;try{await c.end();}catch(e){closeError=e;}if(testFailed&&closeError)throw new AggregateError([testError,closeError],'Test and close failed');if(testFailed)throw testError;if(closeError)throw closeError;
});
