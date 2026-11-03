import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { disposableDbUrl } from "./test-disposable-db";
import { cloneTestDatabase } from "./test-database-clone";
import { ORG_ID, USERS } from "./ids";
import { createLease, createProperty, signLease, updateLease, uploadSignedLeasePdf } from "./domain";
import { query, svc, withClient } from "./db";
import { insertTestAuthSession } from "./test-auth-session";
import { EsignRepo, type TransactionRunner } from "./esign/repo";
import { lockSigningCase } from "./esign/lock";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let priorOrgEsign: { present: boolean; value: unknown } | undefined;
test.before(async () => {
  clone = await cloneTestDatabase();
  await withClient(async c=>{staff.sessionId=await insertTestAuthSession(c,USERS.admin);ownerSessionId=await insertTestAuthSession(c,USERS.owner);managerSessionId=await insertTestAuthSession(c,USERS.manager);});
  const row = (await query<{ present: boolean; value: unknown }>(`SELECT feature_flags ? 'esign' AS present, feature_flags->'esign' AS value FROM organizations WHERE id=$1`, [ORG_ID])).rows[0];
  priorOrgEsign = row;
});
test.after(async () => { await clone?.cleanup(); });
const priorEsignSwitch = process.env.ESIGN_ENABLED;
async function enableSigningFixture() {
  process.env.ESIGN_ENABLED = "true";
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":true}'::jsonb WHERE id=$1`, [ORG_ID]);
}
test.afterEach(async () => {
  if (priorEsignSwitch === undefined) delete process.env.ESIGN_ENABLED;
  else process.env.ESIGN_ENABLED = priorEsignSwitch;
  if (!priorOrgEsign) return;
  await query(`UPDATE organizations SET feature_flags=CASE WHEN $2 THEN jsonb_set(feature_flags,'{esign}',$3::jsonb) ELSE feature_flags - 'esign' END WHERE id=$1`, [ORG_ID, priorOrgEsign.present, JSON.stringify(priorOrgEsign.value)]);
});
const staff: Session = { userId: USERS.admin, sessionId: "b008-fixture", email: "staff@example.com", name: "Staff", kind: "staff", role: "admin", orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
let ownerSessionId:string,managerSessionId:string;

async function waitForBlockingEdge(waiter: number, blocker: number) {
  const deadline=Date.now()+5000;
  while (Date.now()<deadline) {
    const result=await query<{blocked:boolean}>(`SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked`,[waiter,blocker]);
    if (result.rows[0]?.blocked) return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail("Expected transaction did not wait on the holder's database lock");
}

function observedRepo() {
  let report!: (pid:number)=>void;
  const pid=new Promise<number>(resolve=>{report=resolve;});
  const runner: TransactionRunner=(actor,work)=>svc(actor,async client=>{
    report((await client.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    return work(client);
  });
  return {repo:new EsignRepo({check:async()=>true},runner),pid};
}

async function identityReady(leaseId: string) {
  const party = (await query<{contact_id:string}>(`SELECT contact_id::text FROM lease_parties WHERE lease_id=$1 AND role='primary'`, [leaseId])).rows[0];
  const doc = (await query<{id:string}>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES ($1,$2,$3,'passport','A**789',$4,'fixture-key-ref','pending_review',$5) RETURNING id::text`, [ORG_ID, party.contact_id, leaseId, `${ORG_ID}/${leaseId}/fixture-doc`, USERS.admin])).rows[0].id;
  for (const slot of ["front", "selfie"]) await query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES ($1,$2,$3,$4,'image/jpeg',4,'abc')`, [ORG_ID, doc, slot, `${ORG_ID}/${leaseId}/${slot}`]);
}

test("captured first period survives flag off and is used by tenant-final signing", async () => {
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`, [ORG_ID]);
  const property = await createProperty(staff, { name: "B008 fixture", city: "Sunnyvale", district: "", street: "Fixture 1", currency: "USD", ownerMode: "new", ownerName: "Fixture owner", ownerPhone: "0912000111", ownerEmail: "b008-owner@example.com", canViewTenantPhone: false, unitLabel: "A", floor: "1", rentalMode: "by_room", rooms: [{ label: "A", roomType: "suite", baseRentMajor: 300 }, {label:"B",roomType:"suite",baseRentMajor:300}, {label:"C",roomType:"suite",baseRentMajor:300}] });
  const lease = await createLease(staff, { roomId: property.roomIds[0], tenantName: "B008 tenant", tenantPhone: "0912000222", tenantEmail: "b008-tenant@example.com", lineUserId: "", startDate: "2026-12-16", endDate: "2027-11-30", rentMajor: 300, depositMonths: 2, depositReason: "", dueDay: 5, splitMethod: "even", periodStart: "2026-12-01", periodEnd: "2026-12-31", billTotalMajor: null, usageKwh: null, rateMajor: null, rateSource: "bill_average", overrideReason: "", subUsages: [], firstPeriodProrate: true });
  const source = await query<{ basis: { monthlyRentMinor: number; actor: string; prorateFirstPeriod: boolean } }>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`, [lease.leaseId]);
  assert.equal(source.rows[0].basis.monthlyRentMinor, 30000);
  assert.equal(source.rows[0].basis.actor, USERS.admin);
  assert.equal(source.rows[0].basis.prorateFirstPeriod, true);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [USERS.admin, ORG_ID]);
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SAVEPOINT denied");
    await assert.rejects(() => client.query(`SELECT app.b008_capture_first_period($1,false)`, [lease.leaseId]), (error: unknown) => (error as {code?: string}).code === "42501");
    await client.query("ROLLBACK TO SAVEPOINT denied");
    await assert.rejects(() => client.query(`UPDATE leases SET rent_amount_minor=100 WHERE id=$1`, [lease.leaseId]), (error: unknown) => (error as {code?: string}).code === "42501");
    await client.query("ROLLBACK TO SAVEPOINT denied");
    await assert.rejects(() => client.query(`UPDATE leases SET end_date='2026-12-20' WHERE id=$1`, [lease.leaseId]), (error: unknown) => (error as {code?: string}).code === "42501");
    await client.query("ROLLBACK TO SAVEPOINT denied");
    await assert.rejects(() => client.query(`UPDATE leases SET first_period_basis=jsonb_set(first_period_basis,'{actor}',to_jsonb($2::text)) WHERE id=$1`, [lease.leaseId, USERS.manager]), (error: unknown) => (error as {code?: string}).code === "42501");
    await client.query("ROLLBACK TO SAVEPOINT denied");
    await assert.rejects(() => client.query(`UPDATE leases SET first_period_basis=jsonb_set(first_period_basis,'{capturedAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1`, [lease.leaseId]), (error: unknown) => (error as {code?: string}).code === "42501");
    await client.query("ROLLBACK TO SAVEPOINT denied");
    await client.query("SET LOCAL ROLE service_role");
    await assert.rejects(() => client.query(`SELECT app.b008_capture_first_period($1,false)`, [lease.leaseId]), (error: unknown) => (error as {code?: string}).code === "42501");
    await client.query("ROLLBACK TO SAVEPOINT denied");
    await client.query("SET LOCAL ROLE service_role");
    await assert.rejects(() => client.query(`UPDATE leases SET first_period_basis=NULL WHERE id=$1`, [lease.leaseId]), (error: unknown) => (error as {code?: string}).code === "42501");
    await client.query("ROLLBACK TO SAVEPOINT denied");
    await client.query("SET LOCAL ROLE service_role");
    await assert.rejects(() => client.query(`UPDATE leases SET end_date='2026-12-20' WHERE id=$1`, [lease.leaseId]), (error: unknown) => (error as {code?: string}).code === "42501");
    await client.query("ROLLBACK");
  } finally { await client.end(); }
  await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
  const version = (await query<{updated_at:string}>(`SELECT updated_at::text FROM leases WHERE id=$1`, [lease.leaseId])).rows[0].updated_at;
  await updateLease(staff, {leaseId:lease.leaseId,rentMajor:330,depositMonths:2,depositReason:"",updatedAt:version});
  const refreshed = (await query<{basis:{monthlyRentMinor:number;prorateFirstPeriod:boolean}}>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`, [lease.leaseId])).rows[0].basis;
  assert.equal(refreshed.monthlyRentMinor,33000);
  assert.equal(refreshed.prorateFirstPeriod,true);
  // Simulate a stale pre-guard writer using the explicitly trusted owner.
  // Both activation paths must reject before any signature or invoice write.
  await query(`UPDATE leases SET end_date='2026-12-20' WHERE id=$1`,[lease.leaseId]);
  await assert.rejects(() => signLease(staff,{leaseId:lease.leaseId,signedName:"Staff",consent:true}), (error:unknown) => (error as {key?:string}).key === "errors.staleLease");
  await assert.rejects(() => uploadSignedLeasePdf(staff,lease.leaseId,{bytes:Buffer.from("%PDF-1.4\nfixture\n%%EOF\n"),fileName:"signed.pdf"}), (error:unknown) => (error as {key?:string}).key === "errors.staleLease");
  const untouched=await query<{signatures:string;invoices:string}>(`SELECT (SELECT count(*) FROM lease_signatures WHERE lease_id=$1 AND status='signed')::text AS signatures,(SELECT count(*) FROM invoices WHERE lease_id=$1 AND source='move_in')::text AS invoices`,[lease.leaseId]);
  assert.deepEqual(untouched.rows[0],{signatures:"0",invoices:"0"});
  await query(`UPDATE leases SET end_date='2027-11-30' WHERE id=$1`,[lease.leaseId]);
  await identityReady(lease.leaseId);
  assert.equal((await signLease(staff, {leaseId:lease.leaseId,signedName:"Staff",consent:true})).esign, "partially_signed");
  const tenant: Session = {...staff, sessionId:await withClient(c=>insertTestAuthSession(c,lease.tenantUserId)), userId:lease.tenantUserId, kind:"tenant", role:null};
  const result = await signLease(tenant, {leaseId:lease.leaseId,signedName:"Tenant",consent:true});
  assert.equal(result.esign, "fully_signed");
  const rent = await query<{amount:string}>(`SELECT amount_minor::text AS amount FROM invoice_lines WHERE invoice_id=$1 AND charge_type='rent'`, [result.invoiceId]);
  assert.equal(rent.rows[0].amount, "17600");
  const signedPeriod=await query<{start:string;end:string}>(`SELECT period_start::text AS start,period_end::text AS end FROM invoices WHERE id=$1`,[result.invoiceId]);
  assert.deepEqual(signedPeriod.rows[0],{start:"2026-12-16",end:"2026-12-31"});
  const beforeLifecycle=(await query<{basis:unknown}>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`,[lease.leaseId])).rows[0].basis;
  await query(`UPDATE leases SET end_date='2027-10-01' WHERE id=$1`,[lease.leaseId]);
  const afterLifecycle=(await query<{basis:unknown}>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`,[lease.leaseId])).rows[0].basis;
  assert.deepEqual(afterLifecycle,beforeLifecycle);

  const input = { tenantName: "Paper tenant", tenantPhone: "0912000444", tenantEmail: "paper-first@example.com", lineUserId: "", startDate: "2026-12-16", endDate: "2027-11-30", rentMajor: 300, depositMonths: 2, depositReason: "", dueDay: 5, splitMethod: "even" as const, periodStart: "2026-12-01", periodEnd: "2026-12-31", billTotalMajor: null, usageKwh: null, rateMajor: null, rateSource: "bill_average" as const, overrideReason: "", subUsages: [] };
  // The historic boolean can be true without establishing a new basis.
  const legacy = await createLease(staff,{...input,roomId:property.roomIds[1]});
  await query(`UPDATE leases SET prorate_first_period=true WHERE id=$1`, [legacy.leaseId]);
  await identityReady(legacy.leaseId);
  const legacyPaper = await uploadSignedLeasePdf(staff,legacy.leaseId,{bytes:Buffer.from("%PDF-1.4\nfixture\n%%EOF\n"),fileName:"signed.pdf"});
  const legacyRent = await query<{amount:string}>(`SELECT amount_minor::text AS amount FROM invoice_lines WHERE invoice_id=$1 AND charge_type='rent'`, [legacyPaper.invoiceId]);
  assert.equal(legacyRent.rows[0].amount,"30000");
  const legacyPeriod=await query<{start:string;end:string}>(`SELECT period_start::text AS start,period_end::text AS end FROM invoices WHERE id=$1`,[legacyPaper.invoiceId]);
  assert.deepEqual(legacyPeriod.rows[0],{start:"2026-12-16",end:"2027-11-30"});

  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`, [ORG_ID]);
  const paper = await createLease(staff,{...input,roomId:property.roomIds[2],tenantEmail:"paper-second@example.com",firstPeriodProrate:true});
  await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
  await identityReady(paper.leaseId);
  const activated = await uploadSignedLeasePdf(staff,paper.leaseId,{bytes:Buffer.from("%PDF-1.4\nfixture\n%%EOF\n"),fileName:"signed.pdf"});
  const paperRent = await query<{amount:string}>(`SELECT amount_minor::text AS amount FROM invoice_lines WHERE invoice_id=$1 AND charge_type='rent'`, [activated.invoiceId]);
  assert.equal(paperRent.rows[0].amount,"16000");
  const paperPeriod=await query<{start:string;end:string}>(`SELECT period_start::text AS start,period_end::text AS end FROM invoices WHERE id=$1`,[activated.invoiceId]);
  assert.deepEqual(paperPeriod.rows[0],{start:"2026-12-16",end:"2026-12-31"});
});

test("a concurrent B001 signature wins before a waiting basis capture", async () => {
  await enableSigningFixture();
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`, [ORG_ID]);
  const property = (await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES ($1,'B008 race','US','USD','America/Los_Angeles','whole_unit') RETURNING id::text`,[ORG_ID])).rows[0].id;
  const unit = (await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'race','whole_unit') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
  const lease = (await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor) VALUES ($1,$2,$3,$3,'draft','2026-12-16','2027-11-30','USD',30000,0) RETURNING id::text`,[ORG_ID,property,unit])).rows[0].id;
  const caseId=randomUUID(), versionId=randomUUID();
  const admin={userId:USERS.admin,sessionId:staff.sessionId,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",kind:"staff",role:"admin"} as const, owner={userId:USERS.owner,sessionId:ownerSessionId,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",kind:"owner",role:null} as const;
  const repo=new EsignRepo({check:async () => true});
  const state=await repo.createCase(admin,{caseId,leaseId:lease,versionId,body:"Synthetic",pdfBytes:Buffer.from("%PDF-1.7 fixture"),signers:[{id:USERS.owner,role:"owner",email:"owner@example.com"},{id:USERS.tenant,role:"tenant",email:"tenant@example.com"}]});
  const at="2026-10-26T12:00:00.000Z", expiry="2026-10-27T12:00:00.000Z";
  await repo.apply(admin,caseId,{type:"send",versionId,at,presumedConsentDeadline:expiry,termsVersion:"fixture"});
  await repo.apply(owner,caseId,{type:"consent",versionId,signerId:owner.userId,kind:"explicit",at});
  await repo.apply(owner,caseId,{type:"issue_identity",versionId,signerId:owner.userId,method:"email",expiresAt:expiry,attemptCap:3,at});
  await repo.recordEmailStep(owner,caseId,{versionId,signerId:owner.userId,response:"fixture",at});
  await repo.apply(owner,caseId,{type:"review",versionId,signerId:owner.userId,scrolledToEnd:true,at});
  let release!: () => void, locked!: () => void;
  const held=new Promise<void>((resolve)=>{locked=resolve;}), proceed=new Promise<void>((resolve)=>{release=resolve;});
  let signingPid=0;
  const runner: TransactionRunner = (actor, work) => svc(actor, async (client) => { signingPid=(await client.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid; const result=await work(client); locked(); await proceed; return result; });
  const signingRepo=new EsignRepo({check:async () => true},runner);
  const signing=signingRepo.recordSignature(owner,caseId,{versionId,signerId:owner.userId,at,strokes:[[{x:0,y:0},{x:8,y:12},{x:20,y:4}]],imageBytes:Uint8Array.of(137,80,78,71,13,10,26,10,1),documentDigest:state.versions[0].documentDigest,ip:"127.0.0.1",device:"fixture",userAgent:"fixture"});
  const client=new Client({connectionString:process.env.DATABASE_URL});
  try {
    await held;
    await client.connect(); await client.query("BEGIN");
    const capturePid=(await client.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
    const before=(await query<{count:string}>(`SELECT count(*)::text AS count FROM audit_log WHERE table_name='leases' AND row_id=$1`,[lease])).rows[0].count;
    const capture=client.query(`SELECT app.b008_capture_first_period($1,true)`,[lease]);
    const outcome=capture.then(()=>"resolved",(error: {code?:string})=>error.code ?? "rejected");
    await waitForBlockingEdge(capturePid,signingPid);
    release(); await signing;
    assert.equal(await outcome,"23514");
    await client.query("ROLLBACK");
    const result=await query<{basis:unknown}>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`,[lease]);
    assert.equal(result.rows[0].basis,null);
    const after=(await query<{count:string}>(`SELECT count(*)::text AS count FROM audit_log WHERE table_name='leases' AND row_id=$1`,[lease])).rows[0].count;
    assert.equal(after,before);
  } finally { release(); await signing.catch(()=>{}); await client.end(); }
});

test("capturing first fences B001 signing and concurrent case creation", async () => {
  await enableSigningFixture();
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`, [ORG_ID]);
  const property = (await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES ($1,'B008 capture first','US','USD','America/Los_Angeles','whole_unit') RETURNING id::text`,[ORG_ID])).rows[0].id;
  async function draft() {
    const unit=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,$3,'whole_unit') RETURNING id::text`,[ORG_ID,property,randomUUID()])).rows[0].id;
    return (await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor) VALUES ($1,$2,$3,$3,'draft','2026-12-16','2027-11-30','USD',30000,0) RETURNING id::text`,[ORG_ID,property,unit])).rows[0].id;
  }
  const admin={userId:USERS.admin,sessionId:staff.sessionId,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",kind:"staff",role:"admin"} as const, owner={userId:USERS.owner,sessionId:ownerSessionId,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",kind:"owner",role:null} as const;
  const repo=new EsignRepo({check:async () => true});
  const caseInput = (leaseId:string) => ({caseId:randomUUID(),leaseId,versionId:randomUUID(),body:"Synthetic",pdfBytes:Buffer.from("%PDF-1.7 fixture"),signers:[{id:USERS.owner,role:"owner" as const,email:"owner@example.com"},{id:USERS.tenant,role:"tenant" as const,email:"tenant@example.com"}]});
  const lease=await draft(), item=caseInput(lease), state=await repo.createCase(admin,item);
  const at="2026-10-26T12:00:00.000Z", expiry="2026-10-27T12:00:00.000Z", versionId=item.versionId;
  await repo.apply(admin,item.caseId,{type:"send",versionId,at,presumedConsentDeadline:expiry,termsVersion:"fixture"});
  await repo.apply(owner,item.caseId,{type:"consent",versionId,signerId:owner.userId,kind:"explicit",at});
  await repo.apply(owner,item.caseId,{type:"issue_identity",versionId,signerId:owner.userId,method:"email",expiresAt:expiry,attemptCap:3,at});
  await repo.recordEmailStep(owner,item.caseId,{versionId,signerId:owner.userId,response:"fixture",at});
  await repo.apply(owner,item.caseId,{type:"review",versionId,signerId:owner.userId,scrolledToEnd:true,at});
  const client=new Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  try {
    await client.query("BEGIN");
    const capturePid=(await client.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
    await client.query(`SELECT app.b008_capture_first_period($1,true)`,[lease]);
    const direct = new Client({connectionString:process.env.DATABASE_URL});
    await direct.connect();
    try {
      await direct.query("BEGIN");
      await assert.rejects(direct.query(`UPDATE esign_versions SET state=state WHERE id=$1`,[versionId]), (error:unknown) => (error as {code?:string}).code === "55P03");
      await direct.query("ROLLBACK");
    } finally { await direct.end(); }
    const managerClient=new Client({connectionString:process.env.DATABASE_URL});
    await managerClient.connect();
    await managerClient.query("BEGIN");
    await managerClient.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]);
    await managerClient.query("SET LOCAL ROLE service_role");
    const managerPid=(await managerClient.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const manager={userId:USERS.manager,sessionId:managerSessionId,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",kind:"staff",role:"manager"} as const;
    const managerAction=lockSigningCase(managerClient,manager,item.caseId,versionId);
    const managerOutcome=managerAction.then(()=>"resolved",(error:Error)=>error.message);
    await waitForBlockingEdge(managerPid,capturePid);
    await query(`UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);
    const observedSigning=observedRepo();
    const signing=observedSigning.repo.recordSignature(owner,item.caseId,{versionId,signerId:owner.userId,at,strokes:[[{x:0,y:0},{x:8,y:12},{x:20,y:4}]],imageBytes:Uint8Array.of(137,80,78,71,13,10,26,10,1),documentDigest:state.versions[0].documentDigest,ip:"127.0.0.1",device:"fixture",userAgent:"fixture"});
    const outcome=signing.then(()=>"resolved",()=>"rejected");
    await waitForBlockingEdge(await observedSigning.pid,managerPid);
    await client.query("COMMIT");
    try { assert.equal(await managerOutcome,"Signing context unavailable"); }
    finally { await managerClient.query("ROLLBACK"); await managerClient.end(); await query(`UPDATE org_members SET status='active' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]); }
    assert.equal(await outcome,"resolved");

    const newLease=await draft(), newCase=caseInput(newLease);
    await client.query("BEGIN");
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
    await client.query(`SELECT app.b008_capture_first_period($1,true)`,[newLease]);
    const observedCreation=observedRepo();
    const creation=observedCreation.repo.createCase(admin,newCase);
    const created=creation.then(()=>"resolved",()=>"rejected");
    await waitForBlockingEdge(await observedCreation.pid,capturePid);
    await client.query("COMMIT");
    assert.equal(await created,"resolved");
    const stored=await query<{basis:unknown}>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`,[newLease]);
    assert.ok(stored.rows[0].basis);
  } finally { await client.query("ROLLBACK").catch(()=>{}); await client.end(); }
});

test("basis adoption requires the exact rollout, firm, environment and staff role", async () => {
  const client=new Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  try {
    await client.query("BEGIN");
    const property=(await client.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES ($1,'B008 guard','US','USD','America/Los_Angeles','whole_unit') RETURNING id::text`,[ORG_ID])).rows[0].id;
    const unit=(await client.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'guard','whole_unit') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
    const lease=(await client.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor) VALUES ($1,$2,$3,$3,'draft','2026-12-16','2027-11-30','USD',30000,0) RETURNING id::text`,[ORG_ID,property,unit])).rows[0].id;
    const pin=async (user:string,org:string,env:string) => client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[user,org,env]);
    const denied=async () => { await client.query("SAVEPOINT deny"); try { await assert.rejects(() => client.query(`SELECT app.b008_capture_first_period($1,true)`,[lease]),(error:unknown)=>(error as {code?:string}).code==="42501"); } finally { await client.query("ROLLBACK TO SAVEPOINT deny"); await client.query("RELEASE SAVEPOINT deny"); } };
    await pin(USERS.admin,ORG_ID,"live");
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    for (const value of ['{"enabled":false,"allowed_org_ids":[]}', '{"enabled":"true","allowed_org_ids":[]}', '{"enabled":true,"allowed_org_ids":[]}']) {
      await client.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='billing_previews'`,[value]); await denied();
    }
    await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":"true"}'::jsonb WHERE id=$1`,[ORG_ID]); await denied();
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await pin(USERS.accountant,ORG_ID,"live"); await denied();
    await pin(USERS.admin,ORG_ID,"sandbox"); await denied();
    await pin(USERS.admin,"10000000-0000-4000-8000-000000000002","live"); await denied();
    await pin(USERS.admin,ORG_ID,"live");
    await client.query(`SELECT app.b008_capture_first_period($1,true)`,[lease]);
    const row=await client.query<{basis:{actor:string}}>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`,[lease]);
    assert.equal(row.rows[0].basis.actor,USERS.admin);
  } finally { await client.query("ROLLBACK").catch(()=>{}); await client.end(); }
});

test("actual disposal of an expired partially signed case keeps basis capture locked", async () => {
  await enableSigningFixture();
  const client=new Client({connectionString:process.env.DATABASE_URL}); await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await client.query(`INSERT INTO platform_settings(key,value) VALUES ('esign_disposal_enabled','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
    const property=(await client.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES ($1,'B008 disposal','US','USD','UTC','whole_unit') RETURNING id::text`,[ORG_ID])).rows[0].id;
    const unit=(await client.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'disposal','whole_unit') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
    const lease=(await client.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor) VALUES ($1,$2,$3,$3,'draft','1900-01-01','1901-01-31','USD',30000,0) RETURNING id::text`,[ORG_ID,property,unit])).rows[0].id;
    const caseId=randomUUID(),versionId=randomUUID(),pdf=Buffer.from("%PDF-1.7 disposal fixture"),image=Buffer.from([137,80,78,71,13,10,26,10,1]);
    const runner:TransactionRunner=async (actor,work)=>{
      await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`,[actor]);
      await client.query("SET LOCAL ROLE service_role");
      try { return await work(client); } finally { await client.query("RESET ROLE"); }
    };
    const repo=new EsignRepo({check:async()=>true},runner), admin={userId:USERS.admin,sessionId:staff.sessionId,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",kind:"staff",role:"admin"} as const, owner={userId:USERS.owner,sessionId:ownerSessionId,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",kind:"owner",role:null} as const;
    const at="2026-10-26T12:00:00.000Z",expiry="2026-10-27T12:00:00.000Z";
    const state=await repo.createCase(admin,{caseId,leaseId:lease,versionId,body:"Synthetic disposal",pdfBytes:pdf,signers:[{id:USERS.owner,role:"owner",email:"owner@example.com"},{id:USERS.tenant,role:"tenant",email:"tenant@example.com"}]});
    await repo.apply(admin,caseId,{type:"send",versionId,at,presumedConsentDeadline:expiry,termsVersion:"fixture"});
    await repo.apply(owner,caseId,{type:"consent",versionId,signerId:owner.userId,kind:"explicit",at});
    await repo.apply(owner,caseId,{type:"issue_identity",versionId,signerId:owner.userId,method:"email",expiresAt:expiry,attemptCap:3,at});
    await repo.recordEmailStep(owner,caseId,{versionId,signerId:owner.userId,response:"fixture",at});
    await repo.apply(owner,caseId,{type:"review",versionId,signerId:owner.userId,scrolledToEnd:true,at});
    await repo.recordSignature(owner,caseId,{versionId,signerId:owner.userId,at,strokes:[[{x:0,y:0},{x:8,y:12},{x:20,y:4}]],imageBytes:image,documentDigest:state.versions[0].documentDigest,ip:"127.0.0.1",device:"fixture",userAgent:"fixture"});
    const partial=await client.query<{status:string}>(`SELECT status FROM esign_versions WHERE id=$1`,[versionId]);
    assert.equal(partial.rows[0].status,"partially_signed");
    const disposed=await client.query<{case_id:string;disposed:boolean}>(`SELECT case_id::text,disposed FROM esign_dispose_expired(false,10000)`);
    assert.ok(disposed.rows.some(row=>row.case_id===caseId && row.disposed));
    const evidence=await client.query<{cases:string;images:string;tombstones:string;digests:number}>(`SELECT (SELECT count(*) FROM esign_cases WHERE id=$1)::text AS cases,(SELECT count(*) FROM esign_signature_images WHERE version_id=$2)::text AS images,(SELECT count(*) FROM esign_disposals WHERE case_id=$1)::text AS tombstones,(SELECT cardinality(final_digests) FROM esign_disposals WHERE case_id=$1) AS digests`,[caseId,versionId]);
    assert.deepEqual(evidence.rows[0],{cases:"0",images:"0",tombstones:"1",digests:0});
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
    const before=(await client.query<{count:string}>(`SELECT count(*)::text AS count FROM audit_log WHERE table_name='leases' AND row_id=$1`,[lease])).rows[0].count;
    await client.query("SAVEPOINT capture");
    await assert.rejects(()=>client.query(`SELECT app.b008_capture_first_period($1,true)`,[lease]),(error:unknown)=>(error as {code?:string}).code==="23514");
    await client.query("ROLLBACK TO SAVEPOINT capture");
    const after=await client.query<{basis:unknown;count:string}>(`SELECT first_period_basis AS basis,(SELECT count(*)::text FROM audit_log WHERE table_name='leases' AND row_id=($1::uuid)::text) AS count FROM leases WHERE id=$1::uuid`,[lease]);
    assert.equal(after.rows[0].basis,null); assert.equal(after.rows[0].count,before);
  } finally { await client.query("ROLLBACK").catch(()=>{}); await client.end(); }
});
