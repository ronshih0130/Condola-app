import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { createLease } from "./domain";
import { FlowError } from "./errors";
import { ensureSandbox } from "./sandbox";
import { createLeaseFromForm } from "./lease-form";
import { lockFreshLeaseTarget } from "./lease-target";
import { vacantRooms } from "./queries";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import type { Session } from "./types";
import { disposableDbUrl } from "./test-disposable-db";
import { cloneTestDatabase } from "./test-database-clone";
import { resetAndSeed } from "./seed";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
const archiveSessions = {admin:randomUUID(),manager:randomUUID()};
test.before(async()=>{
  clone=await cloneTestDatabase();
  const savedDemo=process.env.DEMO_MODE;
  const keyNames=["ID_DOC_ENCRYPTION_KEY","ID_DOC_HMAC_KEY","ID_DOC_SIGNING_SECRET","CRON_SECRET"] as const;
  const savedKeys=Object.fromEntries(keyNames.map(key=>[key,process.env[key]]));
  try {
    process.env.DEMO_MODE="true";
    for(const key of keyNames) process.env[key]=randomBytes(32).toString("hex");
    await resetAndSeed();
    for(const role of ['admin','manager'] as const) await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')`,[archiveSessions[role],USERS[role],randomUUID()]);
  } finally {
    if(savedDemo===undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE=savedDemo;
    for(const key of keyNames) { const value=savedKeys[key]; if(value===undefined) delete process.env[key]; else process.env[key]=value; }
  }
});
test.after(async()=>{await clone?.cleanup();});

const staff = (role: "admin" | "manager"): Session => ({ userId: USERS[role], sessionId: archiveSessions[role], email: "", name: role, kind: "staff", role, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "en", calendar: "gregorian", leaseId: null });
async function fixture(org = ORG_ID) {
  const property = (await query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`, [org, `B015 ${randomUUID()}`])).rows[0].id;
  const unit = (await query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES($1,$2,'B015','by_room',1000000) RETURNING id::text`, [org, property])).rows[0].id;
  const room = (await query<{ id: string }>(`INSERT INTO rooms(org_id,unit_id,label,base_rent_minor) VALUES($1,$2,'B015 room',1000000) RETURNING id::text`, [org, unit])).rows[0].id;
  const whole = (await query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES($1,$2,'B015 whole','whole_unit',1000000) RETURNING id::text`, [org, property])).rows[0].id;
  return { property, unit, room, whole };
}
function input(roomId: string, key = randomUUID()) {
  return { roomId, tenantName: `B015 ${key}`, tenantPhone: "0912345678", tenantEmail: "", lineUserId: "", startDate: "2094-01-01", endDate: "2094-12-31", rentMajor: 10000, depositMonths: 2, depositReason: "", dueDay: 5, splitMethod: "even" as const, periodStart: "2094-01-01", periodEnd: "2094-01-31", billTotalMajor: null, usageKwh: null, rateMajor: null, rateSource: "bill_average" as const, overrideReason: "", subUsages: [], idempotencyKey: key };
}
async function snapshot(property: string) {
  return (await query(`SELECT (SELECT count(*)::int FROM leases WHERE property_id=$1) leases,
    (SELECT count(*)::int FROM lease_signatures s JOIN leases l ON l.id=s.lease_id WHERE l.property_id=$1) signatures,
    (SELECT count(*)::int FROM invoices WHERE property_id=$1) invoices,
    (SELECT count(*)::int FROM contacts WHERE org_id=$2) contacts,
    (SELECT count(*)::int FROM auth.users) users`, [property, ORG_ID])).rows[0];
}
const notFound = (error: unknown) => error instanceof FlowError && error.key === "errors.notFound";
const target = (s: Session, id: string) => tx(s.userId, c => lockFreshLeaseTarget(c, s.orgId, id), { orgId: s.orgId, environment: s.environment });

test("fresh target and picker reject archived ancestry for admin and manager", async () => {
  const f = await fixture();
  for (const role of ["admin", "manager"] as const) {
    const s = staff(role);
    assert.equal((await target(s, f.room)).id, f.room);
    assert.equal((await target(s, f.whole)).id, f.whole);
    assert.ok((await vacantRooms(s)).some(x => x.id === f.room));
    await query(`UPDATE properties SET archived_at=now() WHERE id=$1`, [f.property]);
    const before = await snapshot(f.property);
    await assert.rejects(() => createLease(s, input(f.room)), notFound);
    await assert.rejects(() => createLease(s, input(f.whole)), notFound);
    assert.deepEqual(await snapshot(f.property), before);
    assert.ok(!(await vacantRooms(s)).some(x => x.id === f.room || x.id === f.whole));
    await query(`UPDATE properties SET archived_at=NULL WHERE id=$1`, [f.property]);
    await query(`UPDATE units SET archived_at=now() WHERE id=$1`, [f.unit]);
    await assert.rejects(() => target(s, f.room), notFound);
    assert.ok(!(await vacantRooms(s)).some(x => x.id === f.room));
    await query(`UPDATE units SET archived_at=NULL WHERE id=$1`, [f.unit]);
    await query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [f.room]);
    await assert.rejects(() => target(s, f.room), notFound);
    await query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [f.room]);
  }
  const other = await fixture(ORG2_ID);
  await assert.rejects(() => target(staff("admin"), other.room), notFound);
  await query(`UPDATE units SET rental_mode='whole_unit' WHERE id=$1`, [f.unit]);
  await assert.rejects(() => target(staff("admin"), f.room), notFound);
});

test("fresh create and form denial leave no new records; existing request replay survives archive", async () => {
  const f = await fixture(); const s = staff("admin");
  await query(`UPDATE properties SET archived_at=now() WHERE id=$1`, [f.property]);
  const before = await snapshot(f.property);
  const form = new FormData();
  for (const [key,value] of Object.entries({ roomId:f.room, tenantName:"B015 form", tenantPhone:"0912345678", startDate:"2094-01-01", months:"12", rent:"10000", depositMonths:"2", dueDay:"5" })) form.set(key,value);
  await assert.rejects(() => createLeaseFromForm(s, form), notFound);
  await assert.rejects(() => createLease(s, input(f.room)), notFound);
  assert.deepEqual(await snapshot(f.property), before);
  await query(`UPDATE properties SET archived_at=NULL WHERE id=$1`, [f.property]);
  const request = input(f.room); const first = await createLease(s, request);
  await query(`UPDATE properties SET archived_at=now() WHERE id=$1`, [f.property]);
  const again = await createLease(s, request);
  assert.equal(again.leaseId, first.leaseId); assert.equal(again.reused, true);
});

async function waitForBlocked(blockerPid:number, sqlFragment:string, exclude:number[] = []) {
  return withClient(async observer => {
    for (let n=0; n<100; n++) {
      await observer.query(`SELECT pg_catalog.pg_stat_clear_snapshot()`);
      const rows=(await observer.query<{pid:number}>(`SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname=current_database() AND $1=ANY(pg_blocking_pids(a.pid))
          AND NOT(a.pid=ANY($2::int[])) AND a.query LIKE $3 ORDER BY a.pid`,[blockerPid,exclude,`%${sqlFragment}%`])).rows;
      if (rows.length === 1) return rows[0].pid;
      if (rows.length > 1) throw new Error("More than one blocked witness");
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error(`did not observe owned blocked ${sqlFragment}`);
  });
}
async function bounded<T>(promise:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Operation did not drain")),10000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
async function coordinated(run:(holder:import("pg").Client,start:<T>(p:Promise<T>)=>Promise<T>)=>Promise<void>) {
  await withClient(async holder=>{
    const jobs:Promise<unknown>[]=[];let failure:unknown,failed=false;
    const start=<T>(p:Promise<T>)=>{p.catch(()=>{});jobs.push(p);return p;};
    try{await holder.query("BEGIN");await run(holder,start);}catch(error){failure=error;failed=true;}
    const cleanup:unknown[]=[];
    try{await holder.query("ROLLBACK");}catch(error){cleanup.push(error);try{await holder.end();}catch(closeError){cleanup.push(closeError);}}
    try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
    if(failed&&cleanup.length)throw new AggregateError([failure,...cleanup],"Operation and cleanup failed");
    if(failed)throw failure;
    if(cleanup.length)throw new AggregateError(cleanup,"Cleanup failed");
  });
}

test("archive first waits then fresh create rejects; rollback allows fresh create", async () => {
  for (const commit of [true,false]) {
    const f=await fixture(), unrelated=await fixture(); const s=staff("admin");
    await coordinated(async (blocker,start)=>{
      await blocker.query(`UPDATE properties SET archived_at=now() WHERE id=$1`,[f.property]);
      const pid=(await blocker.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending=start(createLease(s,input(f.room)));
      await waitForBlocked(pid,"FROM properties WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR SHARE");
      assert.equal((await bounded(start(target(s,unrelated.room)))).id,unrelated.room);
      await blocker.query(commit ? "COMMIT" : "ROLLBACK");
      if (commit) await assert.rejects(bounded(pending), notFound); else assert.equal((await bounded(pending)).reused,false);
    });
  }
});

test("fresh create retains ancestry lock until commit and archive UPDATE waits", async () => {
  const f=await fixture(); const s=staff("manager");
  const contact=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND is_tenant AND user_id IS NOT NULL AND archived_at IS NULL LIMIT 1`,[ORG_ID])).rows[0];
  assert.ok(contact);
  await coordinated(async (holding,start)=>{
    await holding.query(`SELECT id FROM contacts WHERE id=$1 FOR UPDATE`,[contact.id]);
    const holderPid=(await holding.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const pending=start(createLease(s,{...input(f.room),tenantContactId:contact.id}));
    const createPid=await waitForBlocked(holderPid,"FROM contacts");
    const archive=start(query(`UPDATE properties SET archived_at=now() WHERE id=$1`,[f.property]));
    const archivePid=await waitForBlocked(createPid,"UPDATE properties SET archived_at=now()",[holderPid]);
    assert.notEqual(archivePid,createPid);
    await holding.query("COMMIT");
    const created=await bounded(pending); assert.equal(created.reused,false); await bounded(archive);
    const linked=await query(`SELECT 1 FROM lease_parties WHERE lease_id=$1 AND contact_id=$2`,[created.leaseId,contact.id]);
    assert.equal(linked.rowCount,1);
  });
});

test("recent pending return remains historical after property archive", async () => {
  const f=await fixture(); const s=staff("admin");
  const request={...input(f.room),idempotencyKey:""};
  const first=await createLease(s,request); await query(`UPDATE properties SET archived_at=now() WHERE id=$1`,[f.property]);
  const replay=await createLease(s,request); assert.equal(replay.leaseId,first.leaseId); assert.equal(replay.reused,true);
});

test("fresh whole-unit create succeeds, and non-admitted staff cannot create", async () => {
  const f=await fixture();
  const denied={...staff("admin"),userId:USERS.accountant,role:"accountant" as const};
  const before=await snapshot(f.property);
  await assert.rejects(()=>createLease(denied,input(f.whole)));
  assert.deepEqual(await snapshot(f.property),before);
  const created=await createLease(staff("manager"),input(f.whole));
  assert.equal(created.reused,false);
  const rows=await query<{target:string}>(`SELECT target_unit_id::text AS target FROM leases WHERE id=$1`,[created.leaseId]);
  assert.equal(rows.rows[0].target,f.whole);
});

test("unit moved during parent wait fails closed after locks", async () => {
  const f=await fixture(), other=await fixture(); const s=staff("admin");
  await query(`UPDATE units SET label=$2 WHERE id=$1`,[other.unit,`B015 destination ${randomUUID()}`]);
  await coordinated(async (parent,start)=>{
    await parent.query(`UPDATE properties SET name=name WHERE id=$1`,[f.property]);
    const pid=(await parent.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const pending=start(target(s,f.room));
    await waitForBlocked(pid,"FROM properties WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR SHARE");
    await query(`UPDATE units SET property_id=$2 WHERE id=$1`,[f.unit,other.property]);
    await parent.query("COMMIT");
    await assert.rejects(bounded(pending), notFound);
  });
});

test("sandbox manager and admin retain scoped ancestry checks", async () => {
  const live=staff("admin"); const org=await ensureSandbox(live); const f=await fixture(org);
  for (const role of ["admin","manager"] as const) {
    const s={...staff(role),orgId:org,liveOrgId:ORG_ID,environment:"sandbox" as const};
    assert.equal((await target(s,f.room)).id,f.room);
    await query(`UPDATE units SET archived_at=now() WHERE id=$1`,[f.unit]);
    await assert.rejects(()=>target(s,f.room),notFound);
    await query(`UPDATE units SET archived_at=NULL WHERE id=$1`,[f.unit]);
  }
});


test("an ineligible colliding room does not shadow an eligible whole-unit UUID", async () => {
  const f=await fixture();
  await query(`INSERT INTO rooms(id,org_id,unit_id,label,archived_at) VALUES($1,$2,$3,'colliding',now())`,[f.whole,ORG_ID,f.unit]);
  const s=staff("admin");
  const found=await target(s,f.whole.replaceAll("-",""));
  assert.equal(found.id,f.whole); assert.equal(found.kind,"whole_unit");
  await query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`,[f.whole]);
  await query(`UPDATE units SET rental_mode='whole_unit' WHERE id=$1`,[f.unit]);
  const wrongMode=await target(s,`{${f.whole}}`);
  assert.equal(wrongMode.id,f.whole); assert.equal(wrongMode.kind,"whole_unit");
});
