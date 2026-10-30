import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { captureHandoverBeforeDemoReset } from "./handover-demo-reset";
import { captureSettlementBeforeDemoReset, reconcileSettlementDemoObjects } from "./settlement-demo-reset";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { publishHandover, prepareHandoverUpload, uploadHandoverBytes, finalizeHandoverUpload } from "./handover";
import { bindSettlementLine } from "./settlement-line-bindings";
import { assertSettlementRentCycle } from "./settlement-cycle";
import { setDepositAttribution,setRentAttribution } from "./settlement-attribution";
import { recordPayment, reversePayment } from "./domain";
import { svc } from "./db";
import { recoverEmptySettlementDraft, settlementCommandStatus } from "./settlement-command-status";
import { settlementAccess } from "./settlement-access";
import { previewFinalRent } from "./settlement-rent-quote";
import { recordMoveOutNotice } from "./move-out-notice";
import { previewSettlement } from "./settlement-preview";
import { readSettlement, saveSettlement } from "./settlement-statement";
import { replySettlement } from "./settlement-replies";
import { readSettlementEvidence } from "./settlement-evidence";
import { shareHandoverEvidence, prepareSettlementUpload, uploadSettlementBytes, finalizeSettlementUpload, discardSettlementUpload } from "./settlement-attachments";
import { observeExternalOutcome, reportSettlementOutcome, replySettlementOutcome } from "./settlement-outcomes";
import type { Session } from "./types";
const source=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let admin:Client, db:Client, name:string, owned=false, previous:string|undefined;
test.before(async()=>{
  const template=decodeURIComponent(source.pathname.slice(1)); if(!/^[a-z][a-z0-9_]{0,62}$/.test(template)) throw new Error("Invalid template");
  name=`condola_b011_${randomUUID().replaceAll("-","")}`; admin=new Client({connectionString:withDatabase(source,"postgres")}); await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`); owned=true;
  db=new Client({connectionString:withDatabase(source,name)}); await db.connect();
  for (const [table,file] of [["handover_records","20261031100214_b011_handover_records.sql"],["settlement_sources","20261031100216_b011_settlement.sql"]]) {
    if (!(await db.query(`SELECT to_regclass($1) IS NOT NULL AS installed`,[`app.${table}`])).rows[0].installed) await db.query(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),"utf8"));
  }
  previous=process.env.DATABASE_URL; process.env.DATABASE_URL=withDatabase(source,name); await resetAndSeed();
});
test.after(async()=>{ if(previous===undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=previous; await db?.end(); if(owned) await admin.query(`DROP DATABASE "${name}"`); await admin?.end(); });
test("source attribution is bounded, replayable, isolated and invalid after reversal",async()=>{
  const target=(await db.query<{id:string;property_id:string}>(`SELECT l.id,l.property_id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 AND lp.role='primary' AND l.status<>'draft' LIMIT 1`,[ORG_ID,USERS.tenant])).rows[0]; assert.ok(target);
  const lease=target.id;
  const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,'SYNTHETIC-B011','TWD',current_date,'draft') RETURNING id`,[ORG_ID,target.property_id,lease])).rows[0].id;
  await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic rent',1,100000,100000)`,[ORG_ID,invoice]);
  await db.query(`UPDATE invoices SET status='open' WHERE id=$1`,[invoice]);
  const sid=randomUUID(); await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  const staff={userId:USERS.admin,sessionId:sid,orgId:ORG_ID,liveOrgId:ORG_ID,kind:"staff",role:"admin",environment:"live",locale:"en",calendar:"gregorian",leaseId:null,name:"Synthetic",email:""} as Session;
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"handover_records":true,"deposit_settlements":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('handover_records','deposit_settlements')`,[ORG_ID]);
  const owner=(await db.query<{id:string;user_id:string}>(`SELECT po.id,c.user_id FROM property_owners po JOIN contacts c ON c.id=po.owner_contact_id WHERE po.org_id=$1 AND po.property_id=$2 AND c.user_id IS NOT NULL AND c.is_owner LIMIT 1`,[ORG_ID,target.property_id])).rows[0]; assert.ok(owner);
  const ownerSession=randomUUID(); await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[ownerSession,owner.user_id,randomUUID()]);
  const ownerIdentity={...staff,userId:owner.user_id,sessionId:ownerSession,kind:"owner" as const,role:null};
  await db.query(`UPDATE property_owners SET effective_to=(SELECT timezone(timezone,clock_timestamp())::date+1 FROM organizations WHERE id=$1) WHERE id=$2`,[ORG_ID,owner.id]);
  await svc(ownerIdentity.userId,client=>settlementAccess(client,ownerIdentity,lease,"read"));
  await db.query(`UPDATE property_owners SET effective_to=(SELECT timezone(timezone,clock_timestamp())::date FROM organizations WHERE id=$1) WHERE id=$2`,[ORG_ID,owner.id]);
  await assert.rejects(svc(ownerIdentity.userId,client=>settlementAccess(client,ownerIdentity,lease,"read")));
  const objects=new Map<string,Buffer>(); let latePost:(()=>Promise<void>)|null=null, pauseGet:(()=>Promise<void>)|null=null, pauseDelete:(()=>Promise<void>)|null=null;
  const server=createServer(async(req,res)=>{
    const key=req.url??"";
    if(req.method==="POST") { const chunks:Buffer[]=[]; for await(const c of req) chunks.push(Buffer.from(c)); if(objects.has(key))return res.writeHead(409).end(); const data=Buffer.concat(chunks); if(latePost){const pause=latePost;latePost=null;res.destroy();await pause();objects.set(key,data);return;} objects.set(key,data);return res.writeHead(200).end(); }
    if(req.method==="GET") {if(pauseGet){const pause=pauseGet;pauseGet=null;await pause();}const data=objects.get(key);return data?res.writeHead(200).end(data):res.writeHead(404).end();}
    if(req.method==="DELETE") {if(pauseDelete){const pause=pauseDelete;pauseDelete=null;await pause();}objects.delete(key);return res.writeHead(200).end();}
    return res.writeHead(404).end();
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address && typeof address!=="string");
  const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;process.env.SUPABASE_URL=`http://127.0.0.1:${address.port}`;process.env.SUPABASE_SERVICE_ROLE_KEY="synthetic-only";
  try {
    const version=await publishHandover(staff,lease,"move_in","Evidence",null);const bytes=Uint8Array.from([0xff,0xd8,0xff,1]);const sha256=createHash("sha256").update(bytes).digest("hex");
    const intent=await prepareHandoverUpload(staff,lease,version.id,{fileName:"evidence.jpg",mime:"image/jpeg",size:bytes.length}); await uploadHandoverBytes(staff,lease,intent.intentId,bytes);const handoverEvidence=await finalizeHandoverUpload(staff,lease,intent.intentId);
    const empty={leaseId:lease,attributionIds:[],items:[]}; const emptyPreview=await previewSettlement(staff,empty);
    const draftRequest=randomUUID();
    assert.equal((await settlementCommandStatus(staff,lease,null,"statement",draftRequest)).status,"unknown");
    const draft=(await saveSettlement(staff,empty,emptyPreview.fingerprint,null,draftRequest,false)).id;
    assert.equal((await settlementCommandStatus(staff,lease,null,"statement",draftRequest)).status,"recorded");
    assert.equal(await recoverEmptySettlementDraft(staff,lease,null,draftRequest),draft);
    await assert.rejects(recoverEmptySettlementDraft(staff,lease,randomUUID(),draftRequest));
    const evidenceId=await shareHandoverEvidence(staff,lease,draft,handoverEvidence.id);
    const payment=await recordPayment(staff,{leaseId:lease,amountMajor:100,paidOn:"2026-10-01",last5:"12345",reference:"synthetic"});
    const input={leaseId:lease,evidenceId:evidenceId,requestId:randomUUID(),expectedAttributionId:null,amountMinor:7000,reason:"Synthetic allocation",source:{kind:"payment" as const,paymentId:payment.paymentId}};
    await assert.rejects(setDepositAttribution({...staff,orgId:ORG2_ID,liveOrgId:ORG2_ID},input));
    const externalInput={...input,source:{kind:"external" as const,identity:"BankRef",declaredMinor:20000},amountMinor:1000,requestId:randomUUID()};
    const externalFirst=(await setDepositAttribution(staff,externalInput)).id;
    const externalCorrection={...externalInput,source:{kind:"external" as const,identity:"bankref",declaredMinor:20000},amountMinor:1200,expectedAttributionId:externalFirst,requestId:randomUUID()};
    const correctedExternal=await setDepositAttribution(staff,externalCorrection);
    assert.equal((await setDepositAttribution(staff,externalCorrection)).id,correctedExternal.id);
    const first=(await setDepositAttribution(staff,input)).id;assert.equal((await setDepositAttribution(staff,input)).id,first);
    await assert.rejects(setDepositAttribution(staff,{...input,amountMinor:7001}));
    const outcomes=await Promise.allSettled([setDepositAttribution(staff,{...input,requestId:randomUUID(),expectedAttributionId:first,amountMinor:8000}),setDepositAttribution(staff,{...input,requestId:randomUUID(),expectedAttributionId:first,amountMinor:9000})]);
    assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
    const current=outcomes.find(x=>x.status==="fulfilled"); assert.ok(current && current.status==="fulfilled");
    await assert.rejects(setDepositAttribution(staff,{...input,requestId:randomUUID(),expectedAttributionId:current.value.id,amountMinor:10001}));
    const manualItem={key:randomUUID(),label:"Synthetic damage",amountMinor:1000,reason:"Synthetic documented item",evidenceId:evidenceId,invoiceLineId:null};
    const previewInput={leaseId:lease,attributionIds:[current.value.id],items:[manualItem],sourceReview:{attested:true as const,evidenceId}};
    const counts=async()=> (await db.query(`SELECT (SELECT count(*)::int FROM payments) AS payments,(SELECT count(*)::int FROM payment_allocations) AS allocations,(SELECT count(*)::int FROM ledger_transactions) AS ledgers`)).rows[0];
    const financialBefore=await counts();
    const unreviewed=await previewSettlement(staff,{...previewInput,sourceReview:null}); assert.equal(unreviewed.calculation.authoritative,false);
    const linkedLine=(await db.query<{id:string}>(`SELECT id FROM invoice_lines WHERE invoice_id=$1`,[invoice])).rows[0].id;
    const linked=await previewSettlement(staff,{...previewInput,items:[{...manualItem,invoiceLineId:linkedLine}]}); assert.equal(linked.calculation.authoritative,false);
    const preview=await previewSettlement(staff,previewInput);
    assert.equal(preview.calculation.authoritative,true); assert.deepEqual(await counts(),financialBefore);
    await db.query(`CREATE FUNCTION app.test_settlement_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='settlement_version_saved' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER test_settlement_audit_failure BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION app.test_settlement_audit_failure()`);
    await assert.rejects(saveSettlement(staff,previewInput,preview.fingerprint,draft,randomUUID(),true));
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.settlement_versions`)).rows[0].n,1); assert.deepEqual(await counts(),financialBefore);
    await db.query(`DROP TRIGGER test_settlement_audit_failure ON public.audit_log`);
    const saveId=randomUUID(); const savePair=await Promise.all([saveSettlement(staff,previewInput,preview.fingerprint,draft,saveId,true),saveSettlement(staff,previewInput,preview.fingerprint,draft,saveId,true)]);
    const saved=savePair[0].id; assert.equal(savePair[1].id,saved); assert.equal(savePair.filter(x=>x.recovered).length,1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.settlement_versions WHERE id=$1`,[saved])).rows[0].n,1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE event_type='settlement_version_saved' AND new_row->>'version_id'=$1`,[saved])).rows[0].n,1);
    assert.deepEqual(await counts(),financialBefore);
    const freshPreview=await previewSettlement(staff,previewInput); assert.equal(freshPreview.fingerprint,preview.fingerprint);
    const reviewedView=await readSettlement(staff,lease,saved); assert.equal(reviewedView.stale,false); assert.equal(reviewedView.sourceReview?.evidenceId,evidenceId); assert.ok(reviewedView.sourceReview?.createdAt);
    const admissionHolder=new Client({connectionString:withDatabase(source,name)});await admissionHolder.connect();await admissionHolder.query("BEGIN");
    try {
      await admissionHolder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`b011:rent-cycle:${ORG_ID}:${lease}`]);
      const busyView=await readSettlement(staff,lease,saved);assert.equal(busyView.freshnessUnavailable,true);assert.equal(busyView.stale,false);assert.deepEqual(busyView.calculation,reviewedView.calculation);
      const busyReplay=await saveSettlement(staff,previewInput,preview.fingerprint,draft,saveId,true);assert.equal(busyReplay.id,saved);assert.equal(busyReplay.freshnessUnavailable,true);assert.equal(busyReplay.stale,false);
    } finally {await admissionHolder.query("ROLLBACK");await admissionHolder.end();}

    const tenantSid=randomUUID(); await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[tenantSid,USERS.tenant,randomUUID()]);
    const tenant={...staff,userId:USERS.tenant,sessionId:tenantSid,kind:"tenant" as const,role:null,leaseId:lease};
    assert.equal((await readSettlement(tenant,lease,saved)).stale,false);
    await assert.rejects(readSettlement({...tenant,leaseId:randomUUID()},lease,saved));
    await db.query(`UPDATE property_owners SET effective_to=(SELECT timezone(timezone,clock_timestamp())::date+1 FROM organizations WHERE id=$1) WHERE id=$2`,[ORG_ID,owner.id]);
    const partyView=await readSettlement(ownerIdentity,lease,saved);
    assert.equal(partyView.stale,false); assert.deepEqual(partyView.provenance.map(p=>p.kind),["payment"]);
    assert.equal(partyView.items[0].original_minor,"1000"); assert.equal(partyView.items[0].adjustment_minor,"0");
    assert.ok(!JSON.stringify(partyView).includes(payment.paymentId));
    assert.deepEqual((await readSettlementEvidence(ownerIdentity,lease,saved,evidenceId)).bytes,bytes);
    await assert.rejects(readSettlementEvidence({...tenant,leaseId:randomUUID()},lease,saved,evidenceId));
    // Owner uploads are settlement-scoped; no broad handover read is granted.
    await assert.rejects(readSettlementEvidence(ownerIdentity,lease,saved,handoverEvidence.id));
    await assert.rejects(prepareSettlementUpload(ownerIdentity,lease,draft,{requestId:randomUUID(),fileName:"owner.jpg",mime:"image/jpeg",size:bytes.length,sha256}));
    const ownerRequest=randomUUID(); const ownerUpload={requestId:ownerRequest,fileName:"owner.jpg",mime:"image/jpeg",size:bytes.length,sha256};
    const ownerIntent=await prepareSettlementUpload(ownerIdentity,lease,saved,ownerUpload);
    assert.deepEqual(await settlementCommandStatus(ownerIdentity,lease,saved,"upload",ownerRequest),{status:"pending",id:ownerIntent});
    assert.equal(await prepareSettlementUpload(ownerIdentity,lease,saved,ownerUpload),ownerIntent);
    await assert.rejects(prepareSettlementUpload(ownerIdentity,lease,saved,{...ownerUpload,fileName:"changed.jpg"}));
    const recordLock=new Client({connectionString:withDatabase(source,name)});await recordLock.connect();await recordLock.query("BEGIN");
    await recordLock.query(`SELECT r.id FROM app.settlement_records r JOIN app.settlement_versions v ON v.record_id=r.id WHERE v.id=$1 FOR UPDATE OF r`,[saved]);
    await db.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '350 milliseconds' WHERE id=$1`,[ownerSession]);
    const expiredUpload=uploadSettlementBytes(ownerIdentity,lease,saved,ownerIntent,bytes).then(()=>"allowed",()=>"denied");
    let ownerWaiting=false;for(let n=0;n<40&&!ownerWaiting;n++){await new Promise(r=>setTimeout(r,20));ownerWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%settlement_records%FOR UPDATE%') AS blocked`)).rows[0].blocked;}
    assert.ok(ownerWaiting);await new Promise(r=>setTimeout(r,450));await recordLock.query("COMMIT");await recordLock.end();assert.equal(await expiredUpload,"denied");
    await db.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`,[ownerSession]);
    await db.query(`UPDATE property_owners SET effective_to=(SELECT timezone(timezone,clock_timestamp())::date FROM organizations WHERE id=$1) WHERE id=$2`,[ORG_ID,owner.id]);
    await assert.rejects(uploadSettlementBytes(ownerIdentity,lease,saved,ownerIntent,bytes));
    await db.query(`UPDATE property_owners SET effective_to=(SELECT timezone(timezone,clock_timestamp())::date+1 FROM organizations WHERE id=$1) WHERE id=$2`,[ORG_ID,owner.id]);
    await uploadSettlementBytes(ownerIdentity,lease,saved,ownerIntent,bytes);
    const ownerEvidence=await finalizeSettlementUpload(ownerIdentity,lease,saved,ownerIntent);
    assert.deepEqual(await settlementCommandStatus(ownerIdentity,lease,saved,"upload",ownerRequest),{status:"recorded",id:ownerIntent});
    assert.equal((await settlementCommandStatus(tenant,lease,saved,"upload",ownerRequest)).status,"unknown");
    assert.equal(await finalizeSettlementUpload(ownerIdentity,lease,saved,ownerIntent),ownerEvidence);
    assert.deepEqual((await readSettlementEvidence(ownerIdentity,lease,saved,ownerEvidence)).bytes,bytes);
    assert.deepEqual((await readSettlementEvidence(tenant,lease,saved,ownerEvidence)).bytes,bytes);
    await assert.rejects(readSettlementEvidence(ownerIdentity,lease,draft,ownerEvidence));
    await discardSettlementUpload(ownerIdentity,lease,saved,ownerIntent);
    assert.deepEqual((await readSettlementEvidence(ownerIdentity,lease,saved,ownerEvidence)).bytes,bytes);
    const settlementPath=(await db.query<{storage_path:string}>(`SELECT storage_path FROM app.settlement_upload_intents WHERE id=$1`,[ownerIntent])).rows[0].storage_path;
    const sealedKey=`/storage/v1/object/handover-attachments-private/${settlementPath}/sealed`;
    objects.set(sealedKey,Buffer.from([0xff,0xd8,0xff,9]));await assert.rejects(readSettlementEvidence(ownerIdentity,lease,saved,ownerEvidence));objects.set(sealedKey,Buffer.from(bytes));
    await db.query(`UPDATE property_owners SET effective_to=(SELECT timezone(timezone,clock_timestamp())::date FROM organizations WHERE id=$1) WHERE id=$2`,[ORG_ID,owner.id]);
    await assert.rejects(readSettlementEvidence(ownerIdentity,lease,saved,ownerEvidence));
    await db.query(`UPDATE property_owners SET effective_to=(SELECT timezone(timezone,clock_timestamp())::date+1 FROM organizations WHERE id=$1) WHERE id=$2`,[ORG_ID,owner.id]);
    const accountantSid=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[accountantSid,USERS.accountant,randomUUID()]);
    const accountant={...staff,userId:USERS.accountant,sessionId:accountantSid,role:"accountant" as const};
    const accountantIntent=await prepareSettlementUpload(accountant,lease,saved,{requestId:randomUUID(),fileName:"accountant.jpg",mime:"image/jpeg",size:bytes.length,sha256});
    await uploadSettlementBytes(accountant,lease,saved,accountantIntent,bytes);const accountantEvidence=await finalizeSettlementUpload(accountant,lease,saved,accountantIntent);
    await db.query(`UPDATE org_members SET role='maintenance' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.accountant]);
    await assert.rejects(readSettlementEvidence(accountant,lease,saved,accountantEvidence));
    await db.query(`UPDATE org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.accountant]);

    const staffIntent=await prepareSettlementUpload(staff,lease,saved,{requestId:randomUUID(),fileName:"staff.jpg",mime:"image/jpeg",size:bytes.length,sha256});
    await assert.rejects(uploadSettlementBytes(staff,lease,saved,staffIntent,Uint8Array.from([1,2,3,4])));
    await assert.rejects(uploadSettlementBytes(staff,lease,saved,staffIntent,Uint8Array.from([0xff,0xd8,0xff,2])));
    await uploadSettlementBytes(staff,lease,saved,staffIntent,bytes);
    await db.query(`CREATE FUNCTION app.test_settlement_upload_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='settlement_evidence_uploaded' THEN RAISE EXCEPTION 'synthetic upload audit failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER test_settlement_upload_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION app.test_settlement_upload_audit()`);
    await assert.rejects(finalizeSettlementUpload(staff,lease,saved,staffIntent));
    assert.equal((await db.query(`SELECT status FROM app.settlement_upload_intents WHERE id=$1`,[staffIntent])).rows[0].status,"pending");
    await db.query(`DROP TRIGGER test_settlement_upload_audit ON public.audit_log`);
    const staffEvidence=await finalizeSettlementUpload(staff,lease,saved,staffIntent); assert.ok(staffEvidence);
    const lateIntent=await prepareSettlementUpload(tenant,lease,saved,{requestId:randomUUID(),fileName:"late.jpg",mime:"image/jpeg",size:bytes.length,sha256});
    let lateRelease!:()=>void,lateWritten!:()=>void;const lateGate=new Promise<void>(r=>{lateRelease=r;}), lateDone=new Promise<void>(r=>{lateWritten=r;});
    latePost=async()=>{await lateGate;setImmediate(lateWritten);};
    await assert.rejects(uploadSettlementBytes(tenant,lease,saved,lateIntent,bytes));
    await discardSettlementUpload(tenant,lease,saved,lateIntent);
    const latePath=(await db.query<{storage_path:string}>(`SELECT storage_path FROM app.settlement_upload_intents WHERE id=$1`,[lateIntent])).rows[0].storage_path;
    const lateKey=`/storage/v1/object/handover-attachments-private/${latePath}`; assert.equal(objects.has(lateKey),false);
    lateRelease();await lateDone;assert.equal(objects.has(lateKey),true);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.settlement_evidence WHERE intent_id=$1`,[lateIntent])).rows[0].n,0);
    await discardSettlementUpload(tenant,lease,saved,lateIntent);assert.equal(objects.has(lateKey),false);
    const raceIntent=await prepareSettlementUpload(tenant,lease,saved,{requestId:randomUUID(),fileName:"race.jpg",mime:"image/jpeg",size:bytes.length,sha256});await uploadSettlementBytes(tenant,lease,saved,raceIntent,bytes);
    let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}), gate=new Promise<void>(r=>{release=r;}); pauseGet=async()=>{entered();await gate;};
    const finishing=finalizeSettlementUpload(tenant,lease,saved,raceIntent);await reached;const cleanup=discardSettlementUpload(tenant,lease,saved,raceIntent);
    let blocked=false;for(let n=0;n<40&&!blocked;n++){await new Promise(r=>setTimeout(r,25));blocked=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%settlement_records%FOR UPDATE%') AS blocked`)).rows[0].blocked;}
    release();assert.ok(blocked);const raceEvidence=await finishing;await cleanup;assert.deepEqual((await readSettlementEvidence(tenant,lease,saved,raceEvidence)).bytes,bytes);
    const discardFirst=await prepareSettlementUpload(tenant,lease,saved,{requestId:randomUUID(),fileName:"discard-first.jpg",mime:"image/jpeg",size:bytes.length,sha256});await uploadSettlementBytes(tenant,lease,saved,discardFirst,bytes);
    let deletionStarted!:()=>void,deleteRelease!:()=>void;const deleteReached=new Promise<void>(r=>{deletionStarted=r;}),deleteGate=new Promise<void>(r=>{deleteRelease=r;}); pauseDelete=async()=>{deletionStarted();await deleteGate;};
    const deleting=discardSettlementUpload(tenant,lease,saved,discardFirst);await deleteReached;const deniedFinalize=finalizeSettlementUpload(tenant,lease,saved,discardFirst).then(()=>"allowed",()=>"denied");
    let finalWaiting=false;for(let n=0;n<40&&!finalWaiting;n++){await new Promise(r=>setTimeout(r,25));finalWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%settlement_records%FOR UPDATE%') AS blocked`)).rows[0].blocked;}
    deleteRelease();assert.ok(finalWaiting);await deleting;assert.equal(await deniedFinalize,"denied");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.settlement_outcome_events`)).rows[0].n,0);


    const nextDraftPreview=await previewSettlement(staff,previewInput);
    const nextDraft=(await saveSettlement(staff,previewInput,nextDraftPreview.fingerprint,saved,randomUUID(),false)).id;
    assert.equal((await saveSettlement(staff,previewInput,preview.fingerprint,draft,saveId,true)).current,true);
    const tenantReply={leaseId:lease,versionId:saved,response:"confirm" as const,note:"Tenant reply",requestId:randomUUID()};
    const replyPair=await Promise.all([replySettlement(tenant,tenantReply),replySettlement(tenant,tenantReply)]);assert.equal(replyPair[0],replyPair[1]);
    await replySettlement(ownerIdentity,{leaseId:lease,versionId:saved,response:"disagree",note:"Owner reply",requestId:randomUUID()});
    const independentReplies=(await readSettlement(tenant,lease,saved)).replies;assert.equal(independentReplies.length,2);
    assert.equal(independentReplies.filter(r=>r.actor_kind==="tenant" && r.response==="confirm").length,1);
    assert.equal(independentReplies.filter(r=>r.actor_kind==="owner" && r.response==="disagree").length,1);
    assert.equal(independentReplies.filter(r=>r.actor_kind==="staff").length,0);
    const report={leaseId:lease,versionId:saved,direction:"refund" as const,amountMinor:100,occurredOn:"2026-10-01",payeeId:USERS.tenant,payeeKind:"tenant" as const,evidenceId:evidenceId,requestId:randomUUID()};
    assert.equal((await settlementCommandStatus(staff,lease,saved,"outcome",report.requestId)).status,"unknown");
    const reportPair=await Promise.all([reportSettlementOutcome(staff,report),reportSettlementOutcome(staff,report)]); const firstOutcome=reportPair[0].id;
    assert.deepEqual(await settlementCommandStatus(staff,lease,saved,"outcome",report.requestId),{status:"recorded",id:firstOutcome});
    assert.equal(reportPair[1].id,firstOutcome);assert.equal(reportPair.filter(x=>x.recovered).length,1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.settlement_outcomes WHERE id=$1`,[firstOutcome])).rows[0].n,1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE event_type='settlement_outcome_reported' AND new_row->>'outcome_id'=$1`,[firstOutcome])).rows[0].n,1);
    assert.equal((await readSettlement(tenant,lease,saved)).stale,false);
    const ack={leaseId:lease,outcomeId:firstOutcome,event:"acknowledged" as const,note:"Received",evidenceId:null,expectedLastEventId:null,requestId:randomUUID()};
    await assert.rejects(replySettlementOutcome(staff,ack));
    const confirmed=await replySettlementOutcome(tenant,ack); assert.equal(confirmed.financialFresh,true);
    assert.equal((await replySettlementOutcome(tenant,ack)).id,confirmed.id);
    await assert.rejects(replySettlementOutcome(tenant,{...ack,expectedLastEventId:randomUUID()}));
    await assert.rejects(replySettlementOutcome(staff,{...ack,event:"withdrawn",note:"withdraw",expectedLastEventId:confirmed.id,requestId:randomUUID()}));
    const withdrawn=(await reportSettlementOutcome(staff,{...report,requestId:randomUUID(),amountMinor:100})).id;
    const withdrawal=await replySettlementOutcome(staff,{...ack,outcomeId:withdrawn,event:"withdrawn",note:"withdraw",requestId:randomUUID()});
    const replacement=(await reportSettlementOutcome(staff,{...report,requestId:randomUUID(),amountMinor:100})).id;
    await assert.rejects(replySettlementOutcome(tenant,{...ack,outcomeId:withdrawn,expectedLastEventId:withdrawal.id,requestId:randomUUID()}));
    await assert.rejects(replySettlementOutcome(tenant,{...ack,outcomeId:withdrawn,event:"disputed",expectedLastEventId:withdrawal.id,requestId:randomUUID()}));
    assert.equal((await readSettlement(tenant,lease,saved)).stale,false);
    const lateOutcome=(await reportSettlementOutcome(staff,{...report,requestId:randomUUID(),amountMinor:200})).id;
    const external=await observeExternalOutcome(staff,{leaseId:lease,versionId:saved,direction:"refund",amountMinor:50,occurredOn:"2026-10-01",payerId:owner.user_id,payerKind:"owner",payeeId:USERS.tenant,payeeKind:"tenant",evidenceId:ownerEvidence,reason:"Synthetic outside report",requestId:randomUUID()});
    const viewWithObservation=await readSettlement(tenant,lease,saved);assert.equal(viewWithObservation.stale,false);assert.equal(viewWithObservation.observations.length,1);
    await assert.rejects(reportSettlementOutcome(staff,{...report,requestId:randomUUID()}));
    const reconciliation={kind:"observation" as const,id:external.id,reason:"Reviewed separately",evidenceId};
    const reconciled=(await reportSettlementOutcome(staff,{...report,requestId:randomUUID(),reconciliations:[reconciliation]})).id;assert.ok(reconciled);

    await assert.rejects(reportSettlementOutcome(staff,{...report,requestId:randomUUID(),amountMinor:999999}));
    const remainingBeforeRace=preview.calculation.authoritative ? preview.calculation.refundMinor-500 : 0;
    const raceAmount=Math.floor(remainingBeforeRace/2)+1; assert.ok(raceAmount>0);
    const capped=await Promise.allSettled([reportSettlementOutcome(staff,{...report,requestId:randomUUID(),amountMinor:raceAmount,reconciliations:[reconciliation]}),reportSettlementOutcome(staff,{...report,requestId:randomUUID(),amountMinor:raceAmount,reconciliations:[reconciliation]})]);
    assert.equal(capped.filter(x=>x.status==="fulfilled").length,1);const winning=capped.find(x=>x.status==="fulfilled");assert.ok(winning && winning.status==="fulfilled");
    const revisedInput={...previewInput,items:[{...manualItem,amountMinor:1500,reason:"Synthetic correction"}]};
    const revisedPreview=await previewSettlement(staff,revisedInput);
    const revised=(await saveSettlement(staff,revisedInput,revisedPreview.fingerprint,nextDraft,randomUUID(),true)).id;
    const revisedView=await readSettlement(tenant,lease,revised); assert.equal(revisedView.replies.length,0);
    assert.equal(revisedView.stale,false);assert.equal(revisedView.items[0].original_minor,"1000");assert.equal(revisedView.items[0].prior_minor,"1000");assert.equal(revisedView.items[0].adjustment_minor,"500");
    await assert.rejects(reportSettlementOutcome(staff,{...report,versionId:revised,requestId:randomUUID()}));
    const allPrevious=[firstOutcome,withdrawn,replacement,lateOutcome,reconciled,winning.value.id].map(id=>({kind:"outcome" as const,id,reason:"Prior report reviewed",evidenceId}));
    const allReconciliation=[...allPrevious,reconciliation];
    const revisedReport=await reportSettlementOutcome(staff,{...report,versionId:revised,requestId:randomUUID(),reconciliations:allReconciliation});assert.ok(revisedReport.id);

    const disputed=await replySettlementOutcome(tenant,{...ack,outcomeId:lateOutcome,event:"disputed",note:"Review",requestId:randomUUID()});
    assert.equal(disputed.financialFresh,true);assert.equal((await readSettlement(tenant,lease,revised)).stale,true);

    assert.deepEqual(await counts(),financialBefore);



    // Old direct reversal first: it holds the ledger FK KEY SHARE; attribution
    // must fail immediately rather than invert ledger-first/payment locks.
    const p2=await recordPayment(staff,{leaseId:lease,amountMajor:100,paidOn:"2026-10-01",last5:"12345",reference:"synthetic two"});
    const ledger2=(await db.query<{id:string}>(`SELECT ledger_transaction_id AS id FROM payments WHERE id=$1`,[p2.paymentId])).rows[0].id;
    const oldWriter=new Client({connectionString:withDatabase(source,name)});await oldWriter.connect();await oldWriter.query("BEGIN");
    await oldWriter.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
    await oldWriter.query("SET LOCAL ROLE authenticated"); await oldWriter.query(`SELECT post_reversal($1,'Synthetic direct reversal')`,[ledger2]);
    const directInput={...input,requestId:randomUUID(),source:{kind:"payment" as const,paymentId:p2.paymentId}};
    await assert.rejects(setDepositAttribution(staff,directInput),(error:unknown)=>(error as {cause?:{code?:string}}).cause?.code === "55P03"); await oldWriter.query("COMMIT"); await oldWriter.end();
    assert.equal((await db.query(`SELECT status::text AS status FROM payments WHERE id=$1`,[p2.paymentId])).rows[0].status,"confirmed");
    await assert.rejects(setDepositAttribution(staff,directInput));
    // Attribution first: it pins the original ledger header. A real old
    // reversal waits on that header until the attribution transaction commits.
    const p3=await recordPayment(staff,{leaseId:lease,amountMajor:100,paidOn:"2026-10-01",last5:"12345",reference:"synthetic three"});
    const ledger3=(await db.query<{id:string}>(`SELECT ledger_transaction_id AS id FROM payments WHERE id=$1`,[p3.paymentId])).rows[0].id;
    const third={...input,requestId:randomUUID(),source:{kind:"payment" as const,paymentId:p3.paymentId}}; const thirdFirst=(await setDepositAttribution(staff,third)).id;
    const sourceId=(await db.query<{id:string}>(`SELECT id FROM app.settlement_sources WHERE payment_id=$1`,[p3.paymentId])).rows[0].id;
    const hold=new Client({connectionString:withDatabase(source,name)}); await hold.connect(); await hold.query("BEGIN"); await hold.query(`SELECT id FROM app.settlement_sources WHERE id=$1 FOR UPDATE`,[sourceId]);
    const attribution=setDepositAttribution(staff,{...third,requestId:randomUUID(),expectedAttributionId:thirdFirst,amountMinor:8000});
    let sourceWaiting=false;for(let n=0;n<40&&!sourceWaiting;n++){await new Promise(resolve=>setTimeout(resolve,25));sourceWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%settlement_sources%FOR UPDATE%') AS blocked`)).rows[0].blocked;} assert.ok(sourceWaiting);
    const reverse=new Client({connectionString:withDatabase(source,name)}); await reverse.connect(); await reverse.query("BEGIN");
    await reverse.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]); await reverse.query("SET LOCAL ROLE authenticated");
    const reversing=reverse.query(`SELECT post_reversal($1,'Synthetic later reversal')`,[ledger3]);
    let reversalWaiting=false;for(let n=0;n<40&&!reversalWaiting;n++){await new Promise(resolve=>setTimeout(resolve,25));reversalWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%SELECT post_reversal%') AS blocked`)).rows[0].blocked;} assert.ok(reversalWaiting);
    await hold.query("COMMIT"); await hold.end(); await attribution; await reversing; await reverse.query("COMMIT"); await reverse.end();
    await assert.rejects(setDepositAttribution(staff,{...third,requestId:randomUUID()}));
    await reversePayment(staff,payment.paymentId,"Synthetic reversal");
    assert.deepEqual(await setDepositAttribution(staff,input),{id:first,recovered:true,stale:true,current:false});
    await assert.rejects(setDepositAttribution(staff,{...input,expectedAttributionId:first}));
    assert.equal((await readSettlement(staff,lease,saved)).stale,true);
    const recoveredSave=await saveSettlement(staff,previewInput,preview.fingerprint,draft,saveId,true);
    assert.deepEqual(recoveredSave,{id:saved,recovered:true,stale:true,current:false,currentScope:"published"});
    await assert.rejects(saveSettlement(staff,{...previewInput,items:[{...manualItem,amountMinor:1001}]},preview.fingerprint,draft,saveId,true));
    await assert.rejects(saveSettlement(staff,previewInput,preview.fingerprint,null,saveId,true));
    const recoveredOutcome=await reportSettlementOutcome(staff,report);
    assert.deepEqual(recoveredOutcome,{id:firstOutcome,recovered:true,stale:true,current:false,currentScope:"published"});
    await assert.rejects(reportSettlementOutcome(staff,{...report,amountMinor:101}));

    const lateReply=await replySettlementOutcome(tenant,{...ack,outcomeId:lateOutcome,expectedLastEventId:disputed.id,requestId:randomUUID()});
    assert.equal(lateReply.financialFresh,false);
    assert.equal((await readSettlement(tenant,lease,saved)).stale,true);
    await assert.rejects(setDepositAttribution(staff,{...input,requestId:randomUUID()}));
    await db.query("BEGIN"); await db.query("SET LOCAL ROLE authenticated"); await assert.rejects(db.query(`SELECT * FROM app.settlement_attributions`)); await db.query("ROLLBACK");
    const dates=(await db.query<{start:string;end:string;move_out:string}>(`SELECT date_trunc('month',start_date)::date::text AS start,(date_trunc('month',start_date)+interval '1 month - 1 day')::date::text AS end,(date_trunc('month',start_date)+interval '15 days')::date::text AS move_out FROM leases WHERE id=$1`,[lease])).rows[0];
    const priorFlag=process.env.MOVE_OUT_NOTICE_ENABLED;process.env.MOVE_OUT_NOTICE_ENABLED="true";
    try {assert.deepEqual(await recordMoveOutNotice(db,{orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",leaseId:lease,actorUserId:USERS.admin,movedOutOn:dates.move_out,reason:"Synthetic move-out"}),{ok:true});}
    finally {if(priorFlag===undefined)delete process.env.MOVE_OUT_NOTICE_ENABLED;else process.env.MOVE_OUT_NOTICE_ENABLED=priorFlag;}
    const beforeQuote=await counts();
    const quote=await previewFinalRent(staff,{leaseId:lease,agreedPeriodStart:dates.start,agreedPeriodEnd:dates.end,evidenceId,fullPeriodAsserted:true});
    assert.equal(quote.quote.days,16);assert.equal(quote.reconciliationRequired,true);assert.ok(quote.priorCharges.some(c=>c.service_period===null));assert.deepEqual(await counts(),beforeQuote);
    await assert.rejects(previewFinalRent(staff,{leaseId:lease,agreedPeriodStart:dates.start,agreedPeriodEnd:dates.end,evidenceId,fullPeriodAsserted:false}));
    // The cycle is a scoped fixture; both category writers below use their real gateways.
    const externalSource=(await db.query<{id:string}>(`SELECT source_id AS id FROM app.settlement_attributions WHERE id=$1`,[correctedExternal.id])).rows[0].id;
    const cycleDates=(await db.query<{start:string;end:string}>(`UPDATE leases SET moved_out_on=(date_trunc('month',current_date)+interval '15 days')::date WHERE id=$1 RETURNING date_trunc('month',current_date)::date::text AS start,(date_trunc('month',current_date)+interval '1 month - 1 day')::date::text AS end`,[lease])).rows[0];
    const cycleRequest={leaseId:lease,periodStart:cycleDates.start,periodEnd:cycleDates.end,evidenceId,requestId:randomUUID(),fullPeriodAsserted:true as const};
    await assert.rejects(assertSettlementRentCycle(ownerIdentity,cycleRequest));
    const cyclePair=await Promise.all([assertSettlementRentCycle(staff,cycleRequest),assertSettlementRentCycle(staff,cycleRequest)]);
    const cycle=cyclePair[0].id;assert.equal(cyclePair[1].id,cycle);assert.equal(cyclePair.filter(x=>x.recovered).length,1);
    assert.equal((await assertSettlementRentCycle(staff,cycleRequest)).id,cycle);
    await db.query(`UPDATE leases SET moved_out_on=moved_out_on+1 WHERE id=$1`,[lease]);
    const staleCycle=await assertSettlementRentCycle(staff,cycleRequest);assert.equal(staleCycle.id,cycle);assert.equal(staleCycle.stale,true);
    await db.query(`UPDATE leases SET moved_out_on=moved_out_on-1 WHERE id=$1`,[lease]);
    await assert.rejects(assertSettlementRentCycle(staff,{...cycleRequest,evidenceId:randomUUID()}));
    const lineId=(await db.query<{id:string}>(`SELECT id FROM invoice_lines WHERE invoice_id=$1`,[invoice])).rows[0].id;
    const lineInput={leaseId:lease,lineId,classification:"rent" as const,cycleId:cycle,evidenceId,reason:"Synthetic line scope",expectedPriorId:null,requestId:randomUUID()};
    const rootLockHolder=new Client({connectionString:withDatabase(source,name)});await rootLockHolder.connect();await rootLockHolder.query("BEGIN");
    try {await rootLockHolder.query(`SELECT id FROM invoices WHERE id=$1 FOR UPDATE`,[invoice]);await db.query("BEGIN");await db.query("SET LOCAL ROLE service_role");
      await assert.rejects(db.query(`INSERT INTO app.settlement_line_roots(org_id,lease_id,invoice_line_id,created_by) VALUES($1,$2,$3,$4)`,[ORG_ID,lease,lineId,USERS.admin]),(error:unknown)=>(error as {code?:string}).code==="55P03");await db.query("ROLLBACK");
    } finally {await rootLockHolder.query("ROLLBACK");await rootLockHolder.end();}
    const otherLease=(await db.query<{id:string}>(`SELECT id FROM leases WHERE org_id=$1 LIMIT 1`,[ORG2_ID])).rows[0].id;
    await db.query("BEGIN");await db.query("SET LOCAL ROLE service_role");
    await assert.rejects(db.query(`INSERT INTO app.settlement_line_roots(org_id,lease_id,invoice_line_id,created_by) VALUES($1,$2,$3,$4)`,[ORG2_ID,otherLease,lineId,USERS.admin]),(error:unknown)=>(error as {code?:string}).code==="23503");
    await db.query("ROLLBACK");

    const sameOrgOther=(await db.query<{id:string}>(`SELECT id FROM leases WHERE org_id=$1 AND id<>$2 LIMIT 1`,[ORG_ID,lease])).rows[0].id;
    await db.query("BEGIN");await db.query("SET LOCAL ROLE service_role");
    await assert.rejects(db.query(`INSERT INTO app.settlement_line_roots(org_id,lease_id,invoice_line_id,created_by) VALUES($1,$2,$3,$4)`,[ORG_ID,sameOrgOther,lineId,USERS.admin]),(error:unknown)=>(error as {code?:string}).code==="23503");await db.query("ROLLBACK");
    await assert.rejects(bindSettlementLine(ownerIdentity,lineInput));
    const fingerprintBefore=(await previewSettlement(staff,{leaseId:lease,attributionIds:[],items:[]})).fingerprint;
    const binding=await bindSettlementLine(staff,lineInput);assert.equal((await bindSettlementLine(staff,lineInput)).id,binding.id);
    const bindingHolder=new Client({connectionString:withDatabase(source,name)});await bindingHolder.connect();await bindingHolder.query("BEGIN");
    try {await bindingHolder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`b011:rent-cycle:${ORG_ID}:${lease}`]);
      const busyBinding=await bindSettlementLine(staff,lineInput);assert.equal(busyBinding.id,binding.id);assert.equal(busyBinding.freshnessUnavailable,true);assert.equal(busyBinding.current,null);
    } finally {await bindingHolder.query("ROLLBACK");await bindingHolder.end();}

    const fingerprintAfter=(await previewSettlement(staff,{leaseId:lease,attributionIds:[],items:[]})).fingerprint;assert.notEqual(fingerprintAfter,fingerprintBefore);
    const latestVersion=(await db.query<{id:string}>(`SELECT v.id FROM app.settlement_versions v JOIN app.settlement_records r ON r.id=v.record_id WHERE r.org_id=$1 AND r.lease_id=$2 ORDER BY v.revision DESC LIMIT 1`,[ORG_ID,lease])).rows[0].id;
    const lineDraft=(await saveSettlement(staff,empty,fingerprintAfter,latestVersion,randomUUID(),false)).id;assert.equal((await readSettlement(staff,lease,lineDraft)).stale,false);
    const invoiceHolder=new Client({connectionString:withDatabase(source,name)});await invoiceHolder.connect();await invoiceHolder.query("BEGIN");
    try {await invoiceHolder.query(`SELECT id FROM invoices WHERE id=$1 FOR UPDATE`,[invoice]);
      const lockedView=await readSettlement(staff,lease,lineDraft);assert.equal(lockedView.freshnessUnavailable,true);assert.equal(lockedView.stale,false);assert.equal((lockedView.calculation as {authoritative:boolean}).authoritative,false);
    } finally {await invoiceHolder.query("ROLLBACK");await invoiceHolder.end();}


    const bindingRace=await Promise.allSettled([
      bindSettlementLine(staff,{...lineInput,classification:"unrelated",cycleId:null,expectedPriorId:binding.id,requestId:randomUUID()}),
      bindSettlementLine(staff,{...lineInput,expectedPriorId:binding.id,requestId:randomUUID()}),
    ]);assert.equal(bindingRace.filter(x=>x.status==="fulfilled").length,1);
    assert.notEqual((await previewSettlement(staff,{leaseId:lease,attributionIds:[],items:[]})).fingerprint,fingerprintAfter);assert.equal((await readSettlement(staff,lease,lineDraft)).stale,true);
    await assert.rejects(bindSettlementLine({...staff,orgId:ORG2_ID,liveOrgId:ORG2_ID},{...lineInput,requestId:randomUUID()}));
    const rentInput={...externalInput,cycleId:cycle,requestId:randomUUID(),amountMinor:18000,reason:"Synthetic rent attribution"};
    const rent=await setRentAttribution(staff,rentInput);assert.equal((await setRentAttribution(staff,rentInput)).id,rent.id);
    await db.query(`UPDATE leases SET moved_out_on=moved_out_on+1 WHERE id=$1`,[lease]);
    const staleRent=await setRentAttribution(staff,rentInput);assert.equal(staleRent.id,rent.id);assert.equal(staleRent.stale,true);
    await assert.rejects(setRentAttribution(staff,{...rentInput,requestId:randomUUID(),expectedAttributionId:rent.id,amountMinor:17000}));
    await db.query(`UPDATE leases SET moved_out_on=moved_out_on-1 WHERE id=$1`,[lease]);
    await assert.rejects(setDepositAttribution(staff,{...rentInput}));
    await assert.rejects(setDepositAttribution(staff,{...externalCorrection,requestId:randomUUID(),expectedAttributionId:correctedExternal.id,amountMinor:3000}));
    const concurrent=await Promise.allSettled([
      setDepositAttribution(staff,{...externalCorrection,requestId:randomUUID(),expectedAttributionId:correctedExternal.id,amountMinor:1800}),
      setRentAttribution(staff,{...rentInput,requestId:randomUUID(),expectedAttributionId:rent.id,amountMinor:18600}),
    ]);
    assert.equal(concurrent.filter(x=>x.status==="fulfilled").length,1);
    const usage=(await db.query<{total:string}>(`SELECT sum(a.amount_minor)::text total FROM app.settlement_allocation_roots r JOIN LATERAL (SELECT amount_minor FROM app.settlement_attributions WHERE root_id=r.id ORDER BY revision DESC LIMIT 1) a ON true WHERE r.source_id=$1`,[externalSource])).rows[0].total;
    assert.ok(Number(usage)<=20000);
    const sharedPayment=await recordPayment(staff,{leaseId:lease,amountMajor:100,paidOn:"2026-10-01",last5:"67890",reference:"Synthetic shared cap"});
    const sharedInput={leaseId:lease,evidenceId,expectedAttributionId:null,amountMinor:7000,reason:"Synthetic shared payment",source:{kind:"payment" as const,paymentId:sharedPayment.paymentId}};
    const internalRace=await Promise.allSettled([setDepositAttribution(staff,{...sharedInput,requestId:randomUUID()}),setRentAttribution(staff,{...sharedInput,cycleId:cycle,requestId:randomUUID()})]);
    assert.equal(internalRace.filter(x=>x.status==="fulfilled").length,1);
    const internalUsage=(await db.query<{total:string}>(`SELECT coalesce(sum(a.amount_minor),0)::text total FROM app.settlement_sources s JOIN app.settlement_allocation_roots r ON r.source_id=s.id JOIN LATERAL (SELECT amount_minor FROM app.settlement_attributions WHERE root_id=r.id ORDER BY revision DESC LIMIT 1) a ON true WHERE s.payment_id=$1`,[sharedPayment.paymentId])).rows[0].total;
    assert.ok(Number(internalUsage)<=10000);

    await assert.rejects(assertSettlementRentCycle(staff,{...cycleRequest,requestId:randomUUID()}));
    const rentSnapshotInput={leaseId:lease,attributionIds:[],items:[]};const financialBeforeRentDraft=await counts();
    const rentPreview=await previewSettlement(staff,rentSnapshotInput);assert.equal(rentPreview.calculation.authoritative,false);assert.equal(rentPreview.rentSourceCoverage,"unverified");assert.ok(rentPreview.candidateLines.some(l=>l.id===lineId));assert.ok(rentPreview.rentAttrs.some(a=>a.cycle_id===cycle));
    await assert.rejects(saveSettlement(staff,rentSnapshotInput,rentPreview.fingerprint,lineDraft,randomUUID(),true));
    const rentDraft=(await saveSettlement(staff,rentSnapshotInput,rentPreview.fingerprint,lineDraft,randomUUID(),false)).id;
    const rentView=await readSettlement(staff,lease,rentDraft);assert.equal(rentView.rentSources?.coverage,"unverified");assert.ok(rentView.rentSources?.lines.some(l=>l.description==="Synthetic rent"));assert.ok(rentView.rentSources?.cash.length);assert.equal(rentView.stale,false);assert.deepEqual(await counts(),financialBeforeRentDraft);



    // Exercise the complete foreign-key reset order using actual new private
    // table rows; these synthetic rows are only a reset fixture, not business evidence.
    const record=(await db.query<{id:string}>(`SELECT id FROM app.settlement_records WHERE org_id=$1 AND lease_id=$2`,[ORG_ID,lease])).rows[0].id;
    const snapshot=(await db.query<{id:string}>(`INSERT INTO app.settlement_versions(org_id,lease_id,record_id,revision,published,snapshot,source_fingerprint,created_by,request_id) VALUES($1,$2,$3,(SELECT coalesce(max(revision),0)+1 FROM app.settlement_versions WHERE record_id=$3),true,'{}',$4,$5,$6) RETURNING id`,[ORG_ID,lease,record,"a".repeat(64),USERS.admin,randomUUID()])).rows[0].id;
    await db.query(`INSERT INTO app.settlement_version_attributions(org_id,lease_id,version_id,attribution_id) VALUES($1,$2,$3,$4)`,[ORG_ID,lease,snapshot,first]);
    await db.query(`INSERT INTO app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id,linked_by) VALUES($1,$2,$3,$4,$5)`,[ORG_ID,lease,snapshot,evidenceId,USERS.admin]);
    const item=(await db.query<{id:string}>(`INSERT INTO app.settlement_items(org_id,lease_id,version_id,item_key,label,original_minor,amount_minor,reason,evidence_id,created_by) VALUES($1,$2,$3,$4,'Synthetic',100,100,'Synthetic',$5,$6) RETURNING id`,[ORG_ID,lease,snapshot,randomUUID(),evidenceId,USERS.admin])).rows[0].id;
    assert.ok(item);
    await db.query(`INSERT INTO app.settlement_replies(org_id,lease_id,version_id,actor_id,actor_kind,response,note,request_id) VALUES($1,$2,$3,$4,'tenant','disagree','', $5)`,[ORG_ID,lease,snapshot,USERS.tenant,randomUUID()]);
    const outcome=(await db.query<{id:string}>(`INSERT INTO app.settlement_outcomes(org_id,lease_id,version_id,direction,amount_minor,currency,occurred_on,payer_id,payer_kind,payee_id,payee_kind,reporter_id,evidence_id,request_id) VALUES($1,$2,$3,'refund',100,'TWD',current_date,$4,'staff',$5,'tenant',$4,$6,$7) RETURNING id`,[ORG_ID,lease,snapshot,USERS.admin,USERS.tenant,evidenceId,randomUUID()])).rows[0].id;
    await db.query(`INSERT INTO app.settlement_outcome_events(org_id,lease_id,outcome_id,actor_id,revision,event,note,request_id) VALUES($1,$2,$3,$4,1,'disputed','',$5)`,[ORG_ID,lease,outcome,USERS.tenant,randomUUID()]);
    const path=(await db.query<{storage_path:string}>(`SELECT storage_path FROM app.handover_upload_intents WHERE id=$1`,[intent.intentId])).rows[0].storage_path;
    await db.query("BEGIN"); await captureSettlementBeforeDemoReset(db); await captureHandoverBeforeDemoReset(db); await db.query("COMMIT");
    for(const table of ["settlement_outcome_events","settlement_outcome_reconciliations","settlement_external_observations","settlement_outcomes","settlement_replies","settlement_items","settlement_version_attributions","settlement_versions","settlement_attributions","settlement_allocation_roots","settlement_line_bindings","settlement_line_roots","settlement_rent_cycles","settlement_sources","settlement_records"]) assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n),0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.handover_gc_tombstones WHERE storage_path IN ($1,$2)`,[path,`${path}/sealed`])).rows[0].n,2);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.settlement_gc_tombstones WHERE storage_path IN ($1,$2)`,[settlementPath,`${settlementPath}/sealed`])).rows[0].n,2);
    assert.equal(objects.has(sealedKey),true); await reconcileSettlementDemoObjects(db,100); assert.equal(objects.has(sealedKey),false);
    objects.set(sealedKey,Buffer.from(bytes)); // a very late upstream write after an apparently successful delete
    await reconcileSettlementDemoObjects(db,100); assert.equal(objects.has(sealedKey),false);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.settlement_gc_tombstones WHERE storage_path IN ($1,$2)`,[settlementPath,`${settlementPath}/sealed`])).rows[0].n,2);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.settlement_gc_attempts a JOIN app.settlement_gc_tombstones t ON t.id=a.tombstone_id WHERE t.storage_path=$1`,[`${settlementPath}/sealed`])).rows[0].n,2);

  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}
});
