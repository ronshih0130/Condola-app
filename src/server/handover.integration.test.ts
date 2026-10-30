import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { createServer } from "node:http";
import { once } from "node:events";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { captureHandoverBeforeDemoReset, reconcileHandoverDemoObjects } from "./handover-demo-reset";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { insertSandboxOrg } from "./sandbox";
import { publishHandover, readHandover, replyHandover, prepareHandoverUpload, uploadHandoverBytes, finalizeHandoverUpload, downloadHandoverAttachment, discardHandoverUpload } from "./handover";
import type { Session } from "./types";

const source = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let admin: Client, db: Client, name: string, owned = false, previous: string | undefined;
test.before(async () => {
  const template = decodeURIComponent(source.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(template)) throw new Error("Invalid template");
  name = `condola_b011_${randomUUID().replaceAll("-", "")}`;
  admin = new Client({ connectionString: withDatabase(source, "postgres") }); await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`); owned = true;
  db = new Client({ connectionString: withDatabase(source, name) }); await db.connect();
  previous = process.env.DATABASE_URL; process.env.DATABASE_URL = withDatabase(source, name);
  if (!(await db.query(`SELECT to_regclass('app.handover_records') IS NOT NULL AS installed`)).rows[0].installed) {
    await resetAndSeed(); // Actual old-schema reset remains supported.
    await db.query(await readFile(new URL("../../supabase/migrations/20261031100214_b011_handover_records.sql", import.meta.url), "utf8"));
  }
  await resetAndSeed();
});
test.after(async () => {
  if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  await db?.end(); if (owned) await admin.query(`DROP DATABASE "${name}"`); await admin?.end();
});
test("rollout, current parties, immutable versions and independent replies", async () => {
  const lease = (await db.query<{id:string}>(`SELECT l.id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 AND lp.role='primary' AND l.status<>'draft' LIMIT 1`, [ORG_ID, USERS.tenant])).rows[0]?.id;
  assert.ok(lease);
  const staffId = randomUUID(), tenantId = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour'),($4,$5,$6,now()+interval '1 hour')`, [staffId, USERS.admin, randomUUID(), tenantId, USERS.tenant, randomUUID()]);
  const staff = { userId:USERS.admin, sessionId:staffId, orgId:ORG_ID, liveOrgId:ORG_ID, kind:"staff", role:"admin", environment:"live", locale:"en", calendar:"gregorian", leaseId:null, name:"Synthetic", email:"" } as Session;
  const tenant = { ...staff, userId:USERS.tenant, sessionId:tenantId, kind:"tenant", role:null, leaseId:lease } as Session;
  await assert.rejects(readHandover(staff, lease));
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"handover_records":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='handover_records'`,[ORG_ID]);
  await assert.rejects(readHandover({...tenant, leaseId:randomUUID()}, lease));
  await assert.rejects(readHandover({...staff, orgId:ORG2_ID, liveOrgId:ORG2_ID}, lease));
  await assert.rejects(readHandover({...tenant, orgId:ORG2_ID, liveOrgId:ORG2_ID}, lease));
  await db.query("BEGIN"); await db.query("SET LOCAL ROLE anon");
  await assert.rejects(db.query(`SELECT * FROM app.handover_versions`)); await db.query("ROLLBACK");
  await assert.rejects(readHandover({...staff, userId:USERS.accountant}, lease));
  const accountantSession = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[accountantSession,USERS.accountant,randomUUID()]);
  await assert.rejects(readHandover({...staff,userId:USERS.accountant,sessionId:accountantSession,role:"admin"},lease));
  const sandbox = await insertSandboxOrg(db, ORG_ID, USERS.admin);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"handover_records":true}'::jsonb WHERE id=$1`,[sandbox]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='handover_records'`,[ORG_ID,sandbox]);
  const property = (await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'Synthetic handover','TW','TWD','Asia/Taipei') RETURNING id`,[sandbox])).rows[0].id;
  const unit = (await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'Synthetic') RETURNING id`,[sandbox,property])).rows[0].id;
  const sandboxLease = (await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2026-01-01','TWD',0) RETURNING id`,[sandbox,property,unit])).rows[0].id;
  const managerId = randomUUID(); await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[managerId,USERS.manager,randomUUID()]);
  const sandboxStaff = {...staff,userId:USERS.manager,sessionId:managerId,role:"manager" as const,orgId:sandbox,environment:"sandbox" as const};
  await readHandover(sandboxStaff,sandboxLease);
  await assert.rejects(readHandover({...sandboxStaff,environment:"live"},sandboxLease));
  await db.query(`UPDATE org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);
  await assert.rejects(readHandover(sandboxStaff,sandboxLease));
  await db.query(`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);
  const liveManager = {...staff,userId:USERS.manager,sessionId:managerId,role:"manager" as const};
  const blocker = new Client({connectionString:withDatabase(source,name)}); await blocker.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(`UPDATE org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);
    const waitingWrite = publishHandover(liveManager,lease,"move_out","Denied after demotion",null);
    let waiting = false;
    for (let attempt=0; attempt<40 && !waiting; attempt++) {
      await new Promise(resolve => setTimeout(resolve,25));
      waiting = (await db.query<{blocked:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%org_members%FOR SHARE%') AS blocked`)).rows[0].blocked;
    }
    assert.ok(waiting); await blocker.query("COMMIT");
    await assert.rejects(waitingWrite);
    await db.query(`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);
  } finally { await blocker.end(); }
  await db.query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{handover_records}','"true"'::jsonb) WHERE id=$1`,[ORG_ID]);
  await assert.rejects(readHandover(staff,lease));
  await db.query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{handover_records}','true'::jsonb) WHERE id=$1`,[ORG_ID]);
  const coId = randomUUID(), guarantorId = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour'),($4,$5,$6,now()+interval '1 hour')`, [coId, USERS.tenant2, randomUUID(), guarantorId, USERS.owner, randomUUID()]);
  const coContact = (await db.query<{id:string}>(`SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL LIMIT 1`,[ORG_ID,USERS.tenant2])).rows[0].id;
  const guarantorContact = (await db.query<{id:string}>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES($1,$2,true,'Synthetic guarantor') RETURNING id`,[ORG_ID,USERS.owner])).rows[0].id;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant'),($1,$2,$4,'guarantor')`, [ORG_ID,lease,coContact,guarantorContact]);
  const coTenant = {...tenant,userId:USERS.tenant2,sessionId:coId};
  await readHandover(coTenant,lease);
  await assert.rejects(readHandover({...tenant,userId:USERS.owner,sessionId:guarantorId},lease));
  const v1 = await publishHandover(staff, lease, "move_in", "Synthetic move-in", null);
  // Metadata reads pin live membership until all protected rows have been read.
  const tableHold = new Client({connectionString:withDatabase(source,name)}), demoter = new Client({connectionString:withDatabase(source,name)});
  await tableHold.connect(); await demoter.connect(); await tableHold.query("BEGIN");
  await tableHold.query(`LOCK TABLE app.handover_records IN ACCESS EXCLUSIVE MODE`);
  const reading = readHandover(liveManager,lease);
  let readWaiting=false;
  for (let n=0;n<40&&!readWaiting;n++) { await new Promise(resolve=>setTimeout(resolve,25)); readWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%SELECT r.id,r.phase%handover_records%') AS blocked`)).rows[0].blocked; }
  assert.ok(readWaiting);
  const demotion = demoter.query(`UPDATE org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);
  let demotionWaiting=false;
  for (let n=0;n<40&&!demotionWaiting;n++) { await new Promise(resolve=>setTimeout(resolve,25)); demotionWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%UPDATE org_members SET role=%') AS blocked`)).rows[0].blocked; }
  await tableHold.query("COMMIT"); assert.ok(demotionWaiting);
  assert.equal((await reading).versions.length,1); await demotion;
  await assert.rejects(readHandover(liveManager,lease));
  await db.query(`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);
  await tableHold.end(); await demoter.end();
  // Real record-lock waits can outlive a previously valid session. No write
  // may proceed using transaction-start time after that wait.
  const recordId = (await db.query<{id:string}>(`SELECT record_id AS id FROM app.handover_versions WHERE id=$1`,[v1.id])).rows[0].id;
  for (const kind of ["publish","reply","prepare"] as const) {
    const expiringSession = randomUUID();
    await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '350 milliseconds')`,[expiringSession,USERS.admin,randomUUID()]);
    const short = {...staff,sessionId:expiringSession};
    const hold = new Client({connectionString:withDatabase(source,name)}); await hold.connect();
    await hold.query("BEGIN"); await hold.query(`SELECT id FROM app.handover_records WHERE id=$1 FOR UPDATE`,[recordId]);
    const operation = kind === "publish" ? publishHandover(short,lease,"move_in","Late write",v1.id)
      : kind === "reply" ? replyHandover(short,lease,v1.id,"confirm","",randomUUID())
      : prepareHandoverUpload(short,lease,v1.id,{fileName:"late.png",mime:"image/png",size:8});
    const result = operation.then(() => "allowed",() => "denied");
    let waiting=false;
    for (let attempt=0; attempt<40 && !waiting; attempt++) {
      await new Promise(resolve => setTimeout(resolve,20));
      waiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%handover_records%FOR UPDATE%') AS blocked`)).rows[0].blocked;
    }
    assert.ok(waiting); await new Promise(resolve => setTimeout(resolve,450));
    await hold.query("COMMIT"); await hold.end(); assert.equal(await result,"denied");
  }
  const leaseSession = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '350 milliseconds')`,[leaseSession,USERS.admin,randomUUID()]);
  const leaseHold = new Client({connectionString:withDatabase(source,name)}); await leaseHold.connect(); await leaseHold.query("BEGIN");
  await leaseHold.query(`SELECT id FROM leases WHERE id=$1 FOR UPDATE`,[lease]);
  const leaseWrite = publishHandover({...staff,sessionId:leaseSession},lease,"move_in","Expired at lease wait",v1.id).then(()=>"allowed",()=>"denied");
  let leaseWaiting=false;
  for (let n=0;n<40&&!leaseWaiting;n++) { await new Promise(resolve=>setTimeout(resolve,20)); leaseWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%FROM public.leases%FOR SHARE%') AS blocked`)).rows[0].blocked; }
  assert.ok(leaseWaiting); await new Promise(resolve=>setTimeout(resolve,450));
  await leaseHold.query("COMMIT"); await leaseHold.end(); assert.equal(await leaseWrite,"denied");
  const auditSession = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '350 milliseconds')`,[auditSession,USERS.admin,randomUUID()]);
  const auditHold = new Client({connectionString:withDatabase(source,name)}); await auditHold.connect(); await auditHold.query("BEGIN");
  await auditHold.query(`LOCK TABLE public.audit_log IN ACCESS EXCLUSIVE MODE`);
  const auditWrite = publishHandover({...staff,sessionId:auditSession},lease,"move_in","Expired during audit",v1.id).then(()=>"allowed",()=>"denied");
  let auditWaiting=false;
  for (let n=0;n<40&&!auditWaiting;n++) { await new Promise(resolve=>setTimeout(resolve,20)); auditWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%INSERT INTO audit_log%') AS blocked`)).rows[0].blocked; }
  assert.ok(auditWaiting); await new Promise(resolve=>setTimeout(resolve,450));
  await auditHold.query("COMMIT"); await auditHold.end(); assert.equal(await auditWrite,"denied");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.handover_versions WHERE record_id=$1`,[recordId])).rows[0].n,1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.handover_replies WHERE version_id=$1`,[v1.id])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.handover_upload_intents WHERE version_id=$1`,[v1.id])).rows[0].n,0);
  const coReply = await replyHandover(coTenant,lease,v1.id,"disagree","Synthetic co-tenant reply",randomUUID());
  assert.ok(coReply);
  await db.query("BEGIN"); await db.query("SET LOCAL ROLE service_role");
  await assert.rejects(db.query(`UPDATE app.handover_records SET created_at=now() WHERE lease_id=$1`,[lease])); await db.query("ROLLBACK");
  const request = randomUUID();
  const firstReply = await replyHandover(tenant, lease, v1.id, "confirm", "", request);
  assert.equal(await replyHandover(tenant, lease, v1.id, "confirm", "", request), firstReply);
  const objects = new Map<string, Buffer>(); let failPost = false; let delayPost = false; let latePost: (() => Promise<void>) | null = null; let pauseGet: (() => Promise<void>) | null = null;
  const server = createServer(async (req, res) => {
    const key = req.url ?? "";
    if (req.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (objects.has(key)) { res.writeHead(409).end(); return; }
      const body = Buffer.concat(chunks);
      if (latePost) { const pause=latePost; latePost=null; res.destroy(); await pause(); objects.set(key,body); return; }
      objects.set(key, body);
      if (failPost) { failPost = false; res.destroy(); return; }
      if (delayPost) { delayPost = false; await new Promise(resolve => setTimeout(resolve, 500)); }
      res.writeHead(200).end(); return;
    }
    if (req.method === "GET") { if (pauseGet) { const pause = pauseGet; pauseGet = null; await pause(); } const bytes = objects.get(key); if (!bytes) { res.writeHead(404).end(); return; } res.writeHead(200).end(bytes); return; }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(200).end(); return; }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const previousUrl = process.env.SUPABASE_URL, previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`; process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-only";
  try {
    const jpeg = Uint8Array.from([0xff,0xd8,0xff,1,2,3]);
    const intent = await prepareHandoverUpload(tenant,lease,v1.id,{fileName:"condition.jpg",mime:"image/jpeg",size:jpeg.length});
    await assert.rejects(db.query(`INSERT INTO app.handover_attachments(org_id,lease_id,intent_id,file_name,mime,size_bytes,sha256,storage_path,created_by) VALUES($1,$2,$3,'bad.png','image/png',1,$4,'invalid-scope',$5)`,[ORG_ID,sandboxLease,intent.intentId,"a".repeat(64),USERS.tenant]),(error:unknown)=>(error as {code?:string}).code === "23503");
    failPost = true;
    await assert.rejects(uploadHandoverBytes(tenant,lease,intent.intentId,jpeg));
    await uploadHandoverBytes(tenant,lease,intent.intentId,jpeg); // prior write committed despite failed response
    await db.query(`CREATE FUNCTION app.test_b011_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='handover_attachment_published' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER test_b011_reject_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION app.test_b011_reject_audit()`);
    await assert.rejects(finalizeHandoverUpload(tenant,lease,intent.intentId));
    assert.equal((await db.query(`SELECT status FROM app.handover_upload_intents WHERE id=$1`, [intent.intentId])).rows[0].status, "pending");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.handover_attachments WHERE intent_id=$1`, [intent.intentId])).rows[0].n, 0);
    assert.equal(objects.size,2); // sealed object survives rollback and can be reconciled
    await db.query(`DROP TRIGGER test_b011_reject_audit ON public.audit_log`);
    const attached = await finalizeHandoverUpload(tenant,lease,intent.intentId);
    const intentHold = new Client({connectionString:withDatabase(source,name)}); await intentHold.connect();
    await db.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '350 milliseconds' WHERE id=$1`,[tenantId]);
    await intentHold.query("BEGIN"); await intentHold.query(`SELECT id FROM app.handover_upload_intents WHERE id=$1 FOR UPDATE`,[intent.intentId]);
    const replay = finalizeHandoverUpload(tenant,lease,intent.intentId).then(()=>"allowed",()=>"denied");
    let intentWaiting=false;
    for (let n=0;n<40&&!intentWaiting;n++) { await new Promise(resolve=>setTimeout(resolve,20)); intentWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%handover_upload_intents WHERE id=%FOR UPDATE%') AS blocked`)).rows[0].blocked; }
    assert.ok(intentWaiting); await new Promise(resolve=>setTimeout(resolve,450));
    await intentHold.query("COMMIT"); await intentHold.end(); assert.equal(await replay,"denied");
    await db.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`,[tenantId]);
    assert.equal((await finalizeHandoverUpload(tenant,lease,intent.intentId)).id, attached.id);
    assert.deepEqual((await downloadHandoverAttachment(staff,lease,attached.id)).bytes,jpeg);
    await assert.rejects(downloadHandoverAttachment({...tenant,leaseId:randomUUID()},lease,attached.id));
    assert.equal(objects.size,2); // temporary and separately sealed objects
    await discardHandoverUpload(tenant,lease,intent.intentId);
    assert.equal(objects.size,1);
    assert.deepEqual((await downloadHandoverAttachment(staff,lease,attached.id)).bytes,jpeg);
    const active = (await readHandover(tenant,lease)).versions.find(v=>v.phase === "move_in"); assert.ok(active);
    const expiring = await prepareHandoverUpload(tenant,lease,active.version_id,{fileName:"late.jpg",mime:"image/jpeg",size:jpeg.length});
    await db.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1`,[tenantId]);
    delayPost = true; await assert.rejects(uploadHandoverBytes(tenant,lease,expiring.intentId,jpeg));
    await db.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`,[tenantId]);
    assert.equal((await db.query(`SELECT status FROM app.handover_upload_intents WHERE id=$1`,[expiring.intentId])).rows[0].status,"pending");
    await discardHandoverUpload(tenant,lease,expiring.intentId);
    await assert.rejects(uploadHandoverBytes(tenant,lease,expiring.intentId,jpeg));
    await discardHandoverUpload(tenant,lease,expiring.intentId); // tombstone remains reconcilable
    const late = await prepareHandoverUpload(tenant,lease,active.version_id,{fileName:"late-arrival.jpg",mime:"image/jpeg",size:jpeg.length});
    let lateRelease!: () => void, lateWritten!: () => void;
    const lateBarrier = new Promise<void>(resolve=>{lateRelease=resolve;});
    const lateDone = new Promise<void>(resolve=>{lateWritten=resolve;});
    latePost = async () => { await lateBarrier; setImmediate(lateWritten); };
    await assert.rejects(uploadHandoverBytes(tenant,lease,late.intentId,jpeg));
    await discardHandoverUpload(tenant,lease,late.intentId);
    const lateRow = (await db.query<{storage_path:string;status:string}>(`SELECT storage_path,status FROM app.handover_upload_intents WHERE id=$1`,[late.intentId])).rows[0];
    const lateKey = `/storage/v1/object/handover-attachments-private/${lateRow.storage_path}`;
    assert.equal(lateRow.status,"discarded"); assert.equal(objects.has(lateKey),false);
    lateRelease(); await lateDone; assert.equal(objects.has(lateKey),true);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.handover_attachments WHERE intent_id=$1`,[late.intentId])).rows[0].n,0);
    await discardHandoverUpload(tenant,lease,late.intentId); assert.equal(objects.has(lateKey),false);
    const race = await prepareHandoverUpload(tenant,lease,active.version_id,{fileName:"race.jpg",mime:"image/jpeg",size:jpeg.length});
    await uploadHandoverBytes(tenant,lease,race.intentId,jpeg);
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered=resolve; });
    const barrier = new Promise<void>(resolve => { release=resolve; });
    pauseGet = async () => { entered(); await barrier; };
    const finalize = finalizeHandoverUpload(tenant,lease,race.intentId);
    await observed;
    const cleanup = discardHandoverUpload(tenant,lease,race.intentId);
    let blocked = false;
    for (let attempt=0; attempt<40 && !blocked; attempt++) {
      await new Promise(resolve => setTimeout(resolve,25));
      blocked = (await db.query<{blocked:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%handover_records%FOR UPDATE%') AS blocked`)).rows[0].blocked;
    }
    release(); assert.ok(blocked);
    const raced = await finalize; await cleanup;
    assert.deepEqual((await downloadHandoverAttachment(staff,lease,raced.id)).bytes,jpeg);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL=previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY=previousKey;
  }
  const afterAttachment = (await readHandover(staff,lease)).versions.find(v=>v.phase === "move_in");
  assert.ok(afterAttachment);
  const v2 = await publishHandover(staff, lease, "move_in", "Corrected condition", afterAttachment.version_id);
  await assert.rejects(replyHandover(tenant, lease, v1.id, "confirm", "", randomUUID()));
  await replyHandover(staff, lease, v2.id, "disagree", "Synthetic difference", randomUUID());
  await publishHandover(staff, lease, "move_out", "Synthetic move-out", null);
  const data = await readHandover(tenant, lease);
  assert.equal(data.versions.length, 5); assert.equal(data.replies.length, 3);
  assert.ok(data.versions[0].author_name);
  assert.ok(data.attachments.some(a => a.file_name === "condition.jpg" && a.uploader_name && a.created_at));
  assert.ok(data.replies.every(r => r.actor_name && r.created_at));
  assert.equal(data.replies.filter(r => r.version_id === v2.id && r.actor_kind === "tenant").length, 0);
  await db.query("BEGIN"); await db.query("SET LOCAL ROLE authenticated");
  await assert.rejects(db.query(`SELECT * FROM app.handover_versions`)); await db.query("ROLLBACK");
  const oldCount = Number((await db.query(`SELECT count(*) AS n FROM app.handover_records`)).rows[0].n);
  await db.query("BEGIN"); await captureHandoverBeforeDemoReset(db); await db.query("ROLLBACK");
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.handover_records`)).rows[0].n),oldCount);
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.handover_gc_tombstones`)).rows[0].n),0);
  await db.query("BEGIN"); await captureHandoverBeforeDemoReset(db); await db.query("COMMIT");
  assert.equal((await readHandover(staff,lease)).versions.length,0);
  const tombstones = Number((await db.query(`SELECT count(*) AS n FROM app.handover_gc_tombstones`)).rows[0].n);
  assert.ok(tombstones >= 4);
  const oldFetch=globalThis.fetch, url=process.env.SUPABASE_URL, key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL="http://127.0.0.1:1"; process.env.SUPABASE_SERVICE_ROLE_KEY="synthetic-only";
  try {
    globalThis.fetch = (async () => new Response("",{status:503})) as typeof fetch;
    await reconcileHandoverDemoObjects(db,100);
    globalThis.fetch = (async () => new Response("",{status:200})) as typeof fetch;
    await reconcileHandoverDemoObjects(db,100);
    const attempts = (await db.query(`SELECT outcome,count(*)::int AS n FROM app.handover_gc_attempts GROUP BY outcome ORDER BY outcome`)).rows;
    assert.deepEqual(attempts,[{outcome:"delete_accepted",n:tombstones},{outcome:"storage_unavailable",n:tombstones}]);
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.handover_gc_tombstones`)).rows[0].n),tombstones);
  } finally { globalThis.fetch=oldFetch; if(url===undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL=url; if(key===undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY=key; }
  // Reset-first: app admission waits, then sees the post-reset state.
  const resetClient = new Client({connectionString:withDatabase(source,name)}); await resetClient.connect();
  await resetClient.query("BEGIN"); await captureHandoverBeforeDemoReset(resetClient);
  const afterReset = publishHandover(staff,lease,"move_in","New after reset",null);
  let admissionWaiting=false;
  for (let n=0;n<40&&!admissionWaiting;n++) { await new Promise(resolve=>setTimeout(resolve,25)); admissionWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%LOCK TABLE public.platform_settings IN SHARE MODE%') AS blocked`)).rows[0].blocked; }
  assert.ok(admissionWaiting); await resetClient.query(`UPDATE organizations SET name=name WHERE id=$1`,[ORG_ID]); await resetClient.query("COMMIT");
  const newVersion=await afterReset;
  // App-first: writer holds admission while waiting for a record; reset waits
  // before taking any private table or public parent locks.
  const holdRecord = new Client({connectionString:withDatabase(source,name)}); await holdRecord.connect(); await holdRecord.query("BEGIN");
  await holdRecord.query(`SELECT r.id FROM app.handover_records r JOIN app.handover_versions v ON v.record_id=r.id WHERE v.id=$1 FOR UPDATE OF r`,[newVersion.id]);
  const writer=publishHandover(staff,lease,"move_in","Before reset",newVersion.id);
  let writerWaiting=false;
  for (let n=0;n<40&&!writerWaiting;n++) { await new Promise(resolve=>setTimeout(resolve,25)); writerWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%handover_records%FOR UPDATE%') AS blocked`)).rows[0].blocked; }
  assert.ok(writerWaiting);
  await resetClient.query("BEGIN"); const reset = captureHandoverBeforeDemoReset(resetClient);
  let resetWaiting=false;
  for (let n=0;n<40&&!resetWaiting;n++) { await new Promise(resolve=>setTimeout(resolve,25)); resetWaiting=(await db.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE%') AS blocked`)).rows[0].blocked; }
  assert.ok(resetWaiting); await holdRecord.query("COMMIT"); await writer; await reset; await resetClient.query("COMMIT");
  assert.equal((await readHandover(staff,lease)).versions.length,0);
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.handover_gc_tombstones`)).rows[0].n),tombstones);
  await holdRecord.end(); await resetClient.end();
});

test("actual demo reset snapshots handover paths and clears private records", async (t) => {
  const lease = (await db.query<{id:string}>(`SELECT l.id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 AND lp.role='primary' AND l.status<>'draft' LIMIT 1`,[ORG_ID,USERS.tenant])).rows[0].id;
  const sid = randomUUID(); await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  const staff = {userId:USERS.admin,sessionId:sid,orgId:ORG_ID,liveOrgId:ORG_ID,kind:"staff",role:"admin",environment:"live",locale:"en",calendar:"gregorian",leaseId:null,name:"Synthetic",email:""} as Session;
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"handover_records":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='handover_records'`,[ORG_ID]);
  const version=await publishHandover(staff,lease,"move_in","Old demo data",null);
  const intent=await prepareHandoverUpload(staff,lease,version.id,{fileName:"pending.png",mime:"image/png",size:8});
  const path=(await db.query<{storage_path:string}>(`SELECT storage_path FROM app.handover_upload_intents WHERE id=$1`,[intent.intentId])).rows[0].storage_path;
  const b010Installed = (await db.query<{present:boolean}>(`SELECT to_regclass('app.b010_source_events') IS NOT NULL AS present`)).rows[0].present;
  if (b010Installed) {
    const info=(await db.query<{id:string;property_id:string}>(`SELECT id,property_id FROM leases WHERE id=$1`,[lease])).rows[0];
    const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor) VALUES($1,$2,$3,'B011-RESET','TWD',current_date,'open',0) RETURNING id`,[ORG_ID,info.property_id,lease])).rows[0].id;
    const event=(await db.query<{id:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due','synthetic-reset',current_date) RETURNING id`,[ORG_ID,lease,invoice])).rows[0].id;
    const contact=(await db.query<{id:string}>(`SELECT contact_id AS id FROM lease_parties WHERE lease_id=$1 AND role='primary' LIMIT 1`,[lease])).rows[0].id;
    const claim=(await db.query<{id:string}>(`INSERT INTO app.b028_recipient_claims(org_id,event_id,principal_user_id,contact_id,channel) VALUES($1,$2,$3,$4,'email') RETURNING id`,[ORG_ID,event,USERS.tenant,contact])).rows[0].id;
    await db.query(`INSERT INTO app.b028_read_markers(org_id,claim_id,principal_user_id) VALUES($1,$2,$3)`,[ORG_ID,claim,USERS.tenant]);
    await db.query(`INSERT INTO app.b010_tenant_due_preferences(org_id,user_id,due_enabled) VALUES($1,$2,false)`,[ORG_ID,USERS.tenant]);
    const payment=(await db.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES($1,$2,$3,'TWD',100,current_date,'bank_transfer','submitted','tenant_portal',$4) RETURNING id`,[ORG_ID,info.property_id,lease,USERS.tenant])).rows[0].id;
    await db.query(`INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES($1,$2,$3,$4,$5)`,[ORG_ID,USERS.tenant,randomUUID(),"a".repeat(64),payment]);
    t.diagnostic("Real B010/B028 private rows included");
  } else t.diagnostic("B010/B028 schema absent; old-schema compatibility only");
  await resetAndSeed(); // Real seed hook, in its actual transaction.
  const state=(await db.query(`SELECT (SELECT count(*)::int FROM app.handover_records) AS records,(SELECT count(*)::int FROM app.handover_versions) AS versions,(SELECT count(*)::int FROM app.handover_upload_intents) AS intents,(SELECT count(*)::int FROM app.handover_gc_tombstones WHERE storage_path IN ($1,$2)) AS tombstones`,[path,`${path}/sealed`])).rows[0];
  assert.deepEqual(state,{records:0,versions:0,intents:0,tombstones:2});
  if (b010Installed) {
    for (const table of ["b010_source_events","b028_recipient_claims","b028_read_markers","b010_payment_commands","b010_tenant_due_preferences"]) {
      assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n),0);
    }
  }
});
