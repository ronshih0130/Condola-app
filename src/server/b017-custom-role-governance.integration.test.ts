import * as React from "react";
import { POST as flowPOST } from "@/app/api/flows/[action]/route";
import { readHandover } from "./handover";
import { editDirectoryContact } from "./tenant-directory-edit";
import { paymentRequestStatus } from "./payment-request-status";
import { queueManualReminder } from "./manual-reminders";
import { canReviewId, reviewIdCheck } from "./id-docs";
import { requireEsignOrganization, management } from "./esign/access";
import { staffRoleMayDownloadSignedPdf } from "./signed-pdf-http";
import { recordPayment, confirmPayment, createProperty, setMeterSerial } from "./domain";
import { buildStoredConsent } from "./consent";
import { monthlyRentPreview } from "./monthly-rent-preview";
import { bankBoard, bankMatchingEnabled } from "./bank-matching";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { POST as monthlyPOST } from "@/app/api/monthly-rent-issue/route";
import { writeMonthlyRent } from "./monthly-rent-writer";
import { recordPeriodDueComponent } from "./period-due-components";
import { approveVendorSharing, dispatchVendor, __setVendorLinkKillSwitchForTests } from "./vendor-repair";
import { assertCustomAuthorityOn } from "./b017-custom-role-governance";
import { svc } from "./db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { Client } from "pg";
import { GET as reportGET } from "@/app/m/reports/export/route";
import { GET as photoGET } from "@/app/api/tickets/photos/[id]/route";
import { POST as photoSignPOST } from "@/app/api/tickets/photos/sign/route";
import { SESSION_COOKIE, setMemberActive, setMemberRole, inviteMember, acceptTeamInvite } from "./auth";
import { governCustomRole, resolveCustomRoleSession, resolveCustomRoleSessionOn, customRolesEnabledOn } from "./b017-custom-role-governance";
import { loadAuditScreen } from "./audit-read";
import { tx } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { can, assertPerm, canTicketPhotos, noPermHref, PERMS, ROLE_KEYS } from "./perms";
import { listPayments, listMatches, ticketDetail } from "./queries";
import { readRepairPhoto, repairPhotoTarget } from "./repairs";
import { DEMO_PASSWORD } from "./demo-password";
import { resetAndSeed } from "./seed";
import { completeSession, readSessionOn, sessionTokenHash } from "./session";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
let admin: Session, manager: Session, accountant: Session, other: Session;
let cookie = "";
const tokens = new Map<string, string>();
mock.method(nextHeaders, "cookies", async () => ({ get(name: string) {
  if (name === SESSION_COOKIE) return { value: cookie };
  if (name === "condola_env") return { value: "live" };
  return undefined;
} }));
mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/m/reports/export" }));

test.before(async () => {
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  await resetAndSeed();
});
test.after(async () => { await db?.end(); await clone?.cleanup(); mock.restoreAll(); });
test.beforeEach(async () => {
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([ORG_ID, ORG2_ID]);
  await flag(false);
  // Dedicated clone only; resetting fixtures deliberately bypasses immutable history triggers.
  await db.query("SET session_replication_role=replica");
  await db.query("DELETE FROM app.b017_governance_receipts; DELETE FROM app.b017_assignments; DELETE FROM app.b017_role_revisions; DELETE FROM app.b017_roles");
  await db.query("SET session_replication_role=DEFAULT");
  await db.query(`UPDATE org_members SET role=CASE user_id WHEN $1 THEN 'admin'::org_role WHEN $2 THEN 'manager'::org_role WHEN $3 THEN 'accountant'::org_role ELSE role END,
    status='active',is_billing_owner=(user_id=$1) WHERE org_id=$4`, [USERS.admin, USERS.manager, USERS.accountant, ORG_ID]);
  admin = await session(USERS.admin, "admin"); manager = await session(USERS.manager, "manager");
  accountant = await session(USERS.accountant, "accountant"); other = await session(USERS.coastAdmin, "admin", ORG2_ID);
  cookie = tokens.get(manager.userId)!;
  await flag(true);
});
async function flag(on: boolean) {
  await db.query(`INSERT INTO platform_settings(key,value) VALUES('custom_roles',jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text,$3::text)))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [on, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('custom_roles',$1::boolean) WHERE id=ANY($2::uuid[])`, [on, [ORG_ID, ORG2_ID]]);
}
async function session(userId: string, role: Session["role"], orgId = ORG_ID): Promise<Session> {
  const sessionId = randomUUID(), token = randomUUID(); tokens.set(userId, token);
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [sessionId,userId,sessionTokenHash(token)]);
  return { userId, sessionId, role, orgId, liveOrgId: orgId, environment: "live", kind: "staff", locale: "en", calendar: "gregorian", leaseId: null, email: "fixture@example.invalid", name: "Fixture" };
}
async function member(s: Session) { return (await db.query(`SELECT id FROM org_members WHERE org_id=$1 AND user_id=$2`, [s.orgId,s.userId])).rows[0].id as string; }
async function create(grants: string[], actor = admin, requestId = randomUUID()) {
  const r = await governCustomRole(actor, { operation: "create", grants, requestId }); assert.ok(r.roleId); return r.roleId;
}
async function assign(roleId: string, s = manager, actor = admin) {
  return governCustomRole(actor, { operation: "assign", roleId, memberId: await member(s), requestId: randomUUID() });
}
async function raw(actor: Session, sql: string, args: unknown[], connection = db, role = "service_role") {
  await connection.query("BEGIN");
  try {
    await connection.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [actor.userId,actor.orgId]);
    await connection.query(`SET LOCAL ROLE ${role}`);
    const result = await connection.query(sql,args); await connection.query("COMMIT"); return result;
  } catch (e) { await connection.query("ROLLBACK"); throw e; }
}
function denied(e: unknown) { return /B017|customRoleNativeCeiling|forbidden|permission denied|foreign key|lock|lastAdmin|ownRole/.test(String(e)); }
async function counts() {
  return (await db.query(`SELECT (SELECT count(*)::int FROM app.b017_roles) roles,(SELECT count(*)::int FROM app.b017_role_revisions) revisions,
    (SELECT count(*)::int FROM app.b017_assignments) assignments,(SELECT count(*)::int FROM app.b017_governance_receipts) receipts`)).rows[0];
}

test("ON create/assign/revise/reassign/retire/unassign lifecycle and immutable history", async () => {
  const role = await create(["reports.export", "props.view"]);
  await assign(role);
  let s = await resolveCustomRoleSession(manager);
  assert.equal(can(s,"props.view"),true); assert.equal(can(s,"props.edit"),false);
  await governCustomRole(admin,{operation:"revise",roleId:role,grants:["props.view"],requestId:randomUUID()});
  s = await resolveCustomRoleSession(manager); assert.equal(s.customRole?.keys,null);
  await assign(role); s = await resolveCustomRoleSession(manager); assert.equal(can(s,"props.view"),true);
  await governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()});
  assert.equal((await resolveCustomRoleSession(manager)).customRole?.keys,null);
  await governCustomRole(admin,{operation:"unassign",memberId:await member(manager),requestId:randomUUID()});
  s = await resolveCustomRoleSession(manager); assert.equal(can(s,"props.edit"),true);
  assert.equal((await db.query(`SELECT count(*)::int n FROM app.b017_role_revisions WHERE role_id=$1`,[role])).rows[0].n,2);
  await assert.rejects(db.query(`UPDATE app.b017_role_revisions SET grants='{}' WHERE role_id=$1`,[role]),denied);
  await assert.rejects(db.query(`DELETE FROM app.b017_governance_receipts`),denied);
});

test("TS and SQL reject unsupported grants and grant escalation beyond the actor", async () => {
  await flag(false);
  await db.query(`UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);
  await flag(true); manager.role="admin";
  const limited = await create(["team.manage","settings.edit","props.view"]);
  await assign(limited,manager);
  await assert.rejects(create(["bank.reconcile"],manager),denied);
  await assert.rejects(raw(manager,`SELECT public.b017_create_role($1,$2,$3,$4,$5)`,[ORG_ID,manager.userId,manager.sessionId,randomUUID(),["bank.reconcile"]]),denied);
  const powerful=await create(["bank.reconcile"]);
  await assert.rejects(assign(powerful,accountant,manager),denied);
  await assert.rejects(governCustomRole(manager,{operation:"unassign",memberId:await member(accountant),requestId:randomUUID()}),denied);
  for (const keys of [["data.export"],["team.manage","team.manage"],["unknown"]]) {
    await assert.rejects(create(keys),denied);
    await assert.rejects(raw(admin,`SELECT public.b017_create_role($1,$2,$3,$4,$5)`,[ORG_ID,admin.userId,admin.sessionId,randomUUID(),keys]),denied);
  }
  await assert.rejects(create(["props.view"],accountant),denied);
});

test("same-org references and live session are mandatory at SQL gateway",async()=>{
  const foreign=await create(["props.view"],other), local=await create(["props.view"]);
  await assert.rejects(assign(foreign),denied);
  await assert.rejects(assign(local,other),denied);
  await assert.rejects(raw(admin,`SELECT public.b017_create_role($1,$2,$3,$4,$5)`,[ORG2_ID,admin.userId,admin.sessionId,randomUUID(),["props.view"]]),denied);
  await db.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`,[admin.sessionId]);
  await assert.rejects(create(["props.view"]),denied);
});

test("request receipt replay is stable, conflicting operation/payload/actor rejected",async()=>{
  const requestId=randomUUID(), role=await create(["props.view"],admin,requestId);
  assert.equal(await create(["props.view"],admin,requestId),role);
  assert.deepEqual(await counts(),{roles:1,revisions:1,assignments:0,receipts:1});
  await assert.rejects(create(["props.edit"],admin,requestId),/forbidden/);
  await assert.rejects(raw(admin,`SELECT public.b017_retire_role($1,$2,$3,$4,$5)`,[ORG_ID,admin.userId,admin.sessionId,requestId,role]),/conflicting replay/);
  await flag(false);await db.query(`UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId]);await flag(true);
  await assert.rejects(raw(manager,`SELECT public.b017_create_role($1,$2,$3,$4,$5)`,[ORG_ID,manager.userId,manager.sessionId,requestId,["props.view"]]),/conflicting replay/);
});

test("same-cookie real report route rejects stale revision and retired role, OFF restores native",async()=>{
  const role=await create(["reports.export"]);await assign(role);
  const call=()=>reportGET(new Request("http://127.0.0.1/m/reports/export?month=2026-10"));
  assert.equal((await call()).status,200);
  await governCustomRole(admin,{operation:"revise",roleId:role,grants:["reports.export"],requestId:randomUUID()});
  assert.equal((await call()).status,403);
  await assign(role);assert.equal((await call()).status,200);
  await governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()});
  assert.equal((await call()).status,403);
  await flag(false);assert.equal((await call()).status,200);
});

test("OFF/malformed gates perform no governance writes and preserve every native permission",async()=>{
  for (const value of [null,{enabled:false,allowed_org_ids:[ORG_ID]},{enabled:"true",allowed_org_ids:[ORG_ID]},
    {enabled:true,allowed_org_ids:ORG_ID},{enabled:true,allowed_org_ids:[ORG_ID,42]},{enabled:true,allowed_org_ids:[]}]) {
    await db.query(`UPDATE platform_settings SET value=$1 WHERE key='custom_roles'`,[JSON.stringify(value)]);
    assert.equal(await customRolesEnabledOn(db,ORG_ID),false);
    const before=await counts();
    await assert.rejects(create(["props.view"]),denied);
    await assert.rejects(raw(admin,`SELECT public.b017_create_role($1,$2,$3,$4,$5)`,[ORG_ID,admin.userId,admin.sessionId,randomUUID(),["props.view"]]),denied);
    assert.deepEqual(await counts(),before);
    assert.equal(await resolveCustomRoleSession(admin),admin);
    for (const role of ROLE_KEYS) for (const [key] of PERMS) {
      const s={...admin,role};assert.equal(can(s,key),can(role,key));
      if(can(role,key))assert.doesNotThrow(()=>assertPerm(s,key));else assert.throws(()=>assertPerm(s,key));
    }
  }
  await flag(true);await db.query(`UPDATE organizations SET feature_flags=jsonb_build_object('custom_roles','true'::text) WHERE id=$1`,[ORG_ID]);
  assert.equal(await customRolesEnabledOn(db,ORG_ID),false);
  assert.deepEqual(await counts(),{roles:0,revisions:0,assignments:0,receipts:0});
});

test("assignment and explicit tombstone survive suspend/reinvite/reactivate",async()=>{
  const role=await create(["props.view"]);await assign(role);
  for(const status of ["suspended","removed","invited","active"]){
    await db.query(`UPDATE org_members SET status=$1 WHERE org_id=$2 AND user_id=$3`,[status,ORG_ID,manager.userId]);
    assert.equal((await db.query(`SELECT role_id FROM app.b017_assignments WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId])).rows[0].role_id,role);
  }
  await governCustomRole(admin,{operation:"unassign",memberId:await member(manager),requestId:randomUUID()});
  const before=(await db.query(`SELECT * FROM app.b017_assignments WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId])).rows[0];
  assert.equal(before.role_id,null);
  for(const status of ["suspended","removed","invited","active"]){
    await db.query(`UPDATE org_members SET status=$1 WHERE org_id=$2 AND user_id=$3`,[status,ORG_ID,manager.userId]);
    assert.deepEqual((await db.query(`SELECT * FROM app.b017_assignments WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId])).rows[0],before);
  }
});

test("unadmitted OFF resolver emits zero queries and never locks another ON org",async()=>{
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST = JSON.stringify([ORG_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"custom_roles":false}' WHERE id=$1`,[ORG2_ID]);
  const statements: string[]=[];
  const traced={query:async(sql:string,args:unknown[])=>{statements.push(sql);return db.query(sql,args);}} as Client;
  assert.equal(await resolveCustomRoleSessionOn(traced,other),other);
  assert.deepEqual(statements,[]);
  const holder=new Client({connectionString:clone.url});await holder.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);
    await db.query("SET statement_timeout='2s'");
    await db.query(`UPDATE org_members SET role=role WHERE org_id=$1`,[ORG2_ID]);
    assert.deepEqual(await counts(),{roles:0,revisions:0,assignments:0,receipts:0});
  } finally {await db.query("RESET statement_timeout");await holder.query("ROLLBACK");await holder.end();}
});

test("real suspend/reactivate and invitation acceptance retain assignment tombstones",async()=>{
  const previous = process.env.TEAM_INVITES_ORG_ALLOWLIST;
  process.env.TEAM_INVITES_ORG_ALLOWLIST=ORG_ID;
  try {
    const role=await create(["props.view"]);await assign(role);
    const memberId=await member(manager);
    await setMemberActive(admin,memberId,false,true);
    assert.equal((await resolveCustomRoleSession(manager)).customRole?.keys,null);
    await setMemberActive(admin,memberId,true);
    assert.equal((await db.query(`SELECT role_id FROM app.b017_assignments WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId])).rows[0].role_id,role);
    await governCustomRole(admin,{operation:"unassign",memberId,requestId:randomUUID()});
    const tombstone=(await db.query(`SELECT * FROM app.b017_assignments WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId])).rows[0];
    await db.query(`UPDATE org_members SET status='removed' WHERE id=$1`,[memberId]);
    const email=(await db.query(`SELECT email FROM auth.users WHERE id=$1`,[manager.userId])).rows[0].email;
    const invitation=await inviteMember(admin,{email,name:"Fixture",role:"manager"});
    const accepted=await acceptTeamInvite(db,invitation.token,"Fixture",DEMO_PASSWORD,{ua:"b017",ip:"127.0.0.1"},email);
    assert.equal(accepted.ok,true);
    assert.deepEqual((await db.query(`SELECT * FROM app.b017_assignments WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId])).rows[0],tombstone);
  } finally {if(previous===undefined)delete process.env.TEAM_INVITES_ORG_ALLOWLIST;else process.env.TEAM_INVITES_ORG_ALLOWLIST=previous;}
});

test("native team APIs re-resolve the actor and reject grant escalation",async()=>{
  await flag(false);await db.query(`UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId]);await flag(true);
  manager.role="admin";
  const limited=await create(["team.manage","settings.edit","props.view"]);await assign(limited,manager);
  // Pass the old native session: the API must consult current authority again.
  await assert.rejects(setMemberRole(manager,await member(accountant),"admin"),denied);
  await raw(manager,`UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,accountant.userId]);
  await assert.rejects(setMemberActive(manager,await member(accountant),true),denied);
});

test("billing owner and direct/indirect self lockout are protected",async()=>{
  const low=await create(["props.view"]);
  await assert.rejects(assign(low,admin),denied);
  await assert.rejects(db.query(`UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,admin.userId]),denied);
  await assert.rejects(db.query(`DELETE FROM org_members WHERE org_id=$1 AND user_id=$2`,[ORG_ID,admin.userId]),denied);
  await assert.rejects(db.query(`UPDATE org_members SET is_billing_owner=false WHERE org_id=$1 AND user_id=$2`,[ORG_ID,admin.userId]),denied);
  const full=await create(PERMS.filter(([key])=>key!=="data.export").map(([key])=>key));await assign(full,admin);
  await assert.rejects(governCustomRole(admin,{operation:"revise",roleId:full,grants:["props.view"],requestId:randomUUID()}),denied);
  await assert.rejects(governCustomRole(admin,{operation:"retire",roleId:full,requestId:randomUUID()}),denied);
  await assert.rejects(setMemberRole(await resolveCustomRoleSession(admin),await member(admin),"manager"),denied);
  await assert.rejects(setMemberActive(await resolveCustomRoleSession(admin),await member(admin),false,true),denied);
});

for(const mutation of ["remove","demote","suspend"] as const) test(`two connections serialize last usable Admin ${mutation}`,async()=>{
  await flag(false);
  await db.query(`UPDATE org_members SET is_billing_owner=false WHERE org_id=$1`,[ORG_ID]);
  await db.query(`UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,manager.userId]);
  await flag(true);
  const a=new Client({connectionString:clone.url}), b=new Client({connectionString:clone.url});await a.connect();await b.connect();
  const sql=mutation==="remove"?`UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$2`:
    mutation==="demote"?`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`:`UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2`;
  try {
    // A legacy UPDATE can wait on the target tuple before its row trigger runs.
    // Bound that wait, then retry the complete statement after the holder commits.
    await b.query("SET lock_timeout='250ms'");
    await a.query("BEGIN");await a.query(sql,[ORG_ID,admin.userId]);
    await assert.rejects(b.query(sql,[ORG_ID,manager.userId]),(e:unknown)=>(e as {code:string}).code==="55P03");
    await a.query("COMMIT");
    await assert.rejects(b.query(sql,[ORG_ID,manager.userId]),/last usable native Admin/);
    assert.equal((await db.query(`SELECT count(*)::int n FROM org_members WHERE org_id=$1 AND role='admin' AND status='active'`,[ORG_ID])).rows[0].n,1);
  } finally {await a.query("ROLLBACK");await a.end();await b.end();}
});

test("two governance connections: waiting self-assign-lower cannot bypass post-lock authority",async()=>{
  const low=await create(["props.view"]), memberId=await member(admin);
  const a=new Client({connectionString:clone.url}), b=new Client({connectionString:clone.url});await a.connect();await b.connect();
  try {
    await a.query("BEGIN");await a.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);
    await b.query("SET statement_timeout='4s'");
    const pending=raw(admin,`SELECT public.b017_assign_role($1,$2,$3,$4,$5,$6)`,[ORG_ID,admin.userId,admin.sessionId,randomUUID(),low,memberId],b);
    // Observe a real server lock wait, rather than assuming a sleep means blocked.
    let waiting=false;
    for(let i=0;i<100;i++){
      waiting=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') waiting`,[(b as Client & {processID:number}).processID])).rows[0].waiting;
      if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true);await a.query("COMMIT");await assert.rejects(pending,denied);
    assert.equal((await db.query(`SELECT count(*)::int n FROM app.b017_assignments`)).rows[0].n,0);
  } finally {await a.query("ROLLBACK");await a.end();await b.end();}
});

test("Accountant photos/metadata/count/upload/download and non-Admin audit floors survive grants",async()=>{
  const role=await create(["reports.export"]);await assign(role,accountant);
  const s=await resolveCustomRoleSession(accountant);assert.equal(can(s,"tickets.update"),false);assert.equal(canTicketPhotos(s),false);
  const ticket=(await db.query(`SELECT id FROM maintenance_tickets WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const file=randomUUID(),attachment=randomUUID();
  await db.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,uploaded_by,size_bytes) VALUES($1,$2,'ticket-photos-private',$3,'private.png','image/png',$4,42)`,[file,ORG_ID,`org/${ORG_ID}/tickets/${ticket}/${file}.png`,accountant.userId]);
  await db.query(`INSERT INTO ticket_attachments(id,org_id,ticket_id,file_id) VALUES($1,$2,$3,$4)`,[attachment,ORG_ID,ticket,file]);
  await assert.rejects(ticketDetail(s,ticket),denied);
  await assert.rejects(repairPhotoTarget(s,ticket),denied);await assert.rejects(readRepairPhoto(s,attachment),denied);
  cookie=tokens.get(accountant.userId)!;
  const noStorage=mock.method(globalThis,"fetch",async()=>{throw new Error("Photo denial must precede storage access");});
  try {
    const download=await photoGET(new Request(`http://127.0.0.1/api/tickets/photos/${attachment}`),{params:Promise.resolve({id:attachment})});
    assert.equal(download.status,404);assert.equal(download.headers.get("location"),null);
    const upload=await photoSignPOST(new Request("http://127.0.0.1/api/tickets/photos/sign",{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticketId:ticket,fileName:"private.png",mime:"image/png",size:42}),
    }));
    assert.equal(upload.status,403);assert.deepEqual(await upload.json(),{ok:false,error:"errors.forbidden"});
    assert.equal(noStorage.mock.callCount(),0);
  } finally {noStorage.mock.restore();}
  const rawRows=await tx(s.userId,async c=>({
    files:(await c.query(`SELECT id,file_name,storage_path FROM files WHERE id=$1`,[file])).rows,
    photos:(await c.query(`SELECT id FROM ticket_attachments WHERE ticket_id=$1`,[ticket])).rows,
    count:(await c.query(`SELECT count(*)::int n FROM ticket_attachments WHERE ticket_id=$1`,[ticket])).rows[0].n,
    audit:(await c.query(`SELECT * FROM audit_log WHERE org_id=$1`,[ORG_ID])).rows,
  }),{orgId:ORG_ID,environment:"live"});
  assert.deepEqual(rawRows,{files:[],photos:[],count:0,audit:[]});
  assert.deepEqual((await loadAuditScreen(s,{})).entries,[]);
  assert.equal((await resolveCustomRoleSession(admin)).customRole?.audit,true);
});

test("privilege catalog: private RLS, immutable history, pinned definers, service-only gateways",async()=>{
  const tables=["b017_roles","b017_role_revisions","b017_assignments","b017_governance_receipts"];
  for(const table of tables){
    const r=(await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass`,[`app.${table}`])).rows[0];assert.equal(r.relrowsecurity,true);
    for(const role of ["anon","authenticated","service_role"])for(const priv of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE"])
      assert.equal((await db.query(`SELECT has_table_privilege($1,$2,$3) allowed`,[role,`app.${table}`,priv])).rows[0].allowed,false);
  }
  const funcs=(await db.query(`SELECT p.oid,p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('b017_authorize','b017_resolve','b017_create_role','b017_revise_role','b017_retire_role','b017_assign_role','b017_unassign_role','b017_assignment_grants','b017_change_member')`)).rows;
  assert.equal(funcs.length,9);
  for(const f of funcs){
    assert.equal(f.prosecdef,true);assert.ok(f.proconfig.includes('search_path=pg_catalog, public, app'));
    for(const role of ["anon","authenticated","service_role"])
      assert.equal((await db.query(`SELECT has_function_privilege($1,$2::oid,'EXECUTE') allowed`,[role,f.oid])).rows[0].allowed,role==="service_role");
  }
  await assert.rejects(raw(admin,`SELECT * FROM app.b017_roles`,[],db,"service_role"),denied);
  await assert.rejects(raw(admin,`SELECT public.b017_create_role($1,$2,$3,$4,$5)`,[ORG_ID,admin.userId,admin.sessionId,randomUUID(),["props.view"]],db,"authenticated"),denied);
});

test("retained Maintenance assignment cannot exceed a limited inviter ceiling", async () => {
  const previous = process.env.TEAM_INVITES_ORG_ALLOWLIST;
  process.env.TEAM_INVITES_ORG_ALLOWLIST = ORG_ID;
  try {
    await flag(false);
    await db.query("UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2", [ORG_ID, manager.userId]);
    await db.query("UPDATE org_members SET role='maintenance' WHERE org_id=$1 AND user_id=$2", [ORG_ID, accountant.userId]);
    manager.role = "admin"; accountant.role = "maintenance";
    await flag(true);
    await assign(await create(["team.manage", "settings.edit", "tickets.update"]), manager);
    const retained = await create(["tenants.contact"]); await assign(retained, accountant);
    await db.query("UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$2", [ORG_ID, accountant.userId]);
    const email = (await db.query("SELECT email FROM auth.users WHERE id=$1", [accountant.userId])).rows[0].email;
    await assert.rejects(inviteMember(await resolveCustomRoleSession(manager), {email, name:"Fixture", role:"maintenance"}), denied);
    assert.equal((await db.query("SELECT status FROM org_members WHERE org_id=$1 AND user_id=$2", [ORG_ID, accountant.userId])).rows[0].status, "removed");
    assert.equal((await db.query("SELECT role_id FROM app.b017_assignments WHERE org_id=$1 AND user_id=$2", [ORG_ID, accountant.userId])).rows[0].role_id, retained);
  } finally { if(previous===undefined) delete process.env.TEAM_INVITES_ORG_ALLOWLIST; else process.env.TEAM_INVITES_ORG_ALLOWLIST=previous; }
});

test("authorized assignment receipt precedes retired/revised target validation and conflicts", async () => {
  const role = await create(["props.view"]), memberId = await member(manager), requestId = randomUUID();
  const command = {operation:"assign" as const, roleId:role, memberId, requestId};
  const receipt = await governCustomRole(admin, command);
  for (const operation of ["revise", "retire"] as const) {
    await governCustomRole(admin, {operation, roleId:role, grants:["props.edit"], requestId:randomUUID()});
    const before = await counts();
    assert.deepEqual(await governCustomRole(admin, command), receipt);
    assert.deepEqual(await counts(), before);
    await assert.rejects(governCustomRole(admin, {...command, memberId:await member(accountant)}), denied);
  }
  await db.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [admin.sessionId]);
  await assert.rejects(governCustomRole(admin, command), denied);
});

test("route admission and payment/bank readers use current session grants", async () => {
  const role = await create(["bank.reconcile"]); await assign(role,accountant);
  const s = await resolveCustomRoleSession(accountant);
  assert.equal(noPermHref("/m/payments",s), "/m/noperm?need=pay.record");
  assert.equal(noPermHref("/m/bank",s), null);
  await assert.rejects(listPayments(s), denied);
  assert.ok(Array.isArray(await listMatches(s)));
  // Full bank page also calls these native-role-only gates.
  await bankMatchingEnabled(s);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"bank_matching":true}' WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='bank_matching'`,[ORG_ID]);
  assert.equal(await bankMatchingEnabled(s),true);
  assert.ok(await bankBoard(s));
  await governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()});
  await assert.rejects(listMatches(s), denied);
  assert.equal(noPermHref("/m/bank",await resolveCustomRoleSession(accountant)), "/m/noperm?need=bank.reconcile");
  await flag(false);
  const native = await resolveCustomRoleSession(accountant);
  assert.equal(noPermHref("/m/payments",native), null);
  assert.equal(noPermHref("/m/bank",native), null);
  assert.ok(Array.isArray(await listPayments(native)));
});

test("monthly API and transactional writers reject stale/retired Accountant with operation flags ON", async () => {
  const role = await create(["stmt.generate", "props.view"]); await assign(role,accountant);
  const cached = await resolveCustomRoleSession(accountant);
  cookie = tokens.get(accountant.userId)!;
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true,"monthly_rent_posting":true}' WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('billing_previews','monthly_rent_posting')`,[ORG_ID]);
  const leaseId=(await db.query("SELECT id FROM leases WHERE org_id=$1 LIMIT 1",[ORG_ID])).rows[0].id;
  const input={leaseId,month:"2028-02",requestId:randomUUID(),expectedDigest:"0".repeat(64)};
  const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM invoices) invoices,(SELECT count(*) FROM ledger_transactions) ledger,(SELECT count(*) FROM app.b008_monthly_rent_commands) commands,(SELECT count(*) FROM app.tenant_period_due_components) components`)).rows;
  const before=await counts();
  for (const operation of ["revise", "retire"] as const) {
    await governCustomRole(admin,{operation,roleId:role,grants:["stmt.generate"],requestId:randomUUID()});
    const response=await monthlyPOST(new Request("http://127.0.0.1/api/monthly-rent-issue",{method:"POST",headers:{origin:"http://127.0.0.1",host:"127.0.0.1","content-type":"application/json"},body:JSON.stringify(input)}));
    assert.equal(response.status,403);
    await assert.rejects(writeMonthlyRent(cached,input),denied);
    await assert.rejects(writeMonthlyRent(accountant,input),denied);
    await assert.rejects(recordPeriodDueComponent(cached,{leaseId,periodYm:"2028-02",component:{componentKey:randomUUID(),amountMinor:"100",currency:"TWD",sourceRefKind:"manual",sourceRefId:randomUUID()}}),denied);
    assert.deepEqual(await counts(),before);
  }
});

for (const revoke of ["retire", "reassign", "session"] as const) test(`photo sharing rejects ${revoke} committed during observed ticket lock wait`,async()=>{
  const role=await create(["tickets.update"]);await assign(role);
  const cached=await resolveCustomRoleSession(manager);
  const ticketId=(await db.query("SELECT id FROM maintenance_tickets WHERE org_id=$1 AND status NOT IN ('closed','cancelled') LIMIT 1",[ORG_ID])).rows[0].id;
  const holder=new Client({connectionString:clone.url});await holder.connect();
  __setVendorLinkKillSwitchForTests(true);
  let pending: Promise<unknown> | undefined;
  try {
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"vendor_link":true,"vendor_dispatch":true}' WHERE id=$1`,[ORG_ID]);
    const {jobId}=await dispatchVendor(admin,ticketId,{vendorName:`B017-${randomUUID()}`,vendorPhone:"0912000111",vendorTrade:"plumbing",contactWindow:"Monday"},"http://127.0.0.1");
    const file=randomUUID(),attachment=randomUUID();
    await db.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,uploaded_by,size_bytes) VALUES($1,$2,'ticket-photos-private',$3,'fixture.png','image/png',$4,42)`,[file,ORG_ID,`org/${ORG_ID}/tickets/${ticketId}/${file}.png`,admin.userId]);
    await db.query(`INSERT INTO ticket_attachments(id,org_id,ticket_id,file_id) VALUES($1,$2,$3,$4)`,[attachment,ORG_ID,ticketId,file]);
    const before=(await db.query("SELECT sharing_approved_at,shared_description FROM repair_vendor_jobs WHERE id=$1",[jobId])).rows;
    await holder.query("BEGIN");await holder.query("SELECT 1 FROM maintenance_tickets WHERE id=$1 FOR UPDATE",[ticketId]);
    pending=assert.rejects(approveVendorSharing(cached,ticketId,jobId,{description:"Must not share",attachmentIds:[attachment]}),denied);
    let waiting=false;
    for(let i=0;i<150;i++) {
      waiting=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%maintenance_tickets%' AND pid<>pg_backend_pid()) AS waiting`)).rows[0].waiting;
      if(waiting) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,"writer must be observed waiting on the ticket");
    if(revoke==="retire")await governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()});
    else if(revoke==="reassign")await assign(await create(["props.view"]));
    else await db.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[manager.sessionId]);
    await holder.query("COMMIT");await pending;
    assert.deepEqual((await db.query("SELECT sharing_approved_at,shared_description FROM repair_vendor_jobs WHERE id=$1",[jobId])).rows,before);
    assert.equal((await db.query("SELECT count(*)::int n FROM repair_vendor_job_shared_photos WHERE job_id=$1",[jobId])).rows[0].n,0);
  } finally {await holder.query("ROLLBACK");await holder.end();if(pending)await pending;__setVendorLinkKillSwitchForTests(false);}
});

test("durable authority lock holds session revocation until transaction completes",async()=>{
  await assign(await create(["tickets.update"]));
  const actor=await resolveCustomRoleSession(manager), contender=new Client({connectionString:clone.url});await contender.connect();
  try {
    await svc(actor.userId,async client=>{
      await assertCustomAuthorityOn(client,actor,"tickets.update",true);
      await contender.query("SET lock_timeout='100ms'");
      await assert.rejects(contender.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[actor.sessionId]),(e:unknown)=>(e as {code:string}).code==="55P03");
    });
    await contender.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[actor.sessionId]);
  } finally {await contender.end();}
});

test("custom_roles registry pins default OFF and all runtime/platform/org gates",()=>{
  const registry=readFileSync("ops/flags.yaml","utf8").split("\n  custom_roles:\n")[1];
  assert.ok(registry);
  for(const field of ["owner: Ron","default: false","ring: internal","expires_at:","global_kill:","org_override:","CUSTOM_ROLES_ORG_ALLOWLIST","platform_settings.custom_roles.enabled","organizations.feature_flags.custom_roles","strict boolean true"])assert.ok(registry.includes(field),field);
});

test("complete OFF session and member request SQL/parameters/results match 80b0d6a",async()=>{
  await flag(false);delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  const files:string[]=[];
  async function baseline(name:string){
    const filename=`${process.cwd()}/src/server/.b017-baseline-${name}-${randomUUID()}.ts`;files.push(filename);
    writeFileSync(filename,execFileSync("git",["show",`80b0d6a:src/server/${name}.ts`],{encoding:"utf8"}));
    return import(pathToFileURL(filename).href);
  }
  const original=Client.prototype.query;
  let trace:unknown[]=[];
  let connections=0;
  const originalConnect=Client.prototype.connect;
  const connectionTracker=mock.method(Client.prototype,"connect",function(this:Client,...args:unknown[]){
    connections++;return Reflect.apply(originalConnect,this,args);
  });
  const tracker=mock.method(Client.prototype,"query",function(this:Client,...args:unknown[]){
    trace.push(args.slice(0,2));return Reflect.apply(original,this,args);
  });
  async function capture(fn:()=>Promise<unknown>){trace=[];connections=0;const result=await fn();return {result,trace:[...trace],connections};}
  try {
    const oldSession=await baseline("session"), oldAuth=await baseline("auth"), oldQueries=await baseline("queries"), oldWriter=await baseline("monthly-rent-writer"), oldBank=await baseline("bank-matching");
    for(const user of [admin,manager,accountant,await session(USERS.maintenance,"maintenance"),await session(USERS.tenant,null)]) {
      cookie=tokens.get(user.userId)!;
      assert.deepEqual(await capture(()=>readSessionOn(db,{touch:false})),await capture(()=>oldSession.readSessionOn(db,{touch:false})));
    }
    cookie=tokens.get(manager.userId)!;
    assert.deepEqual(
      await capture(async()=>{const loaded=await readSessionOn(db);return listPayments(loaded.session!);}),
      await capture(async()=>{const loaded=await oldSession.readSessionOn(db);return oldQueries.listPayments(loaded.session!);}),
    );
    const invalid={leaseId:randomUUID(),month:"2028-03",requestId:randomUUID(),expectedDigest:"0".repeat(64)};
    assert.deepEqual(await capture(()=>writeMonthlyRent(admin,invalid)),await capture(()=>oldWriter.writeMonthlyRent(admin,invalid)));
    assert.deepEqual(await capture(()=>bankBoard(admin)),await capture(()=>oldBank.bankBoard(admin)));
    const sandboxLoad={seedSample:false,session:{...admin,environment:"sandbox" as const,needsSandbox:true,consent:buildStoredConsent("signup")}};
    await completeSession(sandboxLoad); // Provision once; compare the same complete request next.
    assert.deepEqual(await capture(()=>completeSession(sandboxLoad)),await capture(()=>oldSession.completeSession(sandboxLoad)));
    const memberId=await member(manager);
    assert.deepEqual(await capture(()=>setMemberRole(admin,memberId,"manager")),await capture(()=>oldAuth.setMemberRole(admin,memberId,"manager")));
    // Already active is an idempotent full request, including org/seat lock and audit.
    assert.deepEqual(await capture(()=>setMemberActive(admin,memberId,true)),await capture(()=>oldAuth.setMemberActive(admin,memberId,true)));
  } finally {tracker.mock.restore();connectionTracker.mock.restore();for(const file of files)unlinkSync(file);}
});

test("current custom authority positively issues a monthly invoice and reauthorizes its receipt",async()=>{
  const role=await create(["props.view","stmt.view","stmt.generate"]);await assign(role,accountant);
  cookie=tokens.get(accountant.userId)!;
  const actor=(await readSessionOn(db,{touch:false})).session!;
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true,"monthly_rent_posting":true}' WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('billing_previews','monthly_rent_posting')`,[ORG_ID]);
  const property=(await db.query(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id`,[ORG_ID,randomUUID()])).rows[0].id;
  const unit=(await db.query(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'Fixture') RETURNING id`,[ORG_ID,property])).rows[0].id;
  const leaseId=(await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,due_day) VALUES($1,$2,$3,$3,'active','2028-01-01','TWD',100000,15) RETURNING id`,[ORG_ID,property,unit])).rows[0].id;
  const contact=(await db.query(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,'Fixture') RETURNING id`,[ORG_ID])).rows[0].id;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,leaseId,contact]);
  const preview=await monthlyRentPreview(actor,leaseId,"2028-02");assert.ok(preview?.kind==="supported");
  const input={leaseId,month:"2028-02",requestId:randomUUID(),expectedDigest:preview.operation.digest};
  const response=await monthlyPOST(new Request("http://127.0.0.1/api/monthly-rent-issue",{method:"POST",headers:{origin:"http://127.0.0.1",host:"127.0.0.1","content-type":"application/json"},body:JSON.stringify(input)}));
  assert.equal(response.status,200);assert.equal((await response.json()).status,"created");
  assert.equal((await writeMonthlyRent(actor,input)).status,"created");
  await governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()});
  await assert.rejects(writeMonthlyRent(actor,input),denied);
  assert.equal((await db.query("SELECT count(*)::int n FROM invoices WHERE lease_id=$1",[leaseId])).rows[0].n,1);
});


test("native-role flow writers reject current restriction and retired cached authority",async()=>{
  const role=await create(["props.view"]);await assign(role);
  const cached=await resolveCustomRoleSession(manager);
  const before=(await db.query("SELECT count(*)::int n FROM payments")).rows;
  for(const actor of [cached,manager]) {
    await assert.rejects(recordPayment(actor,{leaseId:randomUUID(),amountMajor:1,paidOn:"2028-02-01",last5:"12345",reference:"fixture"}),denied);
    await assert.rejects(confirmPayment(actor,randomUUID()),denied);
    await assert.rejects(setMeterSerial(actor,randomUUID(),"Fixture"),denied);
  }
  await governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()});
  await assert.rejects(confirmPayment(cached,randomUUID()),denied);
  await assert.rejects(createProperty(await resolveCustomRoleSession(manager),{} as Parameters<typeof createProperty>[1]),denied);
  assert.deepEqual((await db.query("SELECT count(*)::int n FROM payments")).rows,before);
});

test("durable disable removes cached added grants at transactional authorization",async()=>{
  const cached={...manager, customRole:{orgId:manager.orgId,userId:manager.userId,sessionId:manager.sessionId,nativeRole:manager.role,keys:["stmt.generate"] as const,photos:false,audit:false}};
  await flag(false);
  await assert.rejects(svc(cached.userId,c=>assertCustomAuthorityOn(c,cached,"stmt.generate")),denied);
  await svc(admin.userId,c=>assertCustomAuthorityOn(c,admin,"stmt.generate"));
});

test("monthly API returns 403 when session is revoked during an observed writer wait",async()=>{
  await assign(await create(["stmt.generate"]),accountant);
  cookie=tokens.get(accountant.userId)!;
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true,"monthly_rent_posting":true}' WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('billing_previews','monthly_rent_posting')`,[ORG_ID]);
  const leaseId=(await db.query("SELECT id FROM leases WHERE org_id=$1 LIMIT 1",[ORG_ID])).rows[0].id;
  const input={leaseId,month:"2028-02",requestId:randomUUID(),expectedDigest:"0".repeat(64)};
  const holder=new Client({connectionString:clone.url});await holder.connect();
  let pending:Promise<Response>|undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[ORG_ID,`${accountant.userId}:${input.requestId}`]);
    pending=monthlyPOST(new Request("http://127.0.0.1/api/monthly-rent-issue",{method:"POST",headers:{origin:"http://127.0.0.1",host:"127.0.0.1","content-type":"application/json"},body:JSON.stringify(input)}));
    // Attach a rejection handler immediately so a failure cannot become unhandled.
    void pending.catch(()=>{});
    let waiting=false;
    for(let i=0;i<150;i++) {
      waiting=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(hashtext%' AND pid<>pg_backend_pid()) AS waiting`)).rows[0].waiting;
      if(waiting)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true);
    await db.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[accountant.sessionId]);
    await holder.query("COMMIT");
    assert.equal((await pending).status,403);
  } finally {await holder.query("ROLLBACK");await holder.end();if(pending)await pending;}
});


test("remaining native-role API boundaries reject retired durable authority",async()=>{
  const role=await create(["leases.edit","tenants.contact","pay.record","tickets.update","props.view"]);await assign(role);
  const cached=await resolveCustomRoleSession(manager);
  await governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()});
  const current=await resolveCustomRoleSession(manager);
  assert.equal(canReviewId(current),false);
  assert.equal(management(current),false);
  assert.equal(staffRoleMayDownloadSignedPdf(current),false);
  for(const actor of [cached,manager]) {
    await assert.rejects(readHandover(actor,randomUUID()),denied);
    await assert.rejects(paymentRequestStatus(actor,randomUUID(),randomUUID()),denied);
    await assert.rejects(queueManualReminder(actor,randomUUID(),randomUUID(),randomUUID()),denied);
    await assert.rejects(reviewIdCheck(actor,randomUUID(),"checked"),denied);
    await assert.rejects(svc(actor.userId,c=>requireEsignOrganization(c,actor,true,true)),denied);
    assert.deepEqual(await editDirectoryContact(actor,{requestId:randomUUID(),contactId:randomUUID(),expected:"fixture",name:"Fixture",email:"fixture@example.invalid",phone:""}),{status:"unavailable"});
  }
  cookie=tokens.get(manager.userId)!;
  const response=await flowPOST(new Request("http://127.0.0.1/api/flows/confirmPayment",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({paymentId:randomUUID()})}),{params:Promise.resolve({action:"confirmPayment"})});
  assert.equal(response.status,403);
});

// Round 3: restriction-only regression cases, including observed lock waits.
import { prepareUtilityRun, confirmUtilityRun, voidUtilityRun } from "./utility-posting";
import { tenantDirectory, tenantDirectoryHistory } from "./tenant-directory";
import { saveRepairRecord } from "./repairs";
import { recordOwnerTransfer, reverseOwnerTransfer, ownerTransferView } from "./owner-transfers";
import { ensureSandbox } from "./sandbox";
import { customAuthorityAllowsOn, guardEffectiveSession } from "./b017-custom-role-governance";
import StatementsPage from "@/app/m/statements/page";

async function waitThenChange<T>(lockSql: string, args: unknown[], operation: () => Promise<T>, change: () => Promise<unknown>) {
  const holder = new Client({connectionString:process.env.DATABASE_URL}); await holder.connect();
  let pending: Promise<T> | undefined;
  try {
    await holder.query("BEGIN"); await holder.query(lockSql,args);
    const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    pending=operation(); void pending.catch(()=>{});
    let waited=false;
    for(let i=0;i<200;i++) {
      waited=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) waited",[pid])).rows[0].waited;
      if(waited) break; await new Promise(r=>setTimeout(r,10));
    }
    assert.equal(waited,true,"the real operation must wait on the owned database lock");
    await change(); await holder.query("COMMIT");
    return await pending;
  } finally {await holder.query("ROLLBACK"); await holder.end(); if(pending) await Promise.allSettled([pending]);}
}

test("R3 utility prepare/confirm/void deny zero grants and recheck after a run-lock wait",async()=>{
  await assign(await create([])); const zero=await resolveCustomRoleSession(manager);
  const input={unitId:randomUUID(),periodStart:"2029-01-01",periodEnd:"2029-02-01",rateMajor:1,totalKwh:1,readings:[],billTotalMajor:1,overrideReason:""};
  await assert.rejects(prepareUtilityRun(zero,input),denied);
  await assert.rejects(confirmUtilityRun(zero,randomUUID()),denied);
  await assert.rejects(voidUtilityRun(zero,randomUUID(),"Correction"),denied);
  const prepRole=await create(["leases.edit"]);await assign(prepRole);const prepActor=await resolveCustomRoleSession(manager);
  const unitId=(await db.query("SELECT id FROM units WHERE org_id=$1 AND archived_at IS NULL LIMIT 1",[ORG_ID])).rows[0].id;
  await assert.rejects(waitThenChange("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[ORG_ID,unitId],
    ()=>prepareUtilityRun(prepActor,{...input,unitId}),()=>governCustomRole(admin,{operation:"retire",roleId:prepRole,requestId:randomUUID()})),denied);
  for(const voiding of [false,true]) {
    const role=await create(["leases.edit"]); await assign(role); const actor=await resolveCustomRoleSession(manager), id=randomUUID();
    await assert.rejects(waitThenChange("SELECT pg_advisory_xact_lock(hashtext($1))",[`utility-post:${id}`],
      ()=>voiding?voidUtilityRun(actor,id,"Correction"):confirmUtilityRun(actor,id),
      ()=>governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()})),denied);
  }
});

test("R3 directory admission, contact projection and contact search use current grants",async()=>{
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_directory_edit":true}' WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='tenant_directory_edit'`,[ORG_ID]);
  const id=(await db.query(`INSERT INTO contacts(org_id,is_tenant,display_name,email,phone_e164) VALUES($1,true,'Directory fixture','private-r3@example.invalid','+886912345678') RETURNING id`,[ORG_ID])).rows[0].id;
  const role=await create(["props.view"]); await assign(role); const cached=await resolveCustomRoleSession(manager);
  const byName=await tenantDirectory(cached,{q:"Directory fixture"}); assert.equal(byName.state,"enabled");
  if(byName.state!=="enabled") throw new Error("Directory unavailable");
  assert.equal(byName.canViewContact,false); assert.ok(byName.rows.length);
  assert.equal(byName.rows[0].email,null);assert.equal(byName.rows[0].phone,null);
  const hidden=await tenantDirectory(cached,{q:"private-r3@example.invalid"});
  assert.ok(hidden.state==="enabled");assert.equal(hidden.total,0);
  const history=await tenantDirectoryHistory(cached,id);assert.ok(history.state==="enabled");assert.equal(history.contact?.email,null);assert.equal(history.canViewContact,false);
  await assign(await create(["props.view","tenants.contact"]));
  const visible=await tenantDirectory(await resolveCustomRoleSession(manager),{q:"private-r3@example.invalid"});
  assert.ok(visible.state==="enabled");assert.equal(visible.rows[0].email,"private-r3@example.invalid");
  await assign(await create([]));await assert.rejects(tenantDirectory(cached),denied);
});

test("R3 repair expense rechecks both permissions after the ticket lock",async()=>{
  const role=await create(["tickets.update","exp.add"]);await assign(role);const cached=await resolveCustomRoleSession(manager);
  const ticket=(await db.query(`SELECT id,status::text FROM maintenance_tickets WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0];
  const before=(await db.query("SELECT count(*)::int n FROM expenses")).rows;
  const input={status:ticket.status,note:"",internal:true,vendorName:"",estimated:"",finalCost:"10",costBearer:"owner",scheduledOn:"",completedOn:"",postExpense:true};
  await assert.rejects(waitThenChange("SELECT id FROM maintenance_tickets WHERE id=$1 FOR UPDATE",[ticket.id],
    ()=>saveRepairRecord(cached,ticket.id,input),()=>assignAfterCreate(["tickets.update"])),denied);
  assert.deepEqual((await db.query("SELECT count(*)::int n FROM expenses")).rows,before);
});
async function assignAfterCreate(keys:string[]) {return assign(await create(keys));}

test("R3 owner-transfer record/replay/reverse reauthorize after the period wait",async()=>{
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"owner_transfers":true}' WHERE id=$1`,[ORG_ID]);
  await db.query(`INSERT INTO platform_settings(key,value) VALUES('owner_transfers',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[ORG_ID]);
  const option=(await ownerTransferView(admin))!.options[0];assert.ok(option);
  const scope={userId:accountant.userId,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live" as const};
  const input={requestId:randomUUID(),propertyId:option.propertyId,ownerId:option.ownerId,effectiveDate:"2090-01-01",amount:"12",reference:"Fixture",expectedCurrency:option.currency,expectedMinorUnit:option.minorUnit};
  await assign(await create(["month.close"]),accountant);
  assert.equal((await recordOwnerTransfer(await resolveCustomRoleSession(accountant),input,scope)).state,"recorded");
  for(const mode of ["record","replay","reverse"] as const) {
    const role=await create(["month.close"]);await assign(role,accountant);const cached=await resolveCustomRoleSession(accountant),requestId=randomUUID();
    const result=await waitThenChange<{state:string}>("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`condola:owner-transfer-month:${ORG_ID}`],
      ()=>mode==="reverse"?reverseOwnerTransfer(cached,{requestId,originalId:input.requestId,effectiveDate:"2090-02-01",reason:"Correction"},scope):recordOwnerTransfer(cached,mode==="replay"?input:{...input,requestId},scope),
      ()=>governCustomRole(admin,{operation:"retire",roleId:role,requestId:randomUUID()}));
    assert.equal(result.state,"unavailable");assert.equal((await db.query("SELECT id FROM ledger_transactions WHERE id=$1",[requestId])).rowCount,0);
  }
});

test("R3 durable OFF readers reject cached added grants and honor current native role",async()=>{
  const poisoned={...manager,customRole:{orgId:ORG_ID,userId:manager.userId,sessionId:manager.sessionId,nativeRole:manager.role,keys:["bank.reconcile"] as const,photos:false,audit:false}};
  await flag(false);
  assert.equal(await svc(manager.userId,c=>customAuthorityAllowsOn(c,poisoned,"bank.reconcile")),false);
  await assert.rejects(bankBoard(poisoned),denied);
  assert.equal(await svc(accountant.userId,c=>customAuthorityAllowsOn(c,accountant,"bank.reconcile")),true);
});

test("R3 admitted durable OFF sandbox uses live-parent membership without a copied member",async()=>{
  await flag(false);const sandboxId=await ensureSandbox(admin);
  await db.query("DELETE FROM org_members WHERE org_id=$1 AND user_id=$2",[sandboxId,manager.userId]);
  process.env.CUSTOM_ROLES_ORG_ALLOWLIST=JSON.stringify([ORG_ID,sandboxId]);
  const sandbox={...manager,orgId:sandboxId,environment:"sandbox" as const};
  await svc(manager.userId,c=>c.query("SELECT public.b017_authorize($1,$2,$3,$4,false)",[sandboxId,manager.userId,manager.sessionId,"props.edit"]));
  const resolved=await svc(manager.userId,c=>c.query("SELECT public.b017_resolve($1,$2,$3) a",[sandboxId,manager.userId,manager.sessionId]));
  assert.equal(resolved.rows[0].a.nativeRole,"manager");
  assert.equal(await guardEffectiveSession(sandbox,"props.edit"),sandbox);
});

test("R3 cross-base assignments are rejected at SQL boundary; effective policy intersects native",async()=>{
  for(const [actor,key] of [[accountant,"props.edit"],[manager,"stmt.generate"],[manager,"bank.reconcile"]] as const) {
    const role=await create([key]);await assert.rejects(assign(role,actor),denied);
    await assert.rejects(raw(admin,"SELECT public.b017_assign_role($1,$2,$3,$4,$5,$6)",[ORG_ID,admin.userId,admin.sessionId,randomUUID(),role,await member(actor)]),/cross-base grants deferred/);
    assert.equal(can({...actor,customRole:{orgId:ORG_ID,userId:actor.userId,sessionId:actor.sessionId,nativeRole:actor.role,keys:[key],photos:false,audit:false}},key),false);
  }
});

test("R3 statement-only role renders statements without querying optional property/owner lists",async()=>{
  await assign(await create(["stmt.view"]));cookie=tokens.get(manager.userId)!;
  // Use real local consent evidence so this exercises the actual page.
  const record=buildStoredConsent("signup");
  await db.query("INSERT INTO public.consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)",[manager.userId,record.accepted_at,record.terms_version,record.privacy_version,record.source]);
  const runtime=globalThis as typeof globalThis & {React?: typeof React}; const previous=runtime.React; runtime.React=React;
  try {assert.ok(await StatementsPage({searchParams:Promise.resolve({month:"2028-02"})}));}
  finally {if(previous)runtime.React=previous;else Reflect.deleteProperty(runtime,"React");}
});


test("R3 durable OFF replaces cached restrictions at the actual reader boundary",async()=>{
  await assign(await create([]),accountant);
  const cached=await resolveCustomRoleSession(accountant);
  await flag(false);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"bank_matching":true}' WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='bank_matching'`,[ORG_ID]);
  assert.ok(await bankBoard(cached));
  const restored=await guardEffectiveSession(cached,null);
  assert.equal(restored.customRole,undefined);
  assert.equal(restored.role,"accountant");
  assert.equal(can(restored,"bank.reconcile"),true);
});


test("R3 an unmapped entry fails closed only for current custom assignments",async()=>{
  await assign(await create(["props.view"]));
  const cached=await resolveCustomRoleSession(manager);
  await assert.rejects(guardEffectiveSession(cached,null),denied);
  await assert.rejects(svc(cached.userId,c=>assertCustomAuthorityOn(c,cached,null)),denied);
  await governCustomRole(admin,{operation:"unassign",memberId:await member(manager),requestId:randomUUID()});
  assert.equal((await guardEffectiveSession(manager,null)).customRole?.assigned,false);
  await svc(manager.userId,c=>assertCustomAuthorityOn(c,manager,null));
});
