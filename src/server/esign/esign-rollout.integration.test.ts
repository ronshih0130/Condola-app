import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svcOn } from "../db";
import { ORG_ID, ORG2_ID, USERS } from "../ids";
import { disposableDbUrl } from "../test-disposable-db";
import { buildStoredConsent } from "../consent";
import type { Session } from "../types";
import { EsignUnavailable, esignAvailableFor } from "./access";
import { EsignFlow } from "./flow";
import { EsignRepo } from "./repo";
import { lockSigningLeaseForCreate } from "./lock";

const url = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
const admin: Session = {userId:USERS.admin,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",sessionId:randomUUID(),kind:"staff",
  role:"admin",locale:"en",calendar:"gregorian",leaseId:null,email:"",name:"Synthetic",consent:buildStoredConsent("reconsent")};

test("org rollout gates all personas, direct repo and a disable waiting on organization lock", async () => {
  const setup=new Client({connectionString:url}), blocker=new Client({connectionString:url}), waiter=new Client({connectionString:url});
  await Promise.all([setup.connect(),blocker.connect(),waiter.connect()]);
  const prior=process.env.ESIGN_ENABLED;
  const original=(await setup.query<{id:string;feature_flags:unknown}>(`SELECT id::text,feature_flags FROM organizations WHERE id=ANY($1::uuid[])`,[[ORG_ID,ORG2_ID]])).rows;
  const caseId=randomUUID(), versionId=randomUUID();
  try {
    await setup.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[admin.sessionId,admin.userId,randomUUID()]);
    const lease=(await setup.query<{id:string}>(`SELECT l.id::text FROM leases l JOIN properties p ON p.org_id=l.org_id AND p.id=l.property_id JOIN units u ON u.org_id=l.org_id AND u.id=l.unit_id LEFT JOIN rooms r ON r.org_id=l.org_id AND r.id=l.target_room_id WHERE l.org_id=$1 AND l.status='active' AND p.archived_at IS NULL AND u.archived_at IS NULL AND (l.target_room_id IS NULL OR r.archived_at IS NULL) ORDER BY l.created_at, l.id LIMIT 1`,[ORG_ID])).rows[0].id;
    const command={type:"create" as const,leaseId:lease,pdf:new Uint8Array(),ownerId:USERS.owner,tenantId:USERS.tenant,
      ownerDocument:false,tenantDocument:false,order:"parallel" as const,deadline:""};
    const repo=new EsignRepo({check:async()=>true});
    const create={caseId,leaseId:lease,versionId,body:"Synthetic",pdfBytes:new TextEncoder().encode("%PDF-1.7"),signers:[]};
    const flow=new EsignFlow({enabled:()=>true,mail:async()=>{throw new Error("mail must not be called");}});
    process.env.ESIGN_ENABLED="false";
    await setup.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    assert.equal(await esignAvailableFor(admin),false);
    await assert.rejects(repo.createCase(admin,create),EsignUnavailable);
    process.env.ESIGN_ENABLED="true";
    for (const value of [null,false,"true",1]) {
      await setup.query(`UPDATE organizations SET feature_flags=CASE WHEN $2::jsonb IS NULL THEN feature_flags-'esign' ELSE jsonb_set(feature_flags,'{esign}',$2::jsonb,true) END WHERE id=$1`,[ORG_ID,value===null?null:JSON.stringify(value)]);
      assert.equal(await esignAvailableFor(admin),false);
      for (const persona of [admin,{...admin,userId:USERS.manager,role:"manager" as const},
        {...admin,userId:USERS.tenant,kind:"tenant" as const,role:null},{...admin,userId:USERS.owner,kind:"owner" as const,role:null}]) {
        await assert.rejects(flow.list(persona,lease),EsignUnavailable);
        await assert.rejects(flow.pdf(persona,caseId,versionId,false),EsignUnavailable);
      }
      await assert.rejects(flow.execute(admin,command),EsignUnavailable);
      await assert.rejects(repo.createCase(admin,create),EsignUnavailable);
      await assert.rejects(repo.finalize(admin,caseId,versionId),EsignUnavailable);
      await assert.rejects(repo.addSigner(admin,caseId,versionId,{id:USERS.owner,role:"owner",email:"owner@example.com"}),EsignUnavailable);
      await assert.rejects(repo.apply(admin,caseId,{type:"void",versionId,reason:"Synthetic",at:"2026-10-29T00:00:00Z"}),EsignUnavailable);
      await assert.rejects(repo.recordEmailStep(admin,caseId,{versionId,signerId:admin.userId,at:"2026-10-29T00:00:00Z",response:"synthetic"}),EsignUnavailable);
      await assert.rejects(repo.recordSignature(admin,caseId,{versionId,signerId:admin.userId,at:"2026-10-29T00:00:00Z",
        strokes:[],documentDigest:"",ip:"127.0.0.1",device:"synthetic",userAgent:"synthetic",imageBytes:new Uint8Array()}),EsignUnavailable);
      await assert.rejects(repo.supersede(admin,caseId,{previousVersionId:versionId,newVersionId:randomUUID(),body:"Synthetic",
        pdfBytes:new Uint8Array(),at:"2026-10-29T00:00:00Z"}),EsignUnavailable);
      assert.equal((await setup.query("SELECT 1 FROM esign_cases WHERE id=$1",[caseId])).rowCount,0);
    }
    await setup.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await setup.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":false}'::jsonb WHERE id=$1`,[ORG2_ID]);
    assert.equal(await esignAvailableFor(admin),true);
    assert.equal(await esignAvailableFor({...admin,userId:USERS.coastAdmin,orgId:ORG2_ID,liveOrgId:ORG2_ID}),false);
    assert.equal(await esignAvailableFor({...admin,environment:"sandbox"}),false);
    const waitPid=(await waiter.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await blocker.query("BEGIN");
    await blocker.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":false}'::jsonb WHERE id=$1`,[ORG_ID]);
    const waiting=new EsignFlow({enabled:()=>true,run:(actor,work)=>svcOn(waiter,actor,work),
      mail:async()=>{throw new Error("mail must not be called");}}).execute(admin,command);
    const rejection=assert.rejects(waiting,EsignUnavailable);
    let blocked=false;
    for(let n=0;n<100;n++) {
      const row=(await setup.query<{blocked:boolean}>(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`,[waitPid])).rows[0];
      if(row.blocked) {blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(blocked,true,"disable must block the signing operation before lease/case locks");
    await blocker.query("COMMIT");
    await rejection;
    assert.equal((await setup.query("SELECT 1 FROM esign_cases WHERE id=$1",[caseId])).rowCount,0);
    await setup.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    let release!: () => void, ready!: () => void;
    const held=new Promise<void>(resolve=>{ready=resolve;});
    const proceed=new Promise<void>(resolve=>{release=resolve;});
    const writing=svcOn(waiter,admin.userId,async c=>{
      await lockSigningLeaseForCreate(c,admin,lease);
      ready();
      await proceed;
    });
    await held;
    const blockerPid=(await blocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const disabling=blocker.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":false}'::jsonb WHERE id=$1`,[ORG_ID]);
    blocked=false;
    for(let n=0;n<100;n++) {
      if((await setup.query<{blocked:boolean}>(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`,[blockerPid])).rows[0].blocked) {blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    release();
    await writing;
    await disabling;
    assert.equal(blocked,true,"an in-flight writer must finish before disabling the organization");
  } finally {
    await blocker.query("ROLLBACK").catch(()=>{});
    await setup.query(`DELETE FROM auth_sessions WHERE id=$1`,[admin.sessionId]);
    for(const row of original) await setup.query("UPDATE organizations SET feature_flags=$2 WHERE id=$1",[row.id,row.feature_flags]);
    if(prior===undefined) delete process.env.ESIGN_ENABLED; else process.env.ESIGN_ENABLED=prior;
    await Promise.all([setup.end(),blocker.end(),waiter.end()]);
  }
});
