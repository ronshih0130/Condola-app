import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createConnection,createServer,type Socket} from 'node:net';
import test from 'node:test';
import {Client} from 'pg';
import {ORG_ID,ORG2_ID,USERS} from './ids';
import {resetAndSeed} from './seed';
import {cloneTestDatabase} from './test-database-clone';
import {disposableDbUrl} from './test-disposable-db';
import type {Session} from './types';
import {changeOwnerRepairDefault,closeOwnerRepairDefault,ownerRepairDefaultStatus,ownerRepairPolicyView,ownerRepairPolicyEntryIds,type RepairDefaultIntent} from './repair-owner-policy';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>,db:Client,s:Session,property:string,ownership:string;
async function client(){const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();return c;}
async function seed(){const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}}
async function controls(on=true){await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'`,[ORG_ID,on]);await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"repair_approvals":true}'::jsonb WHERE id=$1`,[ORG_ID]);}
async function renew(ms=3600000){const id=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 millisecond')`,[id,USERS.owner,randomUUID(),ms]);s.sessionId=id;}
async function intent(value='600000',action:'set'|'clear'='set'):Promise<RepairDefaultIntent>{const v=await ownerRepairPolicyView(s,property);assert.equal(v.state,'enabled');assert.ok(v.state==='enabled');return{propertyId:property,requestId:randomUUID(),expected:v.snapshot,action,value};}
async function counts(){return(await db.query(`SELECT (SELECT count(*)::int FROM app.b013_default_roots) roots,(SELECT count(*)::int FROM app.b013_default_revisions) revisions,(SELECT count(*)::int FROM app.b013_policy_commands) commands,(SELECT count(*)::int FROM audit_log WHERE table_name='b013_default_revisions') audits,(SELECT repair_approval_threshold_minor::text FROM property_owners WHERE id=$1) override`,[ownership])).rows[0];}
test.before(async()=>{clone=await cloneTestDatabase();db=await client();});
test.beforeEach(async()=>{await seed();const row=(await db.query(`SELECT po.property_id::text property,po.id::text ownership FROM property_owners po JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE po.org_id=$1 AND c.user_id=$2 ORDER BY po.property_id LIMIT 1`,[ORG_ID,USERS.owner])).rows[0];property=row.property;ownership=row.ownership;await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=NULL WHERE id=$1`,[ownership]);s={kind:'owner',role:null,userId:USERS.owner,sessionId:randomUUID(),orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'zh-TW',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic Owner'};await renew();await controls();});
test.after(async()=>{await db?.end();await clone?.cleanup();});

test('actual set/replay/no-change/clear retain exact audit and never edit the property override',async()=>{
 const i=await intent(),first=await changeOwnerRepairDefault(s,i);assert.equal(first.status==='recorded'?first.outcome:null,'changed');assert.deepEqual(await counts(),{roots:1,revisions:1,commands:1,audits:1,override:null});assert.equal((await ownerRepairPolicyView(s,property)).state,'enabled');assert.deepEqual(await changeOwnerRepairDefault(s,i),first);
 const same=await changeOwnerRepairDefault(s,await intent());assert.equal(same.status==='recorded'?same.outcome:null,'no_change');assert.deepEqual(await counts(),{roots:1,revisions:1,commands:2,audits:1,override:null});
 const cleared=await changeOwnerRepairDefault(s,await intent('','clear'));assert.equal(cleared.status==='recorded'?cleared.outcome:null,'changed');const v=await ownerRepairPolicyView(s,property);assert.equal(v.state==='enabled'?v.defaultMinor:null,'500000');assert.equal((await counts()).audits,2);
 assert.equal((await changeOwnerRepairDefault(s,await intent('','clear'))).status,'recorded');assert.equal((await counts()).revisions,2);assert.equal((await counts()).audits,2);
 const event=(await db.query(`SELECT actor_user_id::text actor,actor_role,action::text action,reason,request_id,new_row FROM audit_log WHERE table_name='b013_default_revisions' ORDER BY id LIMIT 1`)).rows[0];assert.equal(event.actor,USERS.owner);assert.equal(event.actor_role,'owner');assert.equal(event.action,'insert');assert.equal(event.reason,'owner_repair_default_changed');assert.equal(event.request_id,i.requestId);assert.equal(event.new_row.threshold_minor,'600000');assert.equal(event.new_row.currency,'TWD');assert.equal(event.new_row.minor_unit,2);
});

test('historical exact replay recovers even OFF and after currency changes without requiring old revision current',async()=>{
 const i=await intent(),first=await changeOwnerRepairDefault(s,i);assert.equal(first.status==='recorded'?first.outcome:null,'changed');await changeOwnerRepairDefault(s,await intent('700000'));await db.query(`UPDATE properties SET currency='USD' WHERE id=$1`,[property]);await controls(false);
 assert.deepEqual(await changeOwnerRepairDefault(s,i),first);assert.deepEqual(await ownerRepairDefaultStatus(s,property,i.requestId),first);assert.deepEqual(await closeOwnerRepairDefault(s,property,i.requestId),first);assert.equal((await counts()).revisions,2);
 const disabled=await changeOwnerRepairDefault(s,{...i,requestId:randomUUID()});assert.equal(disabled.status==='recorded'?disabled.outcome:null,'rejected_disabled');assert.equal((await counts()).revisions,2);
});

test('request identity mismatches and stale CAS become distinct terminal outcomes without overwrites',async()=>{
 const old=await intent(),first=await changeOwnerRepairDefault(s,old);assert.equal(first.status,'recorded');assert.deepEqual(await changeOwnerRepairDefault(s,{...old,value:'1'}),{status:'request_mismatch'});
 const stale={...old,requestId:randomUUID(),value:'800000'},rejected=await changeOwnerRepairDefault(s,stale);assert.equal(rejected.status==='recorded'?rejected.outcome:null,'rejected_conflict');assert.deepEqual(await changeOwnerRepairDefault(s,stale),rejected);assert.equal((await counts()).revisions,1);assert.equal((await counts()).audits,1);
 assert.deepEqual(await ownerRepairDefaultStatus({...s,orgId:ORG2_ID,liveOrgId:ORG2_ID},property,old.requestId),{status:'unavailable'});
});

test('close is a deny-only tombstone and cannot undo an existing changed request',async()=>{
 const i=await intent(),closed=await closeOwnerRepairDefault(s,property,i.requestId);assert.equal(closed.status==='recorded'?closed.outcome:null,'cancelled');assert.deepEqual(await changeOwnerRepairDefault(s,i),closed);assert.equal((await counts()).revisions,0);
 const next=await intent(),changed=await changeOwnerRepairDefault(s,next);assert.deepEqual(await closeOwnerRepairDefault(s,property,next.requestId),changed);assert.equal((await counts()).revisions,1);
});

test('recognized bounded invalid values retain command outcomes without a mutation audit; malformed envelopes reserve nothing',async()=>{
 for(const value of ['-1','01','1.2','1e3','9223372036854775808','']){const result=await changeOwnerRepairDefault(s,await intent(value));assert.equal(result.status==='recorded'?result.outcome:null,'rejected_invalid',value);}
 const clear=await changeOwnerRepairDefault(s,await intent('1','clear'));assert.equal(clear.status==='recorded'?clear.outcome:null,'rejected_invalid');assert.equal((await counts()).revisions,0);assert.equal((await counts()).audits,0);
 const before=await counts(),i=await intent();assert.deepEqual(await changeOwnerRepairDefault(s,{...i,expected:'bad'}),{status:'invalid'});assert.deepEqual(await changeOwnerRepairDefault(s,{...i,value:'1'.repeat(65)}),{status:'invalid'});assert.deepEqual(await counts(),before);
 const max=await changeOwnerRepairDefault(s,await intent('9223372036854775807'));assert.equal(max.status==='recorded'?max.outcome:null,'changed');const v=await ownerRepairPolicyView(s,property);assert.equal(v.state==='enabled'?v.defaultMinor:null,'9223372036854775807');
});

test('actual current owner authority is required for every write and recovery, even OFF',async()=>{
 const i=await intent(),first=await changeOwnerRepairDefault(s,i);assert.equal(first.status,'recorded');await controls(false);
 for(const invalid of [{...s,kind:'staff' as const,role:'admin' as const},{...s,kind:'tenant' as const},{...s,environment:'sandbox' as const},{...s,liveOrgId:ORG2_ID},{...s,sessionId:randomUUID()}])assert.deepEqual(await ownerRepairDefaultStatus(invalid,property,i.requestId),{status:'unavailable'});
 await db.query(`UPDATE contacts SET archived_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.owner]);assert.deepEqual(await changeOwnerRepairDefault(s,i),{status:'unavailable'});assert.deepEqual(await ownerRepairDefaultStatus(s,property,i.requestId),{status:'unavailable'});assert.deepEqual(await closeOwnerRepairDefault(s,property,i.requestId),{status:'unavailable'});
});

test('request and default absence advisory admission fail immediately without inventing outcomes',async()=>{
 const i=await intent(),held=await client();try{
  await held.query('BEGIN');await held.query(`SELECT pg_advisory_xact_lock(hashtextextended('b013/request/'||$1||'/'||$2||'/'||$3,0))`,[ORG_ID,USERS.owner,i.requestId]);assert.deepEqual(await changeOwnerRepairDefault(s,i),{status:'busy'});assert.deepEqual(await ownerRepairDefaultStatus(s,property,i.requestId),{status:'busy'});await held.query('ROLLBACK');
  await held.query('BEGIN');await held.query(`SELECT pg_advisory_xact_lock(hashtextextended('b013/default/'||$1||'/'||$2||'/TWD',0))`,[ORG_ID,USERS.owner]);assert.deepEqual(await changeOwnerRepairDefault(s,i),{status:'busy'});await held.query('ROLLBACK');assert.deepEqual(await ownerRepairDefaultStatus(s,property,i.requestId),{status:'unknown'});assert.equal((await counts()).commands,0);
 }finally{await held.query('ROLLBACK');await held.end();}
});

test('actual policy audit insertion failure rolls back root, revision and command without a false mismatch',async()=>{
 const i=await intent();await db.query(`CREATE FUNCTION app.b013_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.table_name='b013_default_revisions' THEN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE='23514',CONSTRAINT='synthetic_audit_failure';END IF;RETURN NEW;END$$`);await db.query(`CREATE TRIGGER b013_test_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION app.b013_test_audit_failure()`);
 try{assert.deepEqual(await changeOwnerRepairDefault(s,i),{status:'unknown'});assert.deepEqual(await counts(),{roots:0,revisions:0,commands:0,audits:0,override:null});assert.deepEqual(await ownerRepairDefaultStatus(s,property,i.requestId),{status:'unknown'});}finally{await db.query(`DROP TRIGGER b013_test_audit_failure ON audit_log`);await db.query(`DROP FUNCTION app.b013_test_audit_failure()`);}
});

/** Test-only local PostgreSQL wire fault; never installs a runtime callback. */
async function wireFault<T>(fault:'rollback'|'before_commit'|'after_commit',fn:()=>Promise<T>){
 const previous=process.env.DATABASE_URL!,url=new URL(previous),upstreamPort=Number(url.port);assert.equal(url.hostname,'127.0.0.1');
 const sockets=new Set<Socket>(),statements:string[]=[];let tripped=false;
 const server=createServer(front=>{
  const back=createConnection({host:'127.0.0.1',port:upstreamPort});sockets.add(front);sockets.add(back);
  for(const s of [front,back]){s.on('error',()=>{});s.on('close',()=>{sockets.delete(s);});}
  front.on('close',()=>back.destroy());back.on('close',()=>front.destroy());
  let startup=true,input=Buffer.alloc(0),suppress=false,output=Buffer.alloc(0);
  front.on('data',chunk=>{
   input=Buffer.concat([input,chunk]);let cut=false;
   while(input.length>=5){const length=startup?input.readInt32BE(0):input.readInt32BE(1)+1;if(length<5||length>1048576){front.destroy();back.destroy();return;}if(input.length<length)break;
    const frame=input.subarray(0,length);input=input.subarray(length);
    if(startup){startup=false;continue;}
    let sql='';if(frame[0]===81)sql=frame.subarray(5,-1).toString();else if(frame[0]===80){const end=frame.indexOf(0,5);const endSql=frame.indexOf(0,end+1);if(end>=5&&endSql>end)sql=frame.subarray(end+1,endSql).toString();}
    if(sql)statements.push(sql);
    if((fault==='rollback'&&sql==='ROLLBACK')||(fault==='before_commit'&&sql==='COMMIT')){tripped=true;cut=true;front.destroy();back.destroy();break;}
    if(fault==='after_commit'&&sql==='COMMIT')suppress=true;
   }
   if(!cut)back.write(chunk);
  });
  back.on('data',chunk=>{
   if(!suppress){front.write(chunk);return;}
   output=Buffer.concat([output,chunk]);
   while(output.length>=5){const length=output.readInt32BE(1)+1;if(output.length<length)break;const type=output[0];output=output.subarray(length);if(type===90){tripped=true;front.destroy();back.destroy();break;}}
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');url.port=String(address.port);process.env.DATABASE_URL=url.toString();
 try{return {value:await fn(),statements,tripped};}
 finally{process.env.DATABASE_URL=previous;for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}


test('actual COMMIT transport loss before forwarding versus after backend acknowledgement preserves uncertainty',async()=>{
 for(const fault of ['before_commit','after_commit'] as const){
  const i=await intent(),before=await counts(),result=await wireFault(fault,()=>changeOwnerRepairDefault(s,i));assert.equal(result.tripped,true);assert.deepEqual(result.value,{status:'unknown'});
  const flush=result.statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE'),finish=result.statements.findIndex(x=>x.includes('b013_finish_default'));assert.ok(flush>=0);assert.equal(finish,flush+1);assert.equal(result.statements[finish+1],'COMMIT');
  const recovered=await ownerRepairDefaultStatus(s,property,i.requestId);
  if(fault==='after_commit'){assert.equal(recovered.status==='recorded'?recovered.outcome:null,'changed');assert.deepEqual(await changeOwnerRepairDefault(s,i),recovered);assert.deepEqual(await closeOwnerRepairDefault(s,property,i.requestId),recovered);assert.equal((await counts()).revisions,before.revisions+1);assert.equal((await counts()).audits,before.audits+1);}
  else{assert.deepEqual(recovered,{status:'unknown'});assert.deepEqual(await counts(),before);await closeOwnerRepairDefault(s,property,i.requestId);assert.equal((await changeOwnerRepairDefault(s,i)).status,'recorded');assert.equal((await counts()).revisions,before.revisions);}
 }
});

test('natural expiry after result reads denies both a fresh change and unknown status at final validation',async()=>{
 const original=(await db.query(`SELECT pg_get_functiondef('app.b013_finish_default(uuid,uuid,text,uuid,uuid,uuid,text)'::regprocedure) definition`)).rows[0].definition;
 try{for(const mode of ['change','status'] as const){
  const i=await intent(),marker=1+randomBytes(4).readUInt32BE(0)%1000000000;
  const instrumented=original.replace('SELECT * INTO final_ctx FROM app.b013_owner_context',`PERFORM pg_advisory_xact_lock(${marker}::bigint);PERFORM pg_sleep(1.5);SELECT * INTO final_ctx FROM app.b013_owner_context`);assert.notEqual(instrumented,original);await db.query(instrumented);await renew(1000);
  const pending=mode==='change'?changeOwnerRepairDefault(s,i):ownerRepairDefaultStatus(s,property,i.requestId);let observed=false;const deadline=Date.now()+900;
  try{while(Date.now()<deadline){observed=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND l.classid=0 AND l.objid=$1::oid AND l.granted) observed`,[marker])).rows[0].observed;if(observed)break;await new Promise(resolve=>setTimeout(resolve,10));}
   assert.equal(observed,true,mode);assert.equal((await db.query(`SELECT expires_at>clock_timestamp() valid FROM auth_sessions WHERE id=$1`,[s.sessionId])).rows[0].valid,true,'session observed valid before final validation delay');assert.deepEqual(await pending,{status:'unavailable'});assert.deepEqual(await counts(),{roots:0,revisions:0,commands:0,audits:0,override:null});
  }finally{await pending;await db.query(original);await renew();}
 }}finally{await db.query(original);}
});

async function heldBegin(c:Client){await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`,[s.userId]);await c.query('SET LOCAL ROLE service_role');}
async function heldFinish(c:Client,request:string,mode:'change'|'close'){await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query(`SELECT app.b013_finish_default($1,$1,'live',$2,$3,$4,$5)`,[ORG_ID,s.sessionId,property,request,mode]);await c.query('COMMIT');}

test('actual edit and deny-only close serialize in both orders and preserve the first committed decision',async()=>{
 for(const first of ['change','close'] as const){const i=await intent(first==='change'?'610000':'620000'),held=await client();try{
  await heldBegin(held);
  if(first==='change')await held.query(`SELECT app.b013_change_default($1,$1,'live',$2,$3,$4,$5,'set',$6)`,[ORG_ID,s.sessionId,property,i.requestId,i.expected,i.value]);
  else await held.query(`SELECT app.b013_close_default($1,$1,'live',$2,$3,$4)`,[ORG_ID,s.sessionId,property,i.requestId]);
  assert.deepEqual(first==='change'?await closeOwnerRepairDefault(s,property,i.requestId):await changeOwnerRepairDefault(s,i),{status:'busy'});await heldFinish(held,i.requestId,first);
  const result=await ownerRepairDefaultStatus(s,property,i.requestId);assert.equal(result.status==='recorded'?result.outcome:null,first==='change'?'changed':'cancelled');assert.deepEqual(await changeOwnerRepairDefault(s,i),result);assert.deepEqual(await closeOwnerRepairDefault(s,property,i.requestId),result);
 }finally{await held.query('ROLLBACK');await held.end();}}
 assert.equal((await counts()).revisions,1);assert.equal((await counts()).audits,1);
});

test('current owner contact pins also serialize otherwise distinct property witnesses in both orders',async()=>{
 const other=randomUUID(),contact=(await db.query(`SELECT owner_contact_id::text id FROM property_owners WHERE id=$1`,[ownership])).rows[0].id;
 await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'Other owner policy property','TW','TWD','Asia/Taipei')`,[other,ORG_ID]);await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date-1)`,[ORG_ID,other,contact]);
 for(const [heldProperty,blockedProperty] of [[property,other],[other,property]]){const held=await client();try{await heldBegin(held);await held.query(`SELECT app.b013_owner_view($1,$1,'live',$2,$3)`,[ORG_ID,s.sessionId,heldProperty]);assert.deepEqual(await ownerRepairPolicyView(s,blockedProperty),{state:'busy'});}finally{await held.query('ROLLBACK');await held.end();}}
 assert.equal((await ownerRepairPolicyView(s,other)).state,'enabled');
});

test('only fixed gateways are executable by service; policy tables and internal helpers remain private',async()=>{
 const functions=(await db.query(`SELECT p.oid::regprocedure::text signature,p.proname name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'b013_%'`)).rows;
 const allowed=new Set(['b013_owner_view','b013_change_default','b013_default_status','b013_close_default','b013_finish_default','b013_change_override','b013_override_status','b013_close_override','b013_finish_override',
  // B-013 closeout (20261105170000): service-only repair approval gateways.
  'b013_submit_estimate','b013_decide_estimate','b013_authorize_emergency','b013_record_appointment','b013_emit_reminder','b013_dispatch_allowed',
  'b013_owner_pending','b013_owner_history','b013_manager_view','b013_record_vendor_appointment']);
 for(const role of ['anon','authenticated','service_role']){
  for(const fn of functions)assert.equal((await db.query(`SELECT has_function_privilege($1,$2,'EXECUTE') ok`,[role,fn.signature])).rows[0].ok,role==='service_role'&&allowed.has(fn.name),`${role}:${fn.name}`);
  for(const table of ['b013_regional_defaults','b013_default_roots','b013_default_revisions','b013_override_revisions','b013_policy_commands','b013_estimate_heads','b013_estimate_versions','b013_estimate_decisions','b013_repair_emergencies','b013_repair_appointments','b013_repair_commands','b013_repair_event_outbox'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query(`SELECT has_table_privilege($1,$2,$3) ok`,[role,'app.'+table,privilege])).rows[0].ok,false);
 }
 assert.equal(functions.filter(f=>allowed.has(f.name)).length,19);
});

test('actual sandbox default write is isolated and a recorded request cannot adopt a new live organization',async()=>{
 const org=randomUUID(),prop=randomUUID(),contact=randomUUID();
 await db.query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone,environment,live_org_id,feature_flags) VALUES($1,'Default command sandbox','TW','TWD','Asia/Taipei','sandbox',$2,'{"repair_approvals":true}')`,[org,ORG_ID]);
 await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'Sandbox policy property','TW','TWD','Asia/Taipei')`,[prop,org]);await db.query(`INSERT INTO contacts(id,org_id,is_owner,user_id,display_name) VALUES($1,$2,true,$3,'Synthetic sandbox owner')`,[contact,org,USERS.owner]);await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date-1)`,[org,prop,contact]);await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='repair_approvals'`,[ORG_ID,org]);
 try{const sandbox={...s,orgId:org,liveOrgId:ORG_ID,environment:'sandbox' as const},v=await ownerRepairPolicyView(sandbox,prop);assert.ok(v.state==='enabled');const i={propertyId:prop,requestId:randomUUID(),expected:v.snapshot,action:'set' as const,value:'543210'};const result=await changeOwnerRepairDefault(sandbox,i);assert.equal(result.status==='recorded'?result.outcome:null,'changed');assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_default_roots WHERE org_id=$1`,[ORG_ID])).rows[0].n,0);assert.deepEqual(await ownerRepairDefaultStatus(s,prop,i.requestId),{status:'unavailable'});
  await db.query(`UPDATE organizations SET live_org_id=$2 WHERE id=$1`,[org,ORG2_ID]);const changedScope={...sandbox,liveOrgId:ORG2_ID};assert.deepEqual(await ownerRepairDefaultStatus(sandbox,prop,i.requestId),{status:'unavailable'});assert.deepEqual(await ownerRepairDefaultStatus(changedScope,prop,i.requestId),{status:'request_mismatch'});assert.deepEqual(await changeOwnerRepairDefault(changedScope,i),{status:'request_mismatch'});assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_default_revisions WHERE org_id=$1`,[org])).rows[0].n,1);
 }finally{await db.query(`DELETE FROM property_owners WHERE org_id=$1`,[org]);await db.query(`DELETE FROM organizations WHERE id=$1`,[org]);await controls();}
});

async function resetBlockedBy(pid:number,admitted:boolean){const end=Date.now()+4000;while(Date.now()<end){const ok=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND $1::int=ANY(pg_blocking_pids(a.pid)) AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='public.platform_settings'::regclass AND l.mode='ShareRowExclusiveLock' AND l.granted=$2)) ok`,[pid,admitted])).rows[0].ok;if(ok)return true;await new Promise(r=>setTimeout(r,20));}return false;}

test('actual setting command and actual demo reset serialize in both orders and preserve unrelated private data',async()=>{
 await db.query(`CREATE TABLE app.b013_command_reset_probe(value integer)`);await db.query(`INSERT INTO app.b013_command_reset_probe VALUES(7)`);const held=await client(),pending:Promise<void>[]=[];
 try{const i=await intent();await heldBegin(held);await held.query(`SELECT app.b013_change_default($1,$1,'live',$2,$3,$4,$5,'set',$6)`,[ORG_ID,s.sessionId,property,i.requestId,i.expected,i.value]);const pid=(await held.query(`SELECT pg_backend_pid() id`)).rows[0].id;
  const reset=seed();pending.push(reset);assert.equal(await resetBlockedBy(pid,false),true);await heldFinish(held,i.requestId,'change');await reset;for(const table of ['b013_policy_commands','b013_default_revisions','b013_default_roots'])assert.equal((await db.query(`SELECT count(*)::int n FROM app.${table}`)).rows[0].n,0);
  const fresh=(await db.query(`SELECT po.property_id::text property,po.id::text ownership FROM property_owners po JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE po.org_id=$1 AND c.user_id=$2 ORDER BY po.property_id LIMIT 1`,[ORG_ID,USERS.owner])).rows[0];property=fresh.property;ownership=fresh.ownership;await renew();await controls();const next=await intent();await held.query('BEGIN');await held.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);const resetFirst=seed();pending.push(resetFirst);assert.equal(await resetBlockedBy(pid,true),true);assert.deepEqual(await changeOwnerRepairDefault(s,next),{status:'busy'});assert.deepEqual(await closeOwnerRepairDefault(s,property,randomUUID()),{status:'busy'});await held.query('COMMIT');await resetFirst;
  for(const table of ['b013_policy_commands','b013_default_revisions','b013_default_roots'])assert.equal((await db.query(`SELECT count(*)::int n FROM app.${table}`)).rows[0].n,0);assert.equal((await db.query(`SELECT value FROM app.b013_command_reset_probe`)).rows[0].value,7);assert.equal((await db.query(`SELECT threshold_minor::text value FROM app.b013_regional_defaults WHERE country_code='TW' AND currency='TWD'`)).rows[0].value,'500000');
 }finally{await held.query('ROLLBACK');await held.end();await Promise.allSettled(pending);}
});


test('archived property closes new settings but current owner can recover exact original metadata',async()=>{
 const i=await intent(),result=await changeOwnerRepairDefault(s,i);assert.equal(result.status==='recorded'?result.outcome:null,'changed');await db.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[property]);assert.deepEqual(await ownerRepairPolicyView(s,property),{state:'recovery_only'});assert.deepEqual(await changeOwnerRepairDefault(s,i),result);assert.deepEqual(await ownerRepairDefaultStatus(s,property,i.requestId),result);assert.deepEqual(await closeOwnerRepairDefault(s,property,i.requestId),result);const next=await changeOwnerRepairDefault(s,{...i,requestId:randomUUID()});assert.equal(next.status==='recorded'?next.outcome:null,'rejected_unavailable');assert.equal((await counts()).revisions,1);assert.equal((await counts()).audits,1);
});


test('navigation entry IDs are only an informational current-owner scoped rollout hint',async()=>{
 assert.deepEqual(await ownerRepairPolicyEntryIds(s,[property]),[property]);await controls(false);assert.deepEqual(await ownerRepairPolicyEntryIds(s,[property]),[]);await controls();assert.deepEqual(await ownerRepairPolicyEntryIds({...s,kind:'staff',role:'admin'},[property]),[]);assert.deepEqual(await ownerRepairPolicyEntryIds({...s,liveOrgId:ORG2_ID},[property]),[]);await db.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[property]);assert.deepEqual(await ownerRepairPolicyEntryIds(s,[property]),[]);
});

test('cold calls authenticate before private DDL admission and reject actual relation contention, bounded (S3: ~2s lock wait, was NOWAIT), in both orders',async()=>{
 const i=await intent(),expired=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 second')`,[expired,s.userId,randomUUID()]);
 const probes=[
  {table:'app.b013_default_roots',mode:'view'},{table:'app.b013_default_revisions',mode:'view'},{table:'app.b013_override_revisions',mode:'view'},{table:'app.b013_regional_defaults',mode:'view'},
  {table:'app.b013_policy_commands',mode:'change'},{table:'app.b013_policy_commands',mode:'status'},{table:'app.b013_policy_commands',mode:'close'},{table:'app.b013_policy_commands',mode:'finish'},
  {table:'public.audit_log',mode:'view'},{table:'public.organizations',mode:'view'},{table:'public.contacts',mode:'view'},{table:'public.properties',mode:'view'},{table:'public.property_owners',mode:'view'},
 ];
 function invocation(mode:string,sid:string){const scope=[ORG_ID,ORG_ID,'live',sid,property];return mode==='view'?{text:`SELECT app.b013_owner_view($1,$2,$3,$4,$5)`,values:scope}:mode==='change'?{text:`SELECT app.b013_change_default($1,$2,$3,$4,$5,$6,$7,'set',$8)`,values:[...scope,i.requestId,i.expected,i.value]}:mode==='status'?{text:`SELECT app.b013_default_status($1,$2,$3,$4,$5,$6)`,values:[...scope,i.requestId]}:mode==='close'?{text:`SELECT app.b013_close_default($1,$2,$3,$4,$5,$6)`,values:[...scope,i.requestId]}:{text:`SELECT app.b013_finish_default($1,$2,$3,$4,$5,$6,'status')`,values:[...scope,i.requestId]};}
 for(const probe of probes){const held=await client();try{await held.query('BEGIN');await held.query(`LOCK TABLE ${probe.table} IN ACCESS EXCLUSIVE MODE NOWAIT`);
   for(const [sid,expected] of [[s.sessionId,'55P03'],[expired,'42501']]){const cold=await client();try{await heldBegin(cold);const t0=Date.now();await assert.rejects(cold.query(invocation(probe.mode,sid)),(error:unknown)=>{const e=error as {code?:string;message?:string};assert.equal(e.code,expected,probe.table+':'+probe.mode);if(expected==='55P03'){const ms=Date.now()-t0;assert.match(e.message??'',probe.table==='app.b013_regional_defaults'?/could not obtain lock on relation/:/canceling statement due to lock timeout/);assert.ok(ms>=1800&&ms<5000,probe.table+':'+probe.mode+':'+ms+'ms');}return true;});}finally{await cold.query('ROLLBACK');await cold.end();}}
  }finally{await held.query('ROLLBACK');await held.end();}}
 // Reverse order: an actual authorized read or change retains the real
 // relation lock, so the other connection's DDL NOWAIT must fail as well.
 for(const table of ['app.b013_default_roots','app.b013_default_revisions','app.b013_override_revisions','app.b013_regional_defaults','app.b013_policy_commands','public.audit_log']){const reader=await client(),ddl=await client();try{await heldBegin(reader);await reader.query(invocation(table==='app.b013_policy_commands'?'change':'view',s.sessionId));await ddl.query('BEGIN');await assert.rejects(ddl.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE NOWAIT`),(error:unknown)=>{const e=error as {code?:string;message?:string};assert.equal(e.code,'55P03');assert.match(e.message??'',/could not obtain lock on relation/);return true;});}finally{await ddl.query('ROLLBACK');await reader.query('ROLLBACK');await reader.end();await ddl.end();}}
 assert.deepEqual(await counts(),{roots:0,revisions:0,commands:0,audits:0,override:null});
});
