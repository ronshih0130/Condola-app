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
import {changeOwnerRepairDefault,closeOwnerRepairDefault,ownerRepairDefaultStatus,ownerRepairPolicyView} from './repair-owner-policy';
import {changeOwnerRepairOverride,closeOwnerRepairOverride,ownerRepairOverrideStatus,type RepairOverrideIntent} from './repair-owner-override';
disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>,db:Client,s:Session,property:string,ownership:string,contact:string;
async function client(){const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();return c;}
async function seed(){const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}}
async function controls(on=true){await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'`,[ORG_ID,on]);await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"repair_approvals":true}'::jsonb WHERE id=$1`,[ORG_ID]);}
async function renew(ms=3600000){const id=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 millisecond')`,[id,s.userId,randomUUID(),ms]);s.sessionId=id;}
async function intent(value='600000',action:'set'|'clear'='set'):Promise<RepairOverrideIntent>{const v=await ownerRepairPolicyView(s,property);assert.ok(v.state==='enabled');return{propertyId:property,requestId:randomUUID(),expected:v.snapshot,action,value};}
async function facts(){return(await db.query(`SELECT(SELECT repair_approval_threshold_minor::text FROM property_owners WHERE id=$1) value,(SELECT count(*)::int FROM app.b013_override_revisions) revisions,(SELECT count(*)::int FROM app.b013_policy_commands WHERE scope_kind='override') commands,(SELECT count(*)::int FROM audit_log WHERE table_name='b013_override_revisions') audits,(SELECT count(*)::int FROM audit_log WHERE table_name='property_owners' AND row_id=$1::text) public_audits`,[ownership])).rows[0];}
test.before(async()=>{clone=await cloneTestDatabase();db=await client();});
test.beforeEach(async()=>{await seed();const row=(await db.query(`SELECT po.property_id::text property,po.id::text ownership,c.id::text contact FROM property_owners po JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE po.org_id=$1 AND c.user_id=$2 ORDER BY po.property_id LIMIT 1`,[ORG_ID,USERS.owner])).rows[0];property=row.property;ownership=row.ownership;contact=row.contact;await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=777700 WHERE id=$1`,[ownership]);s={kind:'owner',role:null,userId:USERS.owner,sessionId:randomUUID(),orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'zh-TW',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic Owner'};await renew();await controls();});
test.after(async()=>{await db?.end();await clone?.cleanup();});

test('same-value legacy confirmation creates real provenance without a fake public update or self-stale hash',async()=>{
 const before=await facts(),v=await ownerRepairPolicyView(s,property);assert.equal(v.state==='enabled'?v.verified:null,false);const i=await intent('777700'),result=await changeOwnerRepairOverride(s,i);assert.equal(result.status==='recorded'?result.outcome:null,'changed');assert.deepEqual(await facts(),{...before,revisions:1,commands:1,audits:1});const confirmed=await ownerRepairPolicyView(s,property);assert.ok(confirmed.state==='enabled');assert.equal(confirmed.effectiveSource,'property_override');assert.equal(confirmed.effectiveMinor,'777700');assert.equal(confirmed.verified,true);assert.deepEqual(await changeOwnerRepairOverride(s,i),result);
 const same=await changeOwnerRepairOverride(s,await intent('777700'));assert.equal(same.status==='recorded'?same.outcome:null,'no_change');assert.deepEqual(await facts(),{...before,revisions:1,commands:2,audits:1});const event=(await db.query(`SELECT actor_user_id::text actor,actor_role,table_name,reason,request_id,new_row FROM audit_log WHERE table_name='b013_override_revisions'`)).rows;assert.equal(event.length,1);assert.equal(event[0].actor,s.userId);assert.equal(event[0].actor_role,'owner');assert.equal(event[0].request_id,i.requestId);assert.equal(event[0].new_row.public_value_changed,false);
});

test('actual override set and clear preserve exact generic and explicit audit while inheritance uses the owner default',async()=>{
 const before=await facts();await changeOwnerRepairDefault(s,await intent('700000'));const set=await changeOwnerRepairOverride(s,await intent('610001'));assert.equal(set.status==='recorded'?set.outcome:null,'changed');assert.deepEqual(await facts(),{value:'610001',revisions:1,commands:1,audits:1,public_audits:before.public_audits+1});const value=await ownerRepairPolicyView(s,property);assert.equal(value.state==='enabled'?value.effectiveMinor:null,'610001');const clear=await changeOwnerRepairOverride(s,await intent('','clear'));assert.equal(clear.status==='recorded'?clear.outcome:null,'changed');const inherited=await ownerRepairPolicyView(s,property);assert.ok(inherited.state==='enabled');assert.equal(inherited.effectiveSource,'owner_default');assert.equal(inherited.effectiveMinor,'700000');assert.equal(inherited.overrideMinor,null);assert.equal(inherited.verified,true);const no=await changeOwnerRepairOverride(s,await intent('','clear'));assert.equal(no.status==='recorded'?no.outcome:null,'no_change');assert.deepEqual(await facts(),{value:null,revisions:2,commands:3,audits:2,public_audits:before.public_audits+2});
});

test('clearing an override rejects a changed personal-default source captured by the original CAS',async()=>{
 const old=await intent('','clear');await changeOwnerRepairDefault(s,await intent('888800'));const rejected=await changeOwnerRepairOverride(s,old);assert.equal(rejected.status==='recorded'?rejected.outcome:null,'rejected_conflict');assert.equal((await facts()).value,'777700');assert.equal((await facts()).revisions,0);assert.equal((await facts()).audits,0);assert.deepEqual(await changeOwnerRepairOverride(s,old),rejected);
});

test('shared request collisions default to override and override to default cannot be recovered or closed by the other scope',async()=>{
 const d=await intent('500000'),dr=await changeOwnerRepairDefault(s,d);assert.equal(dr.status==='recorded'?dr.outcome:null,'changed');for(const result of [await changeOwnerRepairOverride(s,d),await ownerRepairOverrideStatus(s,property,d.requestId),await closeOwnerRepairOverride(s,property,d.requestId)])assert.deepEqual(result,{status:'request_mismatch'});
 const o=await intent(),or=await changeOwnerRepairOverride(s,o);assert.equal(or.status==='recorded'?or.outcome:null,'changed');for(const result of [await changeOwnerRepairDefault(s,o),await ownerRepairDefaultStatus(s,property,o.requestId),await closeOwnerRepairDefault(s,property,o.requestId)])assert.deepEqual(result,{status:'request_mismatch'});
 const dc=await intent(),oc=await intent();await closeOwnerRepairDefault(s,property,dc.requestId);assert.deepEqual(await closeOwnerRepairOverride(s,property,dc.requestId),{status:'request_mismatch'});await closeOwnerRepairOverride(s,property,oc.requestId);assert.deepEqual(await closeOwnerRepairDefault(s,property,oc.requestId),{status:'request_mismatch'});
});

test('old exact metadata recovers after OFF, currency and ownership-row replacement without retargeting',async()=>{
 const i=await intent(),result=await changeOwnerRepairOverride(s,i);assert.equal(result.status==='recorded'?result.outcome:null,'changed');await db.query(`DELETE FROM property_owners WHERE id=$1`,[ownership]);ownership=(await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from,repair_approval_threshold_minor) VALUES($1,$2,$3,current_date-1,123400) RETURNING id::text`,[ORG_ID,property,contact])).rows[0].id;await db.query(`UPDATE properties SET currency='USD' WHERE id=$1`,[property]);await controls(false);assert.deepEqual(await changeOwnerRepairOverride(s,i),result);assert.deepEqual(await ownerRepairOverrideStatus(s,property,i.requestId),result);assert.deepEqual(await closeOwnerRepairOverride(s,property,i.requestId),result);assert.equal((await facts()).value,'123400');assert.equal((await facts()).revisions,0,'original override rows cascade but receipt metadata is retained');const no=await changeOwnerRepairOverride(s,{...i,requestId:randomUUID()});assert.equal(no.status==='recorded'?no.outcome:null,'rejected_disabled');
});

test('deny-only closure prevents a late override write and cannot undo a committed result',async()=>{
 const i=await intent(),before=await facts(),closed=await closeOwnerRepairOverride(s,property,i.requestId);assert.equal(closed.status==='recorded'?closed.outcome:null,'cancelled');assert.deepEqual(await changeOwnerRepairOverride(s,i),closed);assert.deepEqual(await facts(),{...before,commands:1});const j=await intent(),changed=await changeOwnerRepairOverride(s,j);assert.equal(changed.status==='recorded'?changed.outcome:null,'changed');assert.deepEqual(await closeOwnerRepairOverride(s,property,j.requestId),changed);assert.equal((await facts()).revisions,1);
});

test('generic public-update and explicit private-audit failures both roll back every setting, revision and command',async()=>{
 for(const table of ['property_owners','b013_override_revisions']){const before=await facts(),i=await intent('640000');await db.query(`CREATE FUNCTION app.b013_override_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.table_name='${table}' THEN RAISE EXCEPTION 'Synthetic audit failure' USING ERRCODE='23514',CONSTRAINT='synthetic_override_audit_failure';END IF;RETURN NEW;END$$`);await db.query(`CREATE TRIGGER b013_override_test_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION app.b013_override_test_audit_fail()`);try{assert.deepEqual(await changeOwnerRepairOverride(s,i),{status:'unknown'});assert.deepEqual(await facts(),before);assert.deepEqual(await ownerRepairOverrideStatus(s,property,i.requestId),{status:'unknown'});}finally{await db.query(`DROP TRIGGER b013_override_test_audit_fail ON audit_log`);await db.query(`DROP FUNCTION app.b013_override_test_audit_fail()`);}}
});

async function begin(c:Client){await c.query('BEGIN');await c.query(`SET LOCAL statement_timeout='8s'`);await c.query(`SET LOCAL lock_timeout='3s'`);await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`,[s.userId]);await c.query('SET LOCAL ROLE service_role');}
async function raw(c:Client,i:RepairOverrideIntent){return(await c.query(`SELECT app.b013_change_override($1,$2,$3,$4,$5,$6,$7,$8,$9) v`,[s.orgId,s.liveOrgId,s.environment,s.sessionId,i.propertyId,i.requestId,i.expected,i.action,i.value])).rows[0].v;}
async function finish(c:Client,id:string,mode='change'){await c.query('SET CONSTRAINTS ALL IMMEDIATE');const result=(await c.query(`SELECT app.b013_finish_override($1,$2,$3,$4,$5,$6,$7) v`,[s.orgId,s.liveOrgId,s.environment,s.sessionId,property,id,mode])).rows[0].v;await c.query('COMMIT');return result;}

test('actual generic audit receives the original UUID and owner request context is restored',async()=>{
 const i=await intent(),c=await client();try{await begin(c);await c.query(`SELECT set_config('app.request_id','outer-request',true),set_config('app.change_reason','outer-reason',true)`);await raw(c,i);const context=(await c.query(`SELECT current_setting('app.request_id') request,current_setting('app.change_reason') reason`)).rows[0];assert.deepEqual(context,{request:'outer-request',reason:'outer-reason'});await finish(c,i.requestId);}finally{await c.query('ROLLBACK');await c.end();}const event=(await db.query(`SELECT actor_user_id::text actor,actor_role,request_id,reason FROM audit_log WHERE table_name='property_owners' AND row_id=$1 ORDER BY id DESC LIMIT 1`,[ownership])).rows[0];assert.equal(event.actor,s.userId);assert.equal(event.request_id,i.requestId);assert.equal(event.reason,'owner_repair_override_value');const actualDefiner=(await db.query(`SELECT pg_get_userbyid(proowner) role FROM pg_proc WHERE oid='public.fn_audit()'::regprocedure`)).rows[0].role;assert.equal(event.actor_role,actualDefiner,'generic audit retains the exact actual function definer role');
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



test('real before-COMMIT disconnect and lost backend ACK recover zero or one override without duplicate audit',async()=>{
 for(const fault of ['before_commit','after_commit'] as const){const i=await intent(fault==='before_commit'?'650000':'660000'),before=await facts(),result=await wireFault(fault,()=>changeOwnerRepairOverride(s,i));assert.equal(result.tripped,true);assert.deepEqual(result.value,{status:'unknown'});const flush=result.statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE'),final=result.statements.findIndex(q=>q.includes('b013_finish_override'));assert.ok(flush>=0);assert.equal(final,flush+1);assert.equal(result.statements[final+1],'COMMIT');const recovered=await ownerRepairOverrideStatus(s,property,i.requestId);
  if(fault==='after_commit'){assert.equal(recovered.status==='recorded'?recovered.outcome:null,'changed');assert.deepEqual(await changeOwnerRepairOverride(s,i),recovered);assert.deepEqual(await closeOwnerRepairOverride(s,property,i.requestId),recovered);assert.deepEqual(await facts(),{value:'660000',revisions:before.revisions+1,commands:before.commands+1,audits:before.audits+1,public_audits:before.public_audits+1});}
  else{assert.deepEqual(recovered,{status:'unknown'});assert.deepEqual(await facts(),before);await closeOwnerRepairOverride(s,property,i.requestId);assert.equal((await changeOwnerRepairOverride(s,i)).status,'recorded');assert.equal((await facts()).value,before.value);assert.equal((await facts()).audits,before.audits);}
 }
});

test('natural expiry after final source reads rolls back public and private writes; absent status also rechecks',async()=>{
 const original=(await db.query(`SELECT pg_get_functiondef('app.b013_finish_override(uuid,uuid,text,uuid,uuid,uuid,text)'::regprocedure) definition`)).rows[0].definition;
 try{for(const mode of ['change','status'] as const){const i=await intent(),before=await facts(),marker=1+randomBytes(4).readUInt32BE(0)%1000000000;const instrumented=original.replace('SELECT * INTO final_ctx FROM app.b013_owner_context',`PERFORM pg_advisory_xact_lock(${marker}::bigint);PERFORM pg_sleep(1.5);SELECT * INTO final_ctx FROM app.b013_owner_context`);assert.notEqual(instrumented,original);await db.query(instrumented);await renew(1000);const pending=mode==='change'?changeOwnerRepairOverride(s,i):ownerRepairOverrideStatus(s,property,i.requestId);let observed=false;try{const deadline=Date.now()+900;while(Date.now()<deadline){observed=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND l.classid=0 AND l.objid=$1::oid AND l.granted) observed`,[marker])).rows[0].observed;if(observed)break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(observed,true);assert.equal((await db.query(`SELECT expires_at>clock_timestamp() valid FROM auth_sessions WHERE id=$1`,[s.sessionId])).rows[0].valid,true,'session actually valid at observed final-source barrier');assert.deepEqual(await pending,{status:'unavailable'});assert.deepEqual(await facts(),before);}finally{await pending;await db.query(original);await renew();}}}finally{await db.query(original);}
});

test('actual legacy owner-row writer and override commands conflict in both orders without partial changes',async()=>{
 const i=await intent(),held=await client(),writer=await client(),before=await facts();try{
  await writer.query('BEGIN');await writer.query(`UPDATE property_owners SET repair_approval_threshold_minor=800000 WHERE id=$1`,[ownership]);assert.deepEqual(await changeOwnerRepairOverride(s,i),{status:'busy'});await writer.query('ROLLBACK');assert.deepEqual(await facts(),before);
  await begin(held);await raw(held,i);await writer.query('BEGIN');await writer.query(`SET LOCAL lock_timeout='100ms'`);await assert.rejects(writer.query(`UPDATE property_owners SET repair_approval_threshold_minor=800000 WHERE id=$1`,[ownership]),(e:unknown)=>(e as {code?:string}).code==='55P03');await writer.query('ROLLBACK');await held.query('ROLLBACK');assert.deepEqual(await facts(),before);
  // SHARE is compatible with owner_context's initial row pin, so this case
  // reaches the separately required exact FOR UPDATE NOWAIT upgrade.
  await writer.query('BEGIN');await writer.query(`SELECT 1 FROM property_owners WHERE id=$1 FOR SHARE`,[ownership]);assert.deepEqual(await changeOwnerRepairOverride(s,i),{status:'busy'});await writer.query('ROLLBACK');assert.deepEqual(await facts(),before);
 }finally{await held.query('ROLLBACK');await writer.query('ROLLBACK');await held.end();await writer.end();}
});

test('actual close and write serialize both ways and an in-flight attempt never creates a competing command',async()=>{
 for(const first of ['change','close'] as const){const i=await intent(first==='change'?'610000':'620000'),held=await client();try{await begin(held);if(first==='change')await raw(held,i);else await held.query(`SELECT app.b013_close_override($1,$2,$3,$4,$5,$6)`,[s.orgId,s.liveOrgId,s.environment,s.sessionId,property,i.requestId]);assert.deepEqual(first==='change'?await closeOwnerRepairOverride(s,property,i.requestId):await changeOwnerRepairOverride(s,i),{status:'busy'});const result=await finish(held,i.requestId,first);assert.equal(result.outcome,first==='change'?'changed':'cancelled');assert.deepEqual(await ownerRepairOverrideStatus(s,property,i.requestId),result);assert.deepEqual(await changeOwnerRepairOverride(s,i),result);}finally{await held.query('ROLLBACK');await held.end();}}
 assert.equal((await facts()).revisions,1);assert.equal((await facts()).audits,1);
});

test('other personas, companies, invalid sessions and archived properties cannot create an override',async()=>{
 const i=await intent(),before=await facts();for(const invalid of [{...s,kind:'staff' as const,role:'admin' as const},{...s,kind:'tenant' as const},{...s,orgId:ORG2_ID,liveOrgId:ORG2_ID},{...s,environment:'sandbox' as const},{...s,sessionId:randomUUID()}])assert.deepEqual(await changeOwnerRepairOverride(invalid,i),{status:'unavailable'});assert.deepEqual(await facts(),before);await db.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[property]);const rejected=await changeOwnerRepairOverride(s,i);assert.equal(rejected.status==='recorded'?rejected.outcome:null,'rejected_unavailable');assert.equal((await facts()).revisions,0);
});

test('relinking an owner contact never inherits former principal confirmations or command receipts',async()=>{
 const i=await intent(),old=await changeOwnerRepairOverride(s,i);assert.equal(old.status==='recorded'?old.outcome:null,'changed');const actor=randomUUID();await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[actor,`${randomUUID()}@example.test`]);await db.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[contact,actor]);assert.deepEqual(await ownerRepairOverrideStatus(s,property,i.requestId),{status:'unavailable'});s={...s,userId:actor};await renew();const current=await ownerRepairPolicyView(s,property);assert.ok(current.state==='enabled');assert.equal(current.effectiveSource,'legacy_confirmation_required');assert.equal(current.verified,false);assert.deepEqual(await ownerRepairOverrideStatus(s,property,i.requestId),{status:'unknown'});const confirmed=await changeOwnerRepairOverride(s,await intent('600000'));assert.equal(confirmed.status==='recorded'?confirmed.outcome:null,'changed');const rows=(await db.query(`SELECT principal_id::text actor FROM app.b013_override_revisions ORDER BY recorded_at`)).rows;assert.deepEqual(rows.map(r=>r.actor),[USERS.owner,actor]);
});

test('bounded invalid amounts are terminal without audit, while exact bigint maximum remains an integer',async()=>{
 const before=await facts();for(const value of ['-1','01','1.2','1e3','9223372036854775808','']){const result=await changeOwnerRepairOverride(s,await intent(value));assert.equal(result.status==='recorded'?result.outcome:null,'rejected_invalid');}assert.equal((await facts()).value,before.value);assert.equal((await facts()).revisions,0);assert.equal((await facts()).audits,0);const max=await changeOwnerRepairOverride(s,await intent('9223372036854775807'));assert.equal(max.status==='recorded'?max.outcome:null,'changed');assert.equal((await facts()).value,'9223372036854775807');
});

test('cold private/public DDL and exact write-mode admissions deny promptly after auth, with reverse controls',async()=>{
 const i=await intent(),expired=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 second')`,[expired,s.userId,randomUUID()]);
 const probes=[{table:'app.b013_policy_commands',mode:'change',lock:'ACCESS EXCLUSIVE'},{table:'app.b013_policy_commands',mode:'status',lock:'ACCESS EXCLUSIVE'},{table:'app.b013_policy_commands',mode:'close',lock:'ACCESS EXCLUSIVE'},{table:'app.b013_policy_commands',mode:'finish',lock:'ACCESS EXCLUSIVE'},{table:'app.b013_override_revisions',mode:'change',lock:'ACCESS EXCLUSIVE'},{table:'app.b013_default_roots',mode:'change',lock:'ACCESS EXCLUSIVE'},{table:'app.b013_default_revisions',mode:'change',lock:'ACCESS EXCLUSIVE'},{table:'app.b013_regional_defaults',mode:'change',lock:'ACCESS EXCLUSIVE'},{table:'public.property_owners',mode:'change',lock:'SHARE'},{table:'public.audit_log',mode:'change',lock:'SHARE'},{table:'app.b013_override_revisions',mode:'change',lock:'SHARE'}];
 function call(mode:string,sid:string){const scope=[s.orgId,s.liveOrgId,s.environment,sid,property,i.requestId];return mode==='change'?{text:`SELECT app.b013_change_override($1,$2,$3,$4,$5,$6,$7,'set',$8)`,values:[...scope,i.expected,i.value]}:mode==='status'?{text:`SELECT app.b013_override_status($1,$2,$3,$4,$5,$6)`,values:scope}:mode==='close'?{text:`SELECT app.b013_close_override($1,$2,$3,$4,$5,$6)`,values:scope}:{text:`SELECT app.b013_finish_override($1,$2,$3,$4,$5,$6,'status')`,values:scope};}
 for(const probe of probes){const held=await client();try{await held.query('BEGIN');await held.query(`LOCK TABLE ${probe.table} IN ${probe.lock} MODE NOWAIT`);for(const [sid,expected] of [[s.sessionId,'55P03'],[expired,'42501']]){const cold=await client();try{await begin(cold);await assert.rejects(cold.query(call(probe.mode,sid)),(error:unknown)=>{const e=error as {code?:string;message?:string};assert.equal(e.code,expected,probe.table+':'+probe.mode);if(expected==='55P03'){assert.match(e.message??'',/could not obtain lock on relation/);assert.doesNotMatch(e.message??'',/timeout/);}return true;});}finally{await cold.query('ROLLBACK');await cold.end();}}}finally{await held.query('ROLLBACK');await held.end();}}
 for(const table of ['public.property_owners','public.audit_log','app.b013_override_revisions','app.b013_policy_commands']){const writer=await client(),ddl=await client();try{await begin(writer);await raw(writer,i);await ddl.query('BEGIN');await assert.rejects(ddl.query(`LOCK TABLE ${table} IN SHARE MODE NOWAIT`),(error:unknown)=>{const e=error as {code?:string;message?:string};assert.equal(e.code,'55P03');assert.match(e.message??'',/could not obtain lock on relation/);return true;});}finally{await writer.query('ROLLBACK');await ddl.query('ROLLBACK');await writer.end();await ddl.end();}}
 assert.equal((await facts()).commands,0);assert.equal((await facts()).revisions,0);
});

test('all policy tables and helpers remain private with exactly nine fixed service gateways',async()=>{
 const allowed=new Set(['b013_owner_view','b013_change_default','b013_default_status','b013_close_default','b013_finish_default','b013_change_override','b013_override_status','b013_close_override','b013_finish_override']);const functions=(await db.query(`SELECT p.oid::regprocedure::text signature,p.proname name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'b013_%'`)).rows;
 for(const role of ['anon','authenticated','service_role']){for(const fn of functions)assert.equal((await db.query(`SELECT has_function_privilege($1,$2,'EXECUTE') ok`,[role,fn.signature])).rows[0].ok,role==='service_role'&&allowed.has(fn.name),`${role}:${fn.name}`);for(const table of ['b013_regional_defaults','b013_default_roots','b013_default_revisions','b013_override_revisions','b013_policy_commands'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query(`SELECT has_table_privilege($1,$2,$3) ok`,[role,'app.'+table,privilege])).rows[0].ok,false);}
 assert.equal(functions.filter(f=>allowed.has(f.name)).length,9);
});

test('actual sandbox override stays isolated and reparenting cannot adopt the original live scope',async()=>{
 const original={s:{...s},property,ownership,contact},org=randomUUID(),prop=randomUUID(),ct=randomUUID();await db.query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone,environment,live_org_id,feature_flags) VALUES($1,'Override sandbox','TW','TWD','Asia/Taipei','sandbox',$2,'{"repair_approvals":true}')`,[org,ORG_ID]);await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'Override sandbox property','TW','TWD','Asia/Taipei')`,[prop,org]);await db.query(`INSERT INTO contacts(id,org_id,is_owner,user_id,display_name) VALUES($1,$2,true,$3,'Synthetic sandbox owner')`,[ct,org,s.userId]);const po=(await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date-1) RETURNING id::text`,[org,prop,ct])).rows[0].id;await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='repair_approvals'`,[ORG_ID,org]);
 try{s={...s,orgId:org,liveOrgId:ORG_ID,environment:'sandbox'};property=prop;ownership=po;contact=ct;const i=await intent('432100'),result=await changeOwnerRepairOverride(s,i);assert.equal(result.status==='recorded'?result.outcome:null,'changed');assert.equal((await facts()).value,'432100');assert.equal((await db.query(`SELECT repair_approval_threshold_minor::text v FROM property_owners WHERE id=$1`,[original.ownership])).rows[0].v,'777700');await db.query(`UPDATE organizations SET live_org_id=$2 WHERE id=$1`,[org,ORG2_ID]);assert.deepEqual(await ownerRepairOverrideStatus(s,prop,i.requestId),{status:'unavailable'});s={...s,liveOrgId:ORG2_ID};assert.deepEqual(await ownerRepairOverrideStatus(s,prop,i.requestId),{status:'request_mismatch'});assert.deepEqual(await changeOwnerRepairOverride(s,i),{status:'request_mismatch'});
 }finally{await db.query(`DELETE FROM property_owners WHERE org_id=$1`,[org]);await db.query(`DELETE FROM organizations WHERE id=$1`,[org]);s=original.s;property=original.property;ownership=original.ownership;contact=original.contact;await controls();}
});

async function resetBlockedBy(pid:number,admitted:boolean){const deadline=Date.now()+4000;while(Date.now()<deadline){if((await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND $1::int=ANY(pg_blocking_pids(a.pid)) AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='public.platform_settings'::regclass AND l.mode='ShareRowExclusiveLock' AND l.granted=$2)) ok`,[pid,admitted])).rows[0].ok)return true;await new Promise(resolve=>setTimeout(resolve,20));}return false;}

test('actual override and demo reset serialize both ways, clear policy children and preserve unrelated data',async()=>{
 await db.query(`CREATE TABLE app.b013_override_reset_probe(value integer)`);await db.query(`INSERT INTO app.b013_override_reset_probe VALUES(7)`);const held=await client(),pending:Promise<void>[]=[];try{
  const i=await intent();await begin(held);await raw(held,i);const pid=(await held.query(`SELECT pg_backend_pid() id`)).rows[0].id;const reset=seed();pending.push(reset);assert.equal(await resetBlockedBy(pid,false),true);await finish(held,i.requestId);await reset;for(const table of ['b013_override_revisions','b013_policy_commands'])assert.equal((await db.query(`SELECT count(*)::int n FROM app.${table}`)).rows[0].n,0);
  const next=(await db.query(`SELECT po.property_id::text property,po.id::text ownership,c.id::text contact FROM property_owners po JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE po.org_id=$1 AND c.user_id=$2 ORDER BY po.property_id LIMIT 1`,[ORG_ID,USERS.owner])).rows[0];property=next.property;ownership=next.ownership;contact=next.contact;await renew();await controls();const fresh=await intent();await held.query('BEGIN');await held.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);const resetFirst=seed();pending.push(resetFirst);assert.equal(await resetBlockedBy(pid,true),true);assert.deepEqual(await changeOwnerRepairOverride(s,fresh),{status:'busy'});assert.deepEqual(await closeOwnerRepairOverride(s,property,randomUUID()),{status:'busy'});await held.query('COMMIT');await resetFirst;for(const table of ['b013_override_revisions','b013_policy_commands'])assert.equal((await db.query(`SELECT count(*)::int n FROM app.${table}`)).rows[0].n,0);assert.equal((await db.query(`SELECT value FROM app.b013_override_reset_probe`)).rows[0].value,7);assert.equal((await db.query(`SELECT threshold_minor::text value FROM app.b013_regional_defaults WHERE country_code='TW' AND currency='TWD'`)).rows[0].value,'500000');
 }finally{await held.query('ROLLBACK');await held.end();await Promise.allSettled(pending);}
});
