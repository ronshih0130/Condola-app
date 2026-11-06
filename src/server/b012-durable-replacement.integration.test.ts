import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import type { Session } from "./types";
import { leaseLifecycleView, submitLeaseReplacement, recordLeaseNotice, respondLeaseNotice, type NoticeInput } from "./lease-lifecycle";
import { compareRenewal, renewalComparisonView } from "./renewal-comparison";
import type { RenewalInput } from "@/lib/renewal-comparison";
import { createLease } from "./domain";
import { FlowError } from "./errors";
import { archiveCommand, archiveScope, archiveView } from "./record-archive";
import type { ArchiveRef } from "@/lib/record-archive";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
let staff: Session, tenant: Session, otherTenant: Session, owner: Session, otherStaff: Session;
let savedGlobal: string | null, savedOrg: string;
test.before(async () => {
  clone = await cloneTestDatabase();
  await resetAndSeed();
  db = new Client({ connectionString: clone.url }); await db.connect();
  staff = await session(USERS.manager, "staff", "manager");
  tenant = await session(USERS.tenant, "tenant", null);
  otherTenant = await session(USERS.tenant2, "tenant", null);
  owner = await session(USERS.owner, "owner", null);
  otherStaff = await session(USERS.coastAdmin, "staff", "admin", ORG2_ID);
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });
test.beforeEach(async () => {
  savedGlobal = (await db.query(`SELECT to_jsonb(f)::text AS row FROM platform_settings f WHERE key='lease_renewal'`)).rows[0]?.row ?? null;
  savedOrg = (await db.query(`SELECT feature_flags::text AS flags FROM organizations WHERE id=$1`, [ORG_ID])).rows[0].flags;
  await controls({ enabled: true, allowed_org_ids: [ORG_ID] }, true);
});
test.afterEach(async () => {
  await db.query(`DELETE FROM platform_settings WHERE key='lease_renewal'`);
  if (savedGlobal !== null) await db.query(`INSERT INTO platform_settings SELECT * FROM jsonb_populate_record(NULL::platform_settings,$1::jsonb)`, [savedGlobal]);
  await db.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`, [ORG_ID, savedOrg]);
});
async function session(userId: string, kind: Session["kind"], role: Session["role"], orgId = ORG_ID): Promise<Session> {
  const sid = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sid, userId, randomUUID()]);
  return { userId, sessionId: sid, orgId, liveOrgId: orgId, kind, role, environment: "live", locale: "en", calendar: "gregorian", leaseId: null, email: "synthetic@example.test", name: "Synthetic" };
}
async function controls(global: unknown, org: unknown) {
  await db.query(`DELETE FROM platform_settings WHERE key='lease_renewal'`);
  if (global !== undefined) await db.query(`INSERT INTO platform_settings(key,value) VALUES('lease_renewal',$1::jsonb)`, [JSON.stringify(global)]);
  await db.query(`UPDATE organizations SET feature_flags=(feature_flags-'lease_renewal') || $2::jsonb WHERE id=$1`, [ORG_ID, JSON.stringify(org === undefined ? {} : { lease_renewal: org })]);
}
async function fixture(room = false) {
  const property = (await db.query(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES($1,'B012 synthetic','US','USD','UTC',$2) RETURNING id`, [ORG_ID, room ? "by_room" : "whole_unit"])).rows[0].id as string;
  const unit = (await db.query(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'B012 synthetic',$3) RETURNING id`, [ORG_ID, property, room ? "by_room" : "whole_unit"])).rows[0].id as string;
  const roomId = room ? (await db.query(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'A') RETURNING id`, [ORG_ID, unit])).rows[0].id as string : null;
  const lease = (await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor,rent_frequency,due_day,deposit_amount_minor)
    VALUES($1,$2,$3,$4,$5,'ended','2030-01-01','2030-12-31','USD',10000,'monthly',1,20000) RETURNING id`, [ORG_ID, property, unit, room ? null : unit, roomId])).rows[0].id as string;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) SELECT $1,$2,id,'primary' FROM contacts WHERE org_id=$1 AND user_id=$3 LIMIT 1`, [ORG_ID, lease, USERS.tenant]);
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) SELECT $1,$2,id,'2020-01-01' FROM contacts WHERE org_id=$1 AND user_id=$3 AND is_owner LIMIT 1`, [ORG_ID, property, USERS.owner]);
  return { property, unit, lease, roomId };
}
const proposal: RenewalInput = { startDate: "2031-01-01", endMode: "date", endDate: "2031-12-31", rent: "450.00", frequency: "quarterly", dueDay: "15", deposit: "250.00" };
const terms = { startDate: "2031-01-01", endDate: "2031-12-31", rentMinor: "45000", depositMinor: "25000", frequency: "quarterly", dueDay: 15, currency: "USD", minorUnit: 2 };
const submitSql = `SELECT app.b012_submit_replacement($1,$2,$3,$4,$5::jsonb) AS result`;
function submitArgs(lease: string, request = randomUUID()) { return [ORG_ID, staff.sessionId, lease, request, JSON.stringify(terms)]; }
async function begin(c: Client, s: Session) {
  await c.query("BEGIN");
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [s.userId, s.orgId, s.environment]);
  await c.query("SET LOCAL ROLE authenticated");
}
async function raw(s: Session, sql: string, params: unknown[] = []) {
  await begin(db, s);
  try { const r = await db.query(sql, params); await db.query("COMMIT"); return r; }
  catch (error) { await db.query("ROLLBACK"); throw error; }
}
async function snapshot(c = db) {
  const tables = (await c.query(`SELECT schemaname,tablename FROM pg_tables WHERE (schemaname IN ('public','app') AND tablename<>'auth_sessions') OR (schemaname='auth' AND tablename='users') ORDER BY schemaname,tablename`)).rows;
  const result: Record<string, string[]> = {};
  for (const { schemaname, tablename } of tables) {
    assert.match(schemaname + tablename, /^[a-z0-9_]+$/);
    result[`${schemaname}.${tablename}`] = (await c.query(`SELECT to_jsonb(t)::text AS row FROM "${schemaname}"."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.row);
  }
  return result;
}
function notice(overrides: Partial<NoticeInput> = {}): NoticeInput {
  return { recordId: randomUUID(), expectedVersion: 0, kind: "renewal_intent", source: "self_report", occurredOn: null, effectiveOn: null, body: "Synthetic intent", ...overrides };
}
async function leaseRow(id: string) { return (await db.query(`SELECT to_jsonb(l)::text AS row FROM leases l WHERE id=$1`, [id])).rows[0].row as string; }

async function waitForBlocked(blocker: number, fragment: string) {
  for (let i = 0; i < 100; i++) {
    await db.query(`SELECT pg_stat_clear_snapshot()`);
    const rows = (await db.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
      AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`, [blocker, `%${fragment}%`])).rows;
    assert.ok(rows.length <= 1, "one identified waiter");
    if (rows.length === 1) return rows[0].pid as number;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`No blocked witness for ${fragment}`);
}
async function coordinated(run: (a: Client, b: Client, start: <T>(p: Promise<T>) => Promise<T>) => Promise<void>) {
  const a = new Client({ connectionString: clone.url }), b = new Client({ connectionString: clone.url });
  const jobs: Promise<unknown>[] = [];
  const start = <T>(p: Promise<T>) => { p.catch(() => {}); jobs.push(p); return p; };
  await a.connect(); await b.connect();
  try { await run(a, b, start); }
  finally {
    // Release the first holder before draining a potentially blocked query.
    await a.query("ROLLBACK");
    await b.query("ROLLBACK");
    await Promise.allSettled(jobs);
    await a.end(); await b.end();
  }
}
const pidOf = async (c: Client) => (await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
async function creationInput(f: Awaited<ReturnType<typeof fixture>>) {
  const contact = (await db.query(`SELECT contact_id FROM lease_parties WHERE lease_id=$1 AND role='primary'`, [f.lease])).rows[0].contact_id as string;
  return { roomId: f.roomId ?? f.unit, tenantContactId: contact, tenantName: "Synthetic", tenantPhone: "", tenantEmail: "", lineUserId: "",
    startDate: terms.startDate, endDate: terms.endDate, rentMajor: 450, depositMonths: 1, depositReason: "", dueDay: 15,
    splitMethod: "even" as const, periodStart: "2031-01-01", periodEnd: "2031-01-31", billTotalMajor: null, usageKwh: null,
    rateMajor: null, rateSource: "bill_average" as const, overrideReason: "", subUsages: [], idempotencyKey: randomUUID() };
}

test("durable submission copies parties, uses exact minor units and replays without any writes", async () => {
  const f = await fixture(), request = randomUUID(), before = await leaseRow(f.lease);
  const result = await submitLeaseReplacement(staff, f.lease, request, proposal);
  assert.equal(result.state, "submitted"); if (result.state !== "submitted") return;
  assert.equal(await leaseRow(f.lease), before);
  const row = JSON.parse(await leaseRow(result.leaseId));
  assert.equal(row.previous_lease_id, f.lease); assert.equal(row.status, "pending_signature");
  assert.equal(row.esign_status, "not_sent"); assert.equal(row.signed_at, null);
  const view = await leaseLifecycleView(tenant, result.leaseId);
  assert.equal(view?.leases.length, 2);
  assert.equal(view?.leases.find(l => l.id === result.leaseId)?.rentMinor, "45000");
  assert.equal(view?.leases.find(l => l.id === result.leaseId)?.depositMinor, "25000");
  const saved = await snapshot();
  assert.deepEqual(await submitLeaseReplacement(staff, f.lease, request, proposal), { state: "replayed", leaseId: result.leaseId });
  assert.deepEqual(await snapshot(), saved);
  assert.equal((await submitLeaseReplacement(staff, f.lease, request, { ...proposal, dueDay: "16" })).state, "conflict");
  assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), proposal)).state, "conflict");
  assert.deepEqual(await snapshot(), saved);
  const audit = (await db.query(`SELECT new_row FROM audit_log WHERE row_id=$1 AND event_type='lease_replacement_submitted'`, [f.lease])).rows;
  assert.deepEqual(audit.map(a => a.new_row), [{ replacementId: result.leaseId }]);
});

test("authoritative submission rejects a conflict inserted after a clear advisory comparison", async () => {
  const f = await fixture();
  const view = await renewalComparisonView(staff, f.lease); assert.ok(view);
  const compared = await compareRenewal(staff, f.lease, view.fingerprint, proposal);
  assert.equal(compared.state, "ready"); if (compared.state === "ready") assert.equal(compared.overlap, false);
  await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$3,'active','2031-12-31','2032-01-01','USD',10000)`, [ORG_ID, f.property, f.unit]);
  const before = await snapshot();
  assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), proposal)).state, "overlap");
  assert.equal((await raw(staff, submitSql, submitArgs(f.lease))).rows[0].result.state, "overlap");
  assert.deepEqual(await snapshot(), before);
});

test("two connections competing on one predecessor block at its row; exactly one commits", async () => {
  const f = await fixture(), a = new Client({ connectionString: clone.url }), b = new Client({ connectionString: clone.url });
  await a.connect(); await b.connect();
  let waiting: Promise<import("pg").QueryResult> | undefined;
  try {
    const pid = (await b.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    await begin(a, staff); await begin(b, staff);
    const won = (await a.query(submitSql, submitArgs(f.lease))).rows[0].result;
    assert.equal(won.state, "submitted");
    waiting = b.query(submitSql, submitArgs(f.lease));
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      if ((await db.query(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`, [pid])).rows[0].blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "second connection actually waited on the first transaction");
    await a.query("COMMIT");
    assert.equal((await waiting).rows[0].result.state, "conflict"); await b.query("COMMIT");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.b012_replacements WHERE predecessor_id=$1`, [f.lease])).rows[0].n, 1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM leases WHERE previous_lease_id=$1`, [f.lease])).rows[0].n, 1);
  } finally {
    await a.query("ROLLBACK"); await waiting?.catch(() => {}); await b.query("ROLLBACK"); await a.end(); await b.end();
  }
});

test("draft leases stay staff-only: tenant and owner views and writes are denied with zero writes", async () => {
  const f = await fixture(), n = notice();
  const status = (await db.query(`SELECT status::text FROM leases WHERE id=$1`, [f.lease])).rows[0].status;
  await db.query(`ALTER TABLE leases DISABLE TRIGGER USER`);
  try { await db.query(`UPDATE leases SET status='draft' WHERE id=$1`, [f.lease]); } finally { await db.query(`ALTER TABLE leases ENABLE TRIGGER USER`); }
  try {
    const before = await snapshot();
    for (const s of [tenant, owner]) {
      assert.equal(await leaseLifecycleView(s, f.lease), null);
      assert.equal((await raw(s, `SELECT app.b012_lifecycle_view($1,$2,$3,$4) AS result`, [ORG_ID, s.sessionId, s.kind, f.lease])).rows[0].result, null);
      assert.equal((await recordLeaseNotice(s, f.lease, n)).state, "unavailable");
      assert.equal((await respondLeaseNotice(s, f.lease, { recordId: n.recordId, noticeVersion: 1, expectedVersion: 0, response: "agree", body: "" })).state, "unavailable");
    }
    assert.deepEqual(await snapshot(), before);
    assert.ok(await leaseLifecycleView(staff, f.lease), "staff still see the draft");
  } finally {
    await db.query(`ALTER TABLE leases DISABLE TRIGGER USER`);
    try { await db.query(`UPDATE leases SET status=$2::lease_status WHERE id=$1`, [f.lease, status]); } finally { await db.query(`ALTER TABLE leases ENABLE TRIGGER USER`); }
  }
});

test("owner expiry is exclusive for lifecycle reads, notice creation/correction and responses", async () => {
  const f = await fixture(), n = notice();
  await db.query(`UPDATE property_owners SET effective_to=current_date+1 WHERE property_id=$1`, [f.property]);
  assert.equal((await raw(owner, `SELECT app.is_property_owner($1) AS allowed`, [f.property])).rows[0].allowed, true);
  assert.ok(await leaseLifecycleView(owner, f.lease));
  assert.equal((await recordLeaseNotice(owner, f.lease, n)).state, "recorded");
  const response = { recordId: n.recordId, noticeVersion: 1, expectedVersion: 0, response: "agree" as const, body: "" };
  assert.equal((await respondLeaseNotice(owner, f.lease, response)).state, "recorded");
  for (const days of [0, -1]) {
    await db.query(`UPDATE property_owners SET effective_to=current_date+$2::int WHERE property_id=$1`, [f.property, days]);
    const before = await snapshot();
    assert.equal((await raw(owner, `SELECT app.is_property_owner($1) AS allowed`, [f.property])).rows[0].allowed, false);
    assert.equal(await leaseLifecycleView(owner, f.lease), null);
    assert.equal((await raw(owner, `SELECT app.b012_lifecycle_view($1,$2,'owner',$3) AS result`, [ORG_ID, owner.sessionId, f.lease])).rows[0].result, null);
    for (const input of [notice(), { ...n, expectedVersion: 1, body: "Correction" }]) {
      assert.equal((await recordLeaseNotice(owner, f.lease, input)).state, "unavailable");
      assert.equal((await raw(owner, `SELECT app.b012_record_notice($1,$2,'owner',$3,$4,$5,'renewal_intent','self_report',NULL,NULL,$6) AS result`,
        [ORG_ID, owner.sessionId, f.lease, input.recordId, input.expectedVersion, input.body])).rows[0].result.state, "unavailable");
    }
    assert.equal((await respondLeaseNotice(owner, f.lease, { ...response, expectedVersion: 1 })).state, "unavailable");
    assert.equal((await raw(owner, `SELECT app.b012_respond_notice($1,$2,'owner',$3,$4,1,1,'disagree','') AS result`,
      [ORG_ID, owner.sessionId, f.lease, n.recordId])).rows[0].result.state, "unavailable");
    assert.deepEqual(await snapshot(), before);
  }
});

for (const kind of ["property", "unit", "room"] as const) {
  test(`archived ${kind} rejects fresh replacement without writes; historical replay remains available`, async () => {
    const f = await fixture(true), table = kind === "property" ? "properties" : kind === "unit" ? "units" : "rooms";
    const id = kind === "property" ? f.property : kind === "unit" ? f.unit : f.roomId;
    await db.query(`UPDATE ${table} SET archived_at=clock_timestamp() WHERE id=$1`, [id]);
    const before = await snapshot();
    assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), proposal)).state, "unavailable");
    assert.equal((await raw(staff, submitSql, submitArgs(f.lease))).rows[0].result.state, "unavailable");
    assert.deepEqual(await snapshot(), before);
    await db.query(`UPDATE ${table} SET archived_at=NULL WHERE id=$1`, [id]);
    const request = randomUUID(), result = await submitLeaseReplacement(staff, f.lease, request, proposal);
    assert.equal(result.state, "submitted"); if (result.state !== "submitted") return;
    await db.query(`UPDATE ${table} SET archived_at=clock_timestamp() WHERE id=$1`, [id]);
    const saved = await snapshot();
    assert.deepEqual(await submitLeaseReplacement(staff, f.lease, request, proposal), { state: "replayed", leaseId: result.leaseId });
    assert.deepEqual(await snapshot(), saved);
  });

  for (const archiveFirst of [true, false]) test(`${kind} archive and replacement serialize with ${archiveFirst ? "archive" : "replacement"} first`, async () => {
    const f = await fixture(true), table = kind === "property" ? "properties" : kind === "unit" ? "units" : "rooms";
    const ref: ArchiveRef = { kind, id: kind === "property" ? f.property : kind === "unit" ? f.unit : f.roomId! };
    const savedArchive = (await db.query(`SELECT to_jsonb(f)::text AS row FROM platform_settings f WHERE key='record_archive'`)).rows[0]?.row;
    await db.query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"record_archive":true}'::jsonb WHERE id=$1`, [ORG_ID]);
    try {
      const view = await archiveView(staff, ref); assert.equal(view.state, "ready"); if (view.state !== "ready") return;
      assert.equal(view.canArchive, true);
      const input = { ref, desired: "archived" as const, expectedVersion: view.observed.version, renderedScope: archiveScope(staff), reason: "Synthetic archive", requestId: randomUUID() };
      await coordinated(async (a, b, start) => {
        if (archiveFirst) {
          await a.query("BEGIN");
          await a.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [ref.id]);
          const archiving = start(archiveCommand(staff, input));
          const archivePid = await waitForBlocked(await pidOf(a), `SELECT id FROM public.${table}`);
          await begin(b, staff);
          const submitPid = await pidOf(b);
          const pending = start(b.query(submitSql, submitArgs(f.lease)));
          assert.equal(await waitForBlocked(archivePid, "b012_submit_replacement"), submitPid);
          await a.query("COMMIT");
          assert.equal((await archiving).state, "changed");
          assert.equal((await pending).rows[0].result.state, "unavailable");
          const won = await snapshot();
          await b.query("COMMIT");
          assert.deepEqual(await snapshot(), won);
          assert.equal((await db.query(`SELECT count(*)::int AS n FROM leases WHERE previous_lease_id=$1`, [f.lease])).rows[0].n, 0);
        } else {
          await begin(a, staff);
          assert.equal((await a.query(submitSql, submitArgs(f.lease))).rows[0].result.state, "submitted");
          const archiving = start(archiveCommand(staff, input));
          await waitForBlocked(await pidOf(a), "pg_advisory_xact_lock");
          await a.query("RESET ROLE");
          const won = await snapshot(a);
          await a.query("COMMIT");
          assert.equal((await archiving).state, "blocked");
          assert.deepEqual(await snapshot(), won);
        }
      });
    } finally {
      await db.query(`DELETE FROM platform_settings WHERE key='record_archive'`);
      if (savedArchive) await db.query(`INSERT INTO platform_settings SELECT * FROM jsonb_populate_record(NULL::platform_settings,$1::jsonb)`, [savedArchive]);
    }
  });
}

for (const room of [false, true]) for (const creationFirst of [true, false]) {
  test(`actual ${room ? "room" : "whole-unit"} creation and replacement serialize with ${creationFirst ? "creation" : "replacement"} first`, async () => {
    const f = await fixture(room), input = await creationInput(f), old = await leaseRow(f.lease);
    await coordinated(async (a, b, start) => {
      if (creationFirst) {
        // Pause the actual creator only after it has acquired ancestry/target locks.
        await a.query("BEGIN");
        await a.query(`SELECT id FROM contacts WHERE id=$1 FOR UPDATE`, [input.tenantContactId]);
        const creating = start(createLease(staff, input));
        const creatorPid = await waitForBlocked(await pidOf(a), "FROM contacts");
        await begin(b, staff);
        const pending = start(b.query(submitSql, submitArgs(f.lease)));
        await waitForBlocked(creatorPid, "b012_submit_replacement");
        await a.query("COMMIT");
        const created = await creating; assert.equal(created.reused, false);
        assert.equal((await pending).rows[0].result.state, "overlap");
        const won = await snapshot();
        await b.query("COMMIT");
        assert.deepEqual(await snapshot(), won);
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.b012_replacements WHERE predecessor_id=$1`, [f.lease])).rows[0].n, 0);
      } else {
        await begin(a, staff);
        assert.equal((await a.query(submitSql, submitArgs(f.lease))).rows[0].result.state, "submitted");
        const creating = start(createLease(staff, input));
        await waitForBlocked(await pidOf(a), "FROM units");
        await a.query("RESET ROLE");
        const won = await snapshot(a);
        await a.query("COMMIT");
        await assert.rejects(creating, error => error instanceof FlowError && error.key === "errors.roomLease");
        assert.deepEqual(await snapshot(), won);
      }
      assert.equal(await leaseRow(f.lease), old);
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM leases WHERE unit_id=$1 AND status='pending_signature'`, [f.unit])).rows[0].n, 1);
    });
  });
}

for (const room of [false, true]) for (const reverse of [false, true]) {
  test(`distinct predecessors sharing a ${room ? "room" : "whole unit"} serialize in ${reverse ? "reverse" : "forward"} order`, async () => {
    const f = await fixture(room);
    const second = (await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor)
      VALUES($1,$2,$3,$4,$5,'ended','2029-01-01','2029-12-31','USD',10000) RETURNING id`, [ORG_ID, f.property, f.unit, room ? null : f.unit, f.roomId])).rows[0].id as string;
    await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) SELECT org_id,$2,contact_id,role FROM lease_parties WHERE lease_id=$1`, [f.lease, second]);
    const [winner, loser] = reverse ? [second, f.lease] : [f.lease, second];
    await coordinated(async (a, b, start) => {
      await begin(a, staff); await begin(b, staff);
      assert.equal((await a.query(submitSql, submitArgs(winner))).rows[0].result.state, "submitted");
      const pending = start(b.query(submitSql, submitArgs(loser)));
      await waitForBlocked(await pidOf(a), "b012_submit_replacement");
      await a.query("RESET ROLE");
      const won = await snapshot(a);
      await a.query("COMMIT");
      assert.equal((await pending).rows[0].result.state, "overlap");
      await b.query("COMMIT");
      assert.deepEqual(await snapshot(), won);
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM leases WHERE previous_lease_id=$1`, [loser])).rows[0].n, 0);
    });
  });
}

test("completed predecessor and its party identity are immutable even after flag rollback", async () => {
  const f = await fixture(); const result = await submitLeaseReplacement(staff, f.lease, randomUUID(), proposal);
  assert.equal(result.state, "submitted"); if (result.state !== "submitted") return;
  await controls({ enabled: false, allowed_org_ids: [ORG_ID] }, false);
  const before = await snapshot();
  for (const sql of [
    `UPDATE leases SET notes='changed' WHERE id=$1`, `UPDATE leases SET end_date='2030-12-30' WHERE id=$1`,
    `UPDATE leases SET rent_amount_minor=1 WHERE id=$1`, `UPDATE leases SET status='cancelled' WHERE id=$1`,
    `DELETE FROM leases WHERE id=$1`, `DELETE FROM lease_parties WHERE lease_id=$1`,
    `UPDATE lease_parties SET role='occupant' WHERE lease_id=$1`,
  ]) await assert.rejects(db.query(sql, [f.lease]), /immutable/);
  await assert.rejects(db.query(`UPDATE leases SET previous_lease_id=NULL WHERE id=$1`, [result.leaseId]), /immutable/);
  await assert.rejects(db.query(`DELETE FROM app.b012_replacements WHERE predecessor_id=$1`, [f.lease]), /immutable/);
  assert.deepEqual(await snapshot(), before);
});

test("staff and own tenant get linked old/new views; other tenants and other organizations are denied", async () => {
  const f = await fixture(); const result = await submitLeaseReplacement(staff, f.lease, randomUUID(), proposal);
  assert.equal(result.state, "submitted"); if (result.state !== "submitted") return;
  for (const s of [staff, tenant]) for (const id of [f.lease, result.leaseId]) {
    const v = await leaseLifecycleView(s, id); assert.ok(v);
    assert.deepEqual(v.leases.map(l => l.id), [f.lease, result.leaseId]);
    assert.equal(v.leases[0].readOnly, true); assert.equal(v.leases[1].previousLeaseId, f.lease);
  }
  for (const s of [otherTenant, otherStaff, { ...staff, orgId: ORG2_ID }, { ...tenant, sessionId: randomUUID() }]) {
    assert.equal(await leaseLifecycleView(s, f.lease), null);
    assert.equal(await leaseLifecycleView(s, result.leaseId), null);
    assert.equal((await recordLeaseNotice(s, f.lease, notice())).state, "unavailable");
    assert.equal((await submitLeaseReplacement(s, f.lease, randomUUID(), proposal)).state, "unavailable");
  }
  // A link is not itself authority to see the neighboring lease.
  await db.query(`DELETE FROM lease_parties WHERE lease_id=$1`, [result.leaseId]);
  assert.deepEqual((await leaseLifecycleView(tenant, f.lease))?.leases.map(l => l.id), [f.lease]);
  assert.equal(await leaseLifecycleView(tenant, result.leaseId), null);
});

test("notices retain attribution and all versions; only the originating actor can correct", async () => {
  const f = await fixture(), n = notice();
  assert.deepEqual(await recordLeaseNotice(tenant, f.lease, n), { state: "recorded", recordId: n.recordId, version: 1 });
  assert.equal((await recordLeaseNotice(tenant, f.lease, { ...n, expectedVersion: 1, body: "Corrected", occurredOn: "2025-05-01" })).state, "recorded");
  const before = await snapshot();
  assert.equal((await recordLeaseNotice(tenant, f.lease, { ...n, expectedVersion: 1, body: "Stale" })).state, "stale");
  for (const s of [staff, owner, otherTenant, otherStaff]) assert.equal((await recordLeaseNotice(s, f.lease, { ...n, expectedVersion: 2 })).state, "unavailable");
  assert.equal((await recordLeaseNotice(tenant, f.lease, { ...n, expectedVersion: 2, kind: "non_renewal_notice" })).state, "invalid");
  assert.deepEqual(await snapshot(), before);
  const v = await leaseLifecycleView(tenant, f.lease); assert.ok(v);
  assert.deepEqual(v.notices.map(r => [r.version, r.actor_user_id, r.party, r.source, r.occurred_on, r.effective_on, r.body]), [
    [1, USERS.tenant, "tenant", "self_report", null, null, "Synthetic intent"],
    [2, USERS.tenant, "tenant", "self_report", "2025-05-01", null, "Corrected"],
  ]);
  await assert.rejects(db.query(`UPDATE app.b012_notice_versions SET body='rewrite' WHERE record_id=$1`, [n.recordId]), /immutable/);
  await assert.rejects(db.query(`DELETE FROM app.b012_notice_versions WHERE record_id=$1`, [n.recordId]), /immutable/);
});

test("tenant, owner and management respond independently to a specific notice version", async () => {
  const f = await fixture(), n = notice({ kind: "non_renewal_notice" });
  assert.equal((await recordLeaseNotice(tenant, f.lease, n)).state, "recorded");
  const base = { recordId: n.recordId, noticeVersion: 1, expectedVersion: 0, body: "" };
  assert.equal((await respondLeaseNotice(tenant, f.lease, { ...base, response: "agree" })).state, "recorded");
  assert.equal((await respondLeaseNotice(owner, f.lease, { ...base, response: "disagree" })).state, "recorded");
  assert.equal((await respondLeaseNotice(staff, f.lease, { ...base, response: "undecided" })).state, "recorded");
  let v = await leaseLifecycleView(staff, f.lease); assert.ok(v);
  assert.deepEqual(v.responses.map(r => [r.party, r.response, r.version, r.notice_version]), [
    ["management", "undecided", 1, 1], ["owner", "disagree", 1, 1], ["tenant", "agree", 1, 1],
  ]);
  assert.equal((await respondLeaseNotice(owner, f.lease, { ...base, response: "agree" })).state, "stale");
  assert.equal((await respondLeaseNotice(owner, f.lease, { ...base, expectedVersion: 1, response: "agree" })).state, "recorded");
  assert.equal((await recordLeaseNotice(tenant, f.lease, { ...n, expectedVersion: 1, body: "Updated notice" })).state, "recorded");
  assert.equal((await respondLeaseNotice(staff, f.lease, { ...base, expectedVersion: 1, response: "agree" })).state, "stale");
  v = await leaseLifecycleView(staff, f.lease); assert.ok(v);
  assert.equal(v.responses.length, 4); assert.ok(v.responses.every(r => r.notice_version === 1));
  assert.equal((await respondLeaseNotice(otherTenant, f.lease, { ...base, response: "agree" })).state, "unavailable");
  const another = await fixture();
  assert.equal((await respondLeaseNotice(staff, another.lease, { ...base, response: "agree" })).state, "unavailable");
  await assert.rejects(db.query(`UPDATE app.b012_response_versions SET response='agree' WHERE record_id=$1`, [n.recordId]), /immutable/);
});

test("concurrent corrections use expected version: only one appends", async () => {
  const f = await fixture(), n = notice();
  assert.equal((await recordLeaseNotice(tenant, f.lease, n)).state, "recorded");
  const results = await Promise.all(["A", "B"].map(body => recordLeaseNotice(tenant, f.lease, { ...n, expectedVersion: 1, body })));
  assert.deepEqual(results.map(r => r.state).sort(), ["recorded", "stale"]);
  assert.equal((await leaseLifecycleView(tenant, f.lease))?.notices.length, 2);
});

test("historical early termination preserves unknown dates and leaves leases, invoices and ledger byte-identical", async () => {
  const f = await fixture();
  await db.query(`UPDATE leases SET end_date=NULL WHERE id=$1`, [f.lease]);
  const contact = (await db.query(`SELECT contact_id FROM lease_parties WHERE lease_id=$1 AND role='primary'`, [f.lease])).rows[0].contact_id;
  const invoice = (await db.query(`INSERT INTO invoices(org_id,property_id,lease_id,bill_to_contact_id,invoice_number,currency,issue_date,due_date,period_start,period_end,status,source,created_by)
    VALUES($1,$2,$3,$4,$5,'USD','2025-01-01','2025-01-15','2025-01-01','2025-01-31','open','recurring',$6) RETURNING id`,
    [ORG_ID, f.property, f.lease, contact, `B012-${randomUUID()}`, USERS.manager])).rows[0].id;
  await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor)
    VALUES($1,$2,1,'rent','Synthetic historical rent',1,10000,10000)`, [ORG_ID, invoice]);
  const transaction = (await db.query(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by)
    VALUES($1,$2,$3,'invoice','USD','2025-01-01','Synthetic historical invoice','invoices',$4,$5) RETURNING id`,
    [ORG_ID, f.property, f.lease, invoice, USERS.manager])).rows[0].id;
  await db.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id)
    VALUES($1,$2,'tenant_receivable',10000,'USD',$3,$4,$5,$6),($1,$2,'rental_income',-10000,'USD',$3,$4,$5,$6)`,
    [ORG_ID, transaction, contact, f.property, f.lease, invoice]);
  await db.query(`UPDATE invoices SET ledger_transaction_id=$2 WHERE id=$1`, [invoice, transaction]);
  const financialRows = async () => ({
    invoices: (await db.query(`SELECT to_jsonb(i)::text AS row FROM invoices i WHERE lease_id=$1 ORDER BY id`, [f.lease])).rows,
    lines: (await db.query(`SELECT to_jsonb(l)::text AS row FROM invoice_lines l WHERE invoice_id=$1 ORDER BY id`, [invoice])).rows,
    transactions: (await db.query(`SELECT to_jsonb(t)::text AS row FROM ledger_transactions t WHERE lease_id=$1 ORDER BY id`, [f.lease])).rows,
    entries: (await db.query(`SELECT to_jsonb(e)::text AS row FROM ledger_entries e WHERE lease_id=$1 AND invoice_id=$2 AND transaction_id=$3 ORDER BY id`, [f.lease, invoice, transaction])).rows,
  });
  const financialBefore = await financialRows();
  assert.deepEqual(Object.values(financialBefore).map(rows => rows.length), [1, 1, 1, 2], "nonempty financial history linked to this lease");
  assert.equal(JSON.parse(financialBefore.invoices[0].row).total_minor, 10000);
  assert.equal(JSON.parse(financialBefore.invoices[0].row).ledger_transaction_id, transaction);
  const before = await snapshot();
  const n = notice({ kind: "early_termination_notice", source: "staff_record", body: "Historical report" });
  assert.equal((await recordLeaseNotice(staff, f.lease, n)).state, "recorded");
  assert.deepEqual(await financialRows(), financialBefore);
  assert.equal((await recordLeaseNotice(staff, f.lease, { ...n, expectedVersion: 1, effectiveOn: "2025-02-01" })).state, "recorded");
  assert.deepEqual(await financialRows(), financialBefore);
  const after = await snapshot();
  for (const key of Object.keys(before)) {
    if (["app.b012_notice_versions", "public.audit_log"].includes(key)) continue;
    assert.deepEqual(after[key], before[key], key);
  }
  const v = await leaseLifecycleView(tenant, f.lease); assert.ok(v);
  assert.equal(v.leases[0].endDate, null);
  assert.deepEqual(v.notices.map(r => [r.occurred_on, r.effective_on]), [[null, null], [null, "2025-02-01"]]);
  assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), proposal)).state, "invalid");
});

test("room replacement permits adjacent dates and an explicitly unknown end without rounding large money", async () => {
  const f = await fixture(true);
  const r = await submitLeaseReplacement(staff, f.lease, randomUUID(), { ...proposal, endMode: "open_ended", endDate: "", frequency: "monthly", rent: "90071992547409.93", deposit: "90071992547409.94" });
  assert.equal(r.state, "submitted"); if (r.state !== "submitted") return;
  const v = await leaseLifecycleView(tenant, r.leaseId); assert.ok(v);
  const added = v.leases.find(l => l.id === r.leaseId); assert.ok(added);
  assert.equal(added.endDate, null); assert.equal(added.rentMinor, "9007199254740993"); assert.equal(added.depositMinor, "9007199254740994");
});

test("missing terms, same-day predecessor boundary and malformed direct calls reject with zero changes", async () => {
  const f = await fixture(), before = await snapshot();
  for (const key of Object.keys(proposal) as (keyof RenewalInput)[]) {
    const invalid = { ...proposal }; delete (invalid as Partial<RenewalInput>)[key];
    assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), invalid)).state, "invalid");
  }
  assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), { ...proposal, startDate: "2030-12-31" })).state, "invalid");
  // Existing deposit policy remains authoritative (quarterly rent has a monthly basis).
  assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), { ...proposal, rent: "123.45" })).state, "invalid");
  for (const bad of [{ ...terms, rentMinor: null }, { ...terms, rentMinor: "9223372036854775808" }, { ...terms, startDate: "2031-02-30" }, { ...terms, endDate: "2030-01-01" }, {}]) {
    assert.equal((await raw(staff, submitSql, [ORG_ID, staff.sessionId, f.lease, randomUUID(), JSON.stringify(bad)])).rows[0].result.state, "invalid");
  }
  assert.deepEqual(await snapshot(), before);
});

test("OFF and malformed control matrix: all server and direct SQL gateways leave every domain row unchanged", async () => {
  const f = await fixture(), n = notice();
  assert.equal((await recordLeaseNotice(tenant, f.lease, n)).state, "recorded");
  const good = { enabled: true, allowed_org_ids: [ORG_ID] };
  const matrix: [unknown, unknown][] = [
    [undefined, true], [null, true], [[], true], [{}, true], [{ ...good, enabled: false }, true],
    [{ ...good, enabled: "true" }, true], [{ enabled: true }, true], [{ ...good, allowed_org_ids: [] }, true],
    [{ ...good, allowed_org_ids: [ORG2_ID] }, true], [{ ...good, allowed_org_ids: [ORG_ID, 1] }, true],
    [{ ...good, allowed_org_ids: [ORG_ID, "bad"] }, true], [{ ...good, allowed_org_ids: {} }, true],
    ...[undefined, false, "true", null, {}, []].map(org => [good, org] as [unknown, unknown]),
  ];
  for (const [global, org] of matrix) {
    await controls(global, org); const before = await snapshot();
    assert.equal(await leaseLifecycleView(staff, f.lease), null);
    assert.equal(await leaseLifecycleView(tenant, f.lease), null);
    assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), proposal)).state, "unavailable");
    assert.equal((await recordLeaseNotice(tenant, f.lease, notice())).state, "unavailable");
    assert.equal((await respondLeaseNotice(owner, f.lease, { recordId: n.recordId, noticeVersion: 1, expectedVersion: 0, response: "agree", body: "" })).state, "unavailable");
    assert.equal((await raw(staff, submitSql, submitArgs(f.lease))).rows[0].result.state, "unavailable");
    assert.equal((await raw(tenant, `SELECT app.b012_record_notice($1,$2,'tenant',$3,$4,0,'renewal_intent','self_report',NULL,NULL,'Synthetic') AS result`, [ORG_ID, tenant.sessionId, f.lease, randomUUID()])).rows[0].result.state, "unavailable");
    assert.equal((await raw(owner, `SELECT app.b012_respond_notice($1,$2,'owner',$3,$4,1,0,'agree','') AS result`, [ORG_ID, owner.sessionId, f.lease, n.recordId])).rows[0].result.state, "unavailable");
    assert.deepEqual(await snapshot(), before, JSON.stringify([global, org]));
  }
});

test("database authorization rejects revoked sessions, forged party, wrong scope and cross-org records", async () => {
  const f = await fixture(), n = notice();
  assert.equal((await recordLeaseNotice(tenant, f.lease, n)).state, "recorded");
  const before = await snapshot();
  assert.equal((await raw(tenant, submitSql, [ORG_ID, tenant.sessionId, f.lease, randomUUID(), JSON.stringify(terms)])).rows[0].result.state, "unavailable");
  assert.equal((await raw(tenant, `SELECT app.b012_record_notice($1,$2,'owner',$3,$4,0,'non_renewal_notice','self_report',NULL,NULL,'Synthetic') AS result`, [ORG_ID, tenant.sessionId, f.lease, randomUUID()])).rows[0].result.state, "unavailable");
  assert.equal((await raw(otherStaff, submitSql, submitArgs(f.lease))).rows[0].result.state, "unavailable");
  assert.equal((await raw({ ...staff, orgId: ORG2_ID }, submitSql, submitArgs(f.lease))).rows[0].result.state, "unavailable");
  assert.equal((await raw(staff, `SELECT app.b012_lifecycle_view($1,$2,'staff',$3) AS result`, [ORG2_ID, staff.sessionId, f.lease])).rows[0].result, null);
  assert.deepEqual(await snapshot(), before);
  const revoked = await session(USERS.manager, "staff", "manager");
  await db.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`, [revoked.sessionId]);
  assert.equal((await submitLeaseReplacement(revoked, f.lease, randomUUID(), proposal)).state, "unavailable");
});

test("simultaneous identical request returns submitted plus replayed, with one audit", async () => {
  const f = await fixture(), request = randomUUID();
  const results = await Promise.all([1, 2].map(() => submitLeaseReplacement(staff, f.lease, request, proposal)));
  assert.deepEqual(results.map(r => r.state).sort(), ["replayed", "submitted"]);
  assert.ok(results.every(r => "leaseId" in r));
  assert.equal((results[0] as { leaseId: string }).leaseId, (results[1] as { leaseId: string }).leaseId);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE row_id=$1 AND event_type='lease_replacement_submitted'`, [f.lease])).rows[0].n, 1);
});

test("room overlap rejects its own room and whole unit but permits a different room", async () => {
  for (const target of ["same", "whole", "sibling"] as const) {
    const f = await fixture(true);
    let room = f.roomId;
    if (target === "sibling") room = (await db.query(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'B') RETURNING id`, [ORG_ID, f.unit])).rows[0].id;
    if (target === "whole") await db.query(`UPDATE units SET rental_mode='whole_unit' WHERE id=$1`, [f.unit]);
    await db.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor)
      VALUES($1,$2,$3,$4,$5,'active','2031-01-01',NULL,'USD',10000)`, [ORG_ID, f.property, f.unit, target === "whole" ? f.unit : null, target === "whole" ? null : room]);
    assert.equal((await submitLeaseReplacement(staff, f.lease, randomUUID(), proposal)).state, target === "sibling" ? "submitted" : "overlap");
  }
});

test("privilege catalog: private RLS tables; only authenticated executes four guarded gateways", async () => {
  const gateways = new Set(["b012_submit_replacement", "b012_record_notice", "b012_respond_notice", "b012_lifecycle_view"]);
  const funcs = (await db.query(`SELECT p.oid,p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'b012_%'`)).rows;
  assert.equal(funcs.length, 11);
  for (const f of funcs) {
    assert.equal(f.prosecdef, true); assert.deepEqual(f.proconfig, ["search_path=pg_catalog, public, app"]);
    for (const role of ["anon", "service_role", "authenticated"]) {
      const yes = (await db.query(`SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS yes`, [role, f.oid])).rows[0].yes;
      assert.equal(yes, role === "authenticated" && gateways.has(f.proname), `${role}:${f.proname}`);
    }
    assert.equal((await db.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1 AND a.grantee=0 AND a.privilege_type='EXECUTE') AS yes`, [f.oid])).rows[0].yes, false);
  }
  for (const table of ["b012_replacements", "b012_notice_versions", "b012_response_versions"]) {
    assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass`, [`app.${table}`])).rows[0].relrowsecurity, true);
    for (const role of ["anon", "authenticated", "service_role"]) for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.equal((await db.query(`SELECT has_table_privilege($1,$2,$3) AS yes`, [role, `app.${table}`, privilege])).rows[0].yes, false, `${role}:${table}:${privilege}`);
    }
    await assert.rejects(raw(staff, `SELECT * FROM app.${table}`), /permission denied/);
    await assert.rejects(db.query(`TRUNCATE app.${table} CASCADE`), /immutable/);
  }
});

// Last test: exercise the actual wipe list with nonempty immutable private rows.
test("demo reset removes B012 private references and frozen predecessors without orphan rows", async () => {
  assert.ok((await db.query(`SELECT count(*)::int AS n FROM app.b012_replacements`)).rows[0].n > 0);
  await resetAndSeed();
  for (const table of ["b012_replacements", "b012_notice_versions", "b012_response_versions"]) {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0].n, 0);
  }
});
