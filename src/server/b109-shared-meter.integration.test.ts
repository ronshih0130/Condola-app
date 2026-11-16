import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
import { saveSharedMeter, sharedMeterView } from "./b109-shared-meter";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-109 ADV-METER (GS-53 = A; MGT-90-AC4…AC6) on a cloned disposable database: the real gateways through
// service_role. Never a pg mock or a grant.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const SAVE = "app.b109_shared_meter_save(uuid,uuid,text,uuid,uuid,uuid,uuid[],text,numeric)";
const VIEW = "app.b109_shared_meter_view(uuid,uuid,text,uuid,uuid)";
const SPLIT = "app.b109_shared_meter_split(uuid,uuid,text,uuid,uuid,date,numeric,bigint)";
const sid: Record<string, string> = {};
const v3 = async () => true;
let property: string, other: string, archivedProperty: string, roomA: string, roomB: string, roomC: string, whole: string, foreignRoom: string;
let next: string, nextEnd: string, thisMonth: string;
type Result = Record<string, unknown> & { status: string };
type Split = { status: string; revision?: number; method?: string; rows?: { id: string; weight: string; kwh: string; amountMinor: string | null }[]; missing?: string[] } | null;
const code = (c: string) => (e: unknown) => ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === c;

async function flag(platform: boolean, org = platform) {
  await db.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text,$3::text)) WHERE key='shared_meter'`, [platform, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('shared_meter',$2::boolean) WHERE id = ANY($1::uuid[])`, [[ORG_ID, ORG2_ID], org]);
}
type Opts = { org?: string; live?: string; env?: string; pin?: string | null };
async function call<T>(fn: string, who: string, args: unknown[], opts: Opts = {}): Promise<T> {
  const org = opts.org ?? ORG_ID, env = opts.env ?? "live";
  return svc(null, async client => {
    if (opts.pin !== null) await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [opts.pin ?? org, env]);
    const params = args.map((_, i) => `$${i + 5}`).join(",");
    return (await client.query(`SELECT ${fn.split("(")[0]}($1,$2,$3,$4,${params}) r`, [org, opts.live ?? org, env, sid[who], ...args])).rows[0].r;
  });
}
const save = (who: string, spaces: string[], method: string, reading: string | number, request = randomUUID(), target = property, opts: Opts = {}) =>
  call<Result>(SAVE, who, [request, target, spaces, method, String(reading)], opts);
const view = (who: string, target = property, opts: Opts = {}) => call<Record<string, unknown> | null>(VIEW, who, [target], opts);
const split = (who: string, period: string, kwh: number | string, amount: number | null = null, target = property, opts: Opts = {}) =>
  call<Split>(SPLIT, who, [target, period, String(kwh), amount === null ? null : String(amount)], opts);
const snapshot = async () => (await db.query(`SELECT
  (SELECT md5(coalesce(string_agg(row_to_json(c)::text,'|' ORDER BY c.id),'')) FROM app.b109_shared_meter_configs c) configs,
  (SELECT md5(coalesce(string_agg(row_to_json(a)::text,'|' ORDER BY a.id),'')) FROM public.audit_log a WHERE a.table_name='b109_shared_meter_configs') audit,
  (SELECT count(*)::int FROM app.b109_shared_meter_configs) n`)).rows[0] as { configs: string; audit: string; n: number };
async function unchanged(label: string, fn: () => Promise<unknown>) { const before = await snapshot(); await fn(); assert.deepEqual(await snapshot(), before, label); }
const session = (who: keyof typeof USERS, role: Session["role"], org = ORG_ID): Session => ({ kind: "staff", role, orgId: org, liveOrgId: org,
  userId: USERS[who], sessionId: sid[who], name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });

async function propertyWith(org: string, name: string) {
  const p = (await db.query(`INSERT INTO public.properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id`, [org, name])).rows[0].id as string;
  return p;
}
async function unit(org: string, prop: string, label: string, mode: "by_room" | "whole_unit") {
  return (await db.query(`INSERT INTO public.units(org_id,property_id,label,rental_mode) VALUES($1,$2,$3,$4::rental_mode) RETURNING id`, [org, prop, label, mode])).rows[0].id as string;
}
const room = async (org: string, unitId: string, label: string) =>
  (await db.query(`INSERT INTO public.rooms(org_id,unit_id,label) VALUES($1,$2,$3) RETURNING id`, [org, unitId, label])).rows[0].id as string;

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
  for (const who of Object.keys(USERS)) {
    sid[who] = randomUUID();
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid[who], USERS[who as keyof typeof USERS], randomUUID()]);
  }
  sid.revoked = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours',clock_timestamp())", [sid.revoked, USERS.admin, randomUUID()]);
  property = await propertyWith(ORG_ID, "民生東路三段 25 號");
  const floor = await unit(ORG_ID, property, "3F", "by_room");
  roomA = await room(ORG_ID, floor, "A"); roomB = await room(ORG_ID, floor, "B"); roomC = await room(ORG_ID, floor, "C");
  whole = await unit(ORG_ID, property, "5F", "whole_unit");
  other = await propertyWith(ORG_ID, "Other");
  foreignRoom = await room(ORG_ID, await unit(ORG_ID, other, "1F", "by_room"), "A");
  archivedProperty = await propertyWith(ORG_ID, "Archived");
  await db.query("UPDATE public.properties SET archived_at=clock_timestamp() WHERE id=$1", [archivedProperty]);
  const m = (await db.query(`SELECT (date_trunc('month',(clock_timestamp() AT TIME ZONE timezone)) + interval '1 month')::date::text n,
    (date_trunc('month',(clock_timestamp() AT TIME ZONE timezone)) + interval '2 month' - interval '1 day')::date::text e,
    date_trunc('month',(clock_timestamp() AT TIME ZONE timezone))::date::text t FROM public.properties WHERE id=$1`, [property])).rows[0];
  next = m.n; nextEnd = m.e; thisMonth = m.t;
});

test.after(async () => {
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("effective privileges: gateways EXECUTE for service_role only; the table has no application privilege", async () => {
  for (const fn of [SAVE, VIEW, SPLIT]) {
    for (const role of ["anon", "authenticated", "service_role"])
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok, role === "service_role", `${role} ${fn}`);
    assert.deepEqual((await db.query("SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [fn])).rows[0],
      { prosecdef: true, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"] });
    for (const role of ["anon", "authenticated"]) {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        const nulls = fn.slice(fn.indexOf("(") + 1, -1).split(",").map(t => `NULL::${t}`).join(",");
        await assert.rejects(db.query(`SELECT ${fn.split("(")[0]}(${nulls})`), { code: "42501" });
      } finally { await db.query("ROLLBACK"); }
    }
  }
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.b109_shared_meter_configs'::regclass")).rows[0].relrowsecurity, true);
  for (const role of ["anon", "authenticated", "service_role"])
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
      assert.equal((await db.query("SELECT has_table_privilege($1,'app.b109_shared_meter_configs',$2) ok", [role, privilege])).rows[0].ok, false, `${role} ${privilege}`);
  assert.deepEqual((await db.query("SELECT value FROM public.platform_settings WHERE key='shared_meter'")).rows[0].value, { enabled: false, allowed_org_ids: [] }, "seeded OFF");
});

test("flag OFF (platform, org, or both) and brand_v3 OFF: no access, nothing written", async () => {
  for (const [platform, org] of [[false, false], [false, true], [true, false]] as const) {
    await flag(platform, org);
    await unchanged(`platform ${platform} org ${org}`, async () => {
      assert.equal(await view("admin"), null);
      assert.deepEqual(await save("admin", [roomA], "even", 10), { status: "disabled" });
      assert.equal(await split("admin", next, 100), null);
      assert.deepEqual(await sharedMeterView(session("admin", "admin"), property, { v3 }), { state: "off" });
      assert.deepEqual(await saveSharedMeter(session("admin", "admin"), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA], method: "even", startReading: "10" }, { v3 }), { ok: false, reason: "off" });
    });
  }
  await flag(true);
  await unchanged("brand_v3 off", async () => {
    assert.deepEqual(await sharedMeterView(session("admin", "admin"), property, { v3: async () => false }), { state: "off" });
  });
  assert.equal((await snapshot()).n, 0);
});

test("MGT-90-AC4: save takes effect from the next period, audited; the view prefills; this period has nothing", async () => {
  await flag(true);
  const v0 = await view("manager");
  assert.ok(v0);
  assert.equal(v0.config, null);
  assert.equal(v0.nextEffectiveFrom, next);
  assert.deepEqual((v0.spaces as { id: string; label: string | null; unitLabel: string }[]).map(s => [s.unitLabel, s.label]), [["3F", "A"], ["3F", "B"], ["3F", "C"], ["5F", null]]);
  const request = randomUUID();
  const r = await save("manager", [roomC, roomA, roomB], "even", "1284", request);
  assert.deepEqual(r, { status: "saved", configId: r.configId, revision: 1, effectiveFrom: next, spaceCount: 3, method: "even", replayed: false });
  const stored = (await db.query("SELECT * FROM app.b109_shared_meter_configs WHERE id=$1", [r.configId])).rows[0];
  assert.deepEqual(stored.space_ids, [roomA, roomB, roomC], "stored in display order");
  assert.equal(stored.start_reading, "1284.000");
  assert.equal(stored.created_by, USERS.manager);
  const audit = (await db.query("SELECT actor_user_id,actor_role,action::text,reason,request_id,new_row FROM public.audit_log WHERE table_name='b109_shared_meter_configs' AND row_id=$1", [r.configId])).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor_user_id, audit[0].actor_role, audit[0].action, audit[0].reason, audit[0].request_id], [USERS.manager, "manager", "insert", "shared_meter_saved", request]);
  assert.deepEqual(audit[0].new_row.effective_from, next);
  // Next-period effect: the current month has no config; the next month uses revision 1.
  assert.deepEqual(await split("admin", thisMonth, 100), { status: "none", period: thisMonth });
  assert.equal((await split("admin", next, 100))!.status, "ready");
  const v1 = await view("admin");
  assert.deepEqual(v1!.config, { revision: 1, spaceIds: [roomA, roomB, roomC], method: "even", startReading: "1284.000", effectiveFrom: next });
  // TS reader and writer, native manager.
  const ts = await sharedMeterView(session("manager", "manager"), property, { v3 });
  if (ts.state !== "ready") assert.fail(ts.state);
  assert.equal(ts.config?.revision, 1);
});

test("idempotent save: the same request replays; another payload under the key conflicts; a new save is a new revision", async () => {
  await flag(true);
  const request = randomUUID();
  const one = await save("admin", [roomA, roomB, roomC], "days_occupied", "1300.5", request);
  assert.equal(one.status, "saved");
  await unchanged("replay and conflict", async () => {
    const again = await save("admin", [roomA, roomB, roomC], "days_occupied", "1300.5", request);
    assert.deepEqual(again, { ...one, replayed: true });
    assert.deepEqual(await save("admin", [roomA, roomB], "days_occupied", "1300.5", request), { status: "conflict" });
    assert.deepEqual(await save("admin", [roomA, roomB, roomC], "even", "1300.5", request), { status: "conflict" });
    assert.deepEqual(await save("manager", [roomA, roomB, roomC], "days_occupied", "1300.5", request), { status: "conflict" });
  });
  assert.equal(one.revision, 2);
  assert.equal(one.effectiveFrom, next);
  const ts = await saveSharedMeter(session("admin", "admin"), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA, roomB, roomC], method: "even", startReading: "1,284" }, { v3 });
  assert.deepEqual(ts, { ok: true, revision: 3, effectiveFrom: next, spaceCount: 3, method: "even", replayed: false });
});

test("split 平均分: shares floored, the remainder to the first room (kWh to 0.001 and minor units)", async () => {
  await flag(true);
  await save("admin", [roomA, roomB, roomC], "even", 0);
  const s = await split("admin", next, 100, 1000);
  assert.equal(s!.status, "ready");
  assert.equal(s!.method, "even");
  assert.deepEqual(s!.rows!.map(r => [r.id, r.weight, r.kwh, r.amountMinor]), [
    [roomA, "1", "33.334", "334"], [roomB, "1", "33.333", "333"], [roomC, "1", "33.333", "333"]]);
  const noAmount = await split("admin", next, "0.002");
  assert.deepEqual(noAmount!.rows!.map(r => [r.kwh, r.amountMinor]), [["0.002", null], ["0.000", null], ["0.000", null]]);
});

test("split 依住的天數分: inclusive lease days in the period; vacant rooms weigh 0; all vacant splits evenly", async () => {
  await flag(true);
  await save("admin", [roomA, roomB, roomC, whole], "days_occupied", 0);
  const days = Number(nextEnd.slice(8));
  const half = `${next.slice(0, 8)}16`;
  for (const [target, start] of [[roomA, next], [roomB, half]] as const)
    await db.query(`INSERT INTO public.leases(org_id,property_id,unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor)
      SELECT $1,$2,r.unit_id,r.id,'active',$4::date,$5::date,'TWD',100000 FROM public.rooms r WHERE r.id=$3`, [ORG_ID, property, target, start, nextEnd]);
  const s = await split("admin", next, 90, 9001);
  const weights = s!.rows!.map(r => Number(r.weight));
  assert.deepEqual(weights, [days, days - 15, 0, 0]);
  const total = weights.reduce((a, b) => a + b, 0);
  const expected = weights.map(w => Math.floor(9001 * w / total));
  expected[0] += 9001 - expected.reduce((a, b) => a + b, 0);
  assert.deepEqual(s!.rows!.map(r => Number(r.amountMinor)), expected);
  assert.equal(s!.rows!.reduce((sum, r) => sum + Number(r.amountMinor), 0), 9001);
  assert.equal(s!.rows!.reduce((sum, r) => sum + Math.round(Number(r.kwh) * 1000), 0), 90000);
  // A later period with nobody living there: all weights 0, split evenly, remainder to the first.
  const far = (await db.query("SELECT ($1::date + interval '3 month')::date::text d", [next])).rows[0].d;
  const empty = await split("admin", far, 10, 10);
  assert.deepEqual(empty!.rows!.map(r => [r.weight, r.amountMinor]), [["1", "4"], ["1", "2"], ["1", "2"], ["1", "2"]]);
});

test("split 依分表度數: each room meter's usage in the period; a missing reading stops the split (never guessed)", async () => {
  await flag(true);
  await save("admin", [roomA, roomB, roomC], "sub_meter", 0);
  const meters: Record<string, string> = {};
  for (const r of [roomA, roomB, roomC])
    meters[r] = (await db.query(`INSERT INTO public.meters(org_id,property_id,unit_id,room_id,utility,usage_unit,payer,split_method,rate_source,rate_minor_per_unit)
      SELECT $1,$2,r.unit_id,r.id,'electricity','kWh','tenant','none','fixed_rate',500 FROM public.rooms r WHERE r.id=$3 RETURNING id`, [ORG_ID, property, r])).rows[0].id;
  const before = (await db.query("SELECT ($1::date - 1)::text d", [next])).rows[0].d;
  const reading = (meter: string, on: string, value: number) =>
    db.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value) VALUES($1,$2,$3,$4)", [ORG_ID, meter, on, value]);
  await reading(meters[roomA], before, 100); await reading(meters[roomA], nextEnd, 160);
  await reading(meters[roomB], before, 50); await reading(meters[roomB], nextEnd, 80);
  await reading(meters[roomC], before, 10);
  const missing = await split("admin", next, 50, 500);
  assert.deepEqual(missing, { status: "missing_readings", period: next, revision: missing!.revision, missing: [roomC] });
  await reading(meters[roomC], nextEnd, 20);
  const s = await split("admin", next, 50, 500);
  assert.deepEqual(s!.rows!.map(r => [r.weight, r.kwh, r.amountMinor]), [["60.000", "30.000", "300"], ["30.000", "15.000", "150"], ["10.000", "5.000", "50"]]);
  // Uneven: 7 kWh / 7 minor units over 60:30:10 floors to 4.2→4.200/4, 2.1→2.100/2, 0.7→0.700/0; the remainder 1 goes to A.
  const odd = await split("admin", next, 7, 7);
  assert.deepEqual(odd!.rows!.map(r => [r.kwh, r.amountMinor]), [["4.200", "5"], ["2.100", "2"], ["0.700", "0"]]);
});

test("invalid input saves nothing", async () => {
  await flag(true);
  await unchanged("invalid", async () => {
    for (const [spaces, method, reading] of [
      [[], "even", "1"], [[roomA, roomA], "even", "1"], [[roomA, foreignRoom], "even", "1"], [[roomA], "none", "1"],
      [[roomA], "even", "-1"], [[roomA], "even", "1.2345"], [[roomA], "even", "100000000000"],
    ] as const) assert.deepEqual(await save("admin", [...spaces], method, reading), { status: "invalid" }, JSON.stringify([spaces, method, reading]));
    await assert.rejects(split("admin", `${next.slice(0, 8)}02`, 1), code("22023"));
    await assert.rejects(split("admin", next, -1), code("22023"));
    for (const bad of [{ spaceIds: [] }, { startReading: "" }, { startReading: "abc" }, { method: "x" }, { spaceIds: ["x"] }])
      assert.deepEqual(await saveSharedMeter(session("admin", "admin"), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA], method: "even", startReading: "1", ...bad }, { v3 }),
        { ok: false, reason: "invalid" }, JSON.stringify(bad));
  });
});

test("denials: cross-org, P-ACC, P-MNT, revoked session, archived or other-org property, tuple mismatches; nothing written", async () => {
  await flag(true);
  await unchanged("denials", async () => {
    for (const who of ["accountant", "maintenance", "revoked", "tenant", "owner"]) {
      await assert.rejects(view(who), code("42501"), `${who} view`);
      await assert.rejects(save(who, [roomA], "even", 1), code("42501"), `${who} save`);
      await assert.rejects(split(who, next, 1), code("42501"), `${who} split`);
    }
    await assert.rejects(view("coastAdmin"), code("42501"), "another company's admin");
    await assert.rejects(save("coastAdmin", [roomA], "even", 1, randomUUID(), property, { org: ORG2_ID }), code("42501"), "this org's property via another org");
    await assert.rejects(view("admin", archivedProperty), code("42501"), "archived property");
    await assert.rejects(save("admin", [roomA], "even", 1, randomUUID(), archivedProperty), code("42501"));
    await assert.rejects(view("admin", randomUUID()), code("42501"), "missing property");
    for (const [label, opts] of [["env", { env: "sandbox" }], ["live", { live: ORG2_ID }], ["pin", { pin: ORG2_ID }], ["no pin", { pin: null }]] as const) {
      await assert.rejects(view("admin", property, opts), code("42501"), label);
      await assert.rejects(save("admin", [roomA], "even", 1, randomUUID(), property, opts), code("42501"), label);
    }
    for (const [who, role] of [["accountant", "accountant"], ["maintenance", "maintenance"]] as const) {
      assert.deepEqual(await sharedMeterView(session(who, role), property, { v3 }), { state: "forbidden" });
      assert.deepEqual(await saveSharedMeter(session(who, role), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA], method: "even", startReading: "1" }, { v3 }), { ok: false, reason: "forbidden" });
    }
    assert.deepEqual(await sharedMeterView({ ...session("admin", "admin"), sessionId: sid.revoked }, property, { v3 }), { state: "forbidden" });
  });
});

test("issued bills never change: saving writes no invoice, utility run or line", async () => {
  await flag(true);
  const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM public.invoices)::int i,(SELECT count(*) FROM public.invoice_lines)::int l,
    (SELECT count(*) FROM public.utility_allocation_runs)::int r,(SELECT count(*) FROM public.utility_allocation_lines)::int al,
    (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.invoices x) h`)).rows[0];
  const before = await counts();
  await save("admin", [roomA, roomB], "even", 5);
  await split("admin", next, 10, 100);
  assert.deepEqual(await counts(), before);
});
