import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
import { saveSharedMeter, sharedMeterSplit, sharedMeterView } from "./b109-shared-meter";
import { readFileSync } from "node:fs";
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
let property: string, other: string, archivedProperty: string, roomA: string, roomB: string, roomC: string, whole: string, foreignRoom: string, floor: string;
let next: string, nextEnd: string, thisMonth: string, prevMonth: string, days: number, billing: Record<string, string>;
type Result = Record<string, unknown> & { status: string };
type Split = { status: string; revision?: number; method?: string; kwh?: string; rows?: { id: string; weight: string; kwh: string; amountMinor: string | null }[]; spaces?: { id: string; problem: string }[] } | null;
const code = (c: string) => (e: unknown) => ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === c;

async function flag(platform: boolean, org = platform) {
  await db.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text,$3::text)) WHERE key='shared_meter'`, [platform, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('shared_meter',$2::boolean) WHERE id = ANY($1::uuid[])`, [[ORG_ID, ORG2_ID], org]);
}
/** pin: app.active_org_id (null: unset); pinEnv: app.env (null: unset), independently of the call's own tuple. */
type Opts = { org?: string; live?: string; env?: string; pin?: string | null; pinEnv?: string | null };
async function call<T>(fn: string, who: string, args: unknown[], opts: Opts = {}): Promise<T> {
  const org = opts.org ?? ORG_ID, env = opts.env ?? "live";
  return svc(null, async client => {
    if (opts.pin !== null) await client.query("SELECT set_config('app.active_org_id',$1,true)", [opts.pin ?? org]);
    if (opts.pinEnv !== null) await client.query("SELECT set_config('app.env',$1,true)", [opts.pinEnv ?? env]);
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
/** Every billing row (issued bills, their lines, utility bills, allocation runs and lines), all orgs. */
const billingSnapshot = async () => (await db.query(`SELECT
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.invoices x) invoices,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.invoice_lines x) invoice_lines,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.utility_bills x) utility_bills,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.utility_allocation_runs x) runs,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.utility_allocation_lines x) run_lines`)).rows[0] as Record<string, string>;
const lease = async (target: { room?: string; unit?: string }, start: string, end: string | null) =>
  (await db.query(`INSERT INTO public.leases(org_id,property_id,unit_id,target_room_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,coalesce($5::uuid,(SELECT unit_id FROM public.rooms WHERE id=$3::uuid)),$3::uuid,$4::uuid,'active',$6::date,$7::date,'TWD',100000) RETURNING id`,
    [ORG_ID, property, target.room ?? null, target.unit ?? null, target.unit ?? null, start, end])).rows[0].id as string;
const meter = async (space: { room?: string; unit?: string }) =>
  (await db.query(`INSERT INTO public.meters(org_id,property_id,unit_id,room_id,utility,usage_unit,payer,split_method,rate_source,rate_minor_per_unit)
    VALUES($1,$2,coalesce($4::uuid,(SELECT unit_id FROM public.rooms WHERE id=$3::uuid)),$3::uuid,'electricity','kWh','tenant','none','fixed_rate',500) RETURNING id`,
    [ORG_ID, property, space.room ?? null, space.unit ?? null])).rows[0].id as string;
const reading = (meterId: string, on: string, value: number, estimate = false) =>
  db.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value,is_estimate) VALUES($1,$2,$3,$4,$5)", [ORG_ID, meterId, on, value, estimate]);
const shift = async (d: string, n: number, unit: "day" | "month") => (await db.query(`SELECT ($1::date + ($2 || ' ${unit}')::interval)::date::text d`, [d, n])).rows[0].d as string;
/** The gateway's rule, recomputed: floor each share, the remainder to the first space. */
function expectShares(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0), w = sum === 0 ? weights.map(() => 1) : weights, tw = sum === 0 ? weights.length : sum;
  const shares = w.map(x => Math.floor(total * x / tw));
  shares[0] += total - shares.reduce((a, b) => a + b, 0);
  return shares;
}
const kwhOf = (milli: number) => (milli / 1000).toFixed(3);
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
  floor = await unit(ORG_ID, property, "3F", "by_room");
  roomA = await room(ORG_ID, floor, "A"); roomB = await room(ORG_ID, floor, "B"); roomC = await room(ORG_ID, floor, "C");
  whole = await unit(ORG_ID, property, "5F", "whole_unit");
  other = await propertyWith(ORG_ID, "Other");
  foreignRoom = await room(ORG_ID, await unit(ORG_ID, other, "1F", "by_room"), "A");
  archivedProperty = await propertyWith(ORG_ID, "Archived");
  await db.query("UPDATE public.properties SET archived_at=clock_timestamp() WHERE id=$1", [archivedProperty]);
  const m = (await db.query(`SELECT (date_trunc('month',(clock_timestamp() AT TIME ZONE timezone)) + interval '1 month')::date::text n,
    (date_trunc('month',(clock_timestamp() AT TIME ZONE timezone)) + interval '2 month' - interval '1 day')::date::text e,
    date_trunc('month',(clock_timestamp() AT TIME ZONE timezone))::date::text t,
    (date_trunc('month',(clock_timestamp() AT TIME ZONE timezone)) - interval '1 month')::date::text p FROM public.properties WHERE id=$1`, [property])).rows[0];
  next = m.n; nextEnd = m.e; thisMonth = m.t; prevMonth = m.p; days = Number(nextEnd.slice(8));
  // Occupancy crossing month boundaries: A from the 20th of this month to the 10th of next; B from the 21st of next
  // month into the month after; C vacant; the whole unit 5F from the start of this month, open-ended.
  await lease({ room: roomA }, await shift(thisMonth, 19, "day"), await shift(next, 9, "day"));
  await lease({ room: roomB }, await shift(next, 20, "day"), await shift(next, 1, "month"));
  const wholeLease = await lease({ unit: whole }, thisMonth, null);
  // An issued bill for this property, with its utility bill, posted allocation run and line.
  const wholeMeter = await meter({ unit: whole });
  const bill = (await db.query(`INSERT INTO public.utility_bills(org_id,meter_id,provider,period_start,period_end,currency,total_amount_minor,total_usage)
    VALUES($1,$2,'Taipower',$3,$4,'TWD',55000,100) RETURNING id`, [ORG_ID, wholeMeter, prevMonth, thisMonth])).rows[0].id;
  const run = (await db.query(`INSERT INTO public.utility_allocation_runs(org_id,meter_id,utility_bill_id,period_start,period_end,split_method,rate_source,currency,
      total_usage,rate_minor_per_unit,total_amount_minor,status,approved_by,approved_at)
    VALUES($1,$2,$3,$4,$5,'none','fixed_rate','TWD',100,550,55000,'posted',$6,now()) RETURNING id`, [ORG_ID, wholeMeter, bill, prevMonth, thisMonth, USERS.admin])).rows[0].id;
  const line = (await db.query(`INSERT INTO public.utility_allocation_lines(org_id,run_id,lease_id,share_ratio,allocated_usage,amount_minor)
    VALUES($1,$2,$3,1,100,55000) RETURNING id`, [ORG_ID, run, wholeLease])).rows[0].id;
  const invoice = (await db.query(`INSERT INTO public.invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,period_start,period_end,source)
    VALUES($1,$2,$3,$4,'TWD',$5,$6,$5,'utility') RETURNING id`, [ORG_ID, property, wholeLease, `B109-${randomUUID().slice(0, 8)}`, thisMonth, prevMonth])).rows[0].id;
  await db.query(`INSERT INTO public.invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor,allocation_line_id)
    VALUES($1,$2,1,'utility','電費',100,550,55000,$3)`, [ORG_ID, invoice, line]);
  await db.query("UPDATE public.invoices SET status='open' WHERE id=$1", [invoice]);
  assert.equal((await db.query("SELECT total_minor::text t,status::text s FROM public.invoices WHERE id=$1", [invoice])).rows[0].s, "open");
  // Baseline before the first gateway call; compared after every test.
  billing = await billingSnapshot();
});

test.afterEach(async () => {
  assert.deepEqual(await billingSnapshot(), billing, "no billing row (issued bill, line, utility bill, run, run line) changes");
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

test("seeding never overwrites: re-running the migration's seed keeps existing platform and org values", async () => {
  const seed = readFileSync("supabase/migrations/20261116180000_b109_shared_meter.sql", "utf8").match(/INSERT INTO public\.platform_settings[\s\S]*?ON CONFLICT \(key\) DO NOTHING;/)![0];
  await flag(true);
  const before = (await db.query("SELECT value FROM public.platform_settings WHERE key='shared_meter'")).rows[0].value;
  const orgs = (await db.query("SELECT id::text,feature_flags->'shared_meter' f FROM public.organizations WHERE id = ANY($1::uuid[]) ORDER BY id", [[ORG_ID, ORG2_ID]])).rows;
  await db.query(seed);
  assert.deepEqual((await db.query("SELECT value FROM public.platform_settings WHERE key='shared_meter'")).rows[0].value, before);
  assert.deepEqual(before, { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] });
  assert.deepEqual((await db.query("SELECT id::text,feature_flags->'shared_meter' f FROM public.organizations WHERE id = ANY($1::uuid[]) ORDER BY id", [[ORG_ID, ORG2_ID]])).rows, orgs);
  // The organization seeding path: a new sandbox org is seeded from its live org and keeps the existing
  // shared_meter value; seeding it changes neither the live orgs nor the platform value.
  const { insertSandboxOrg } = await import("./sandbox");
  const sandbox = await insertSandboxOrg(db, ORG_ID, USERS.admin);
  assert.equal((await db.query("SELECT feature_flags->'shared_meter' f FROM public.organizations WHERE id=$1", [sandbox])).rows[0].f, true);
  await db.query(seed);
  assert.deepEqual((await db.query("SELECT id::text,feature_flags->'shared_meter' f FROM public.organizations WHERE id = ANY($1::uuid[]) ORDER BY id", [[ORG_ID, ORG2_ID]])).rows, orgs);
  assert.deepEqual((await db.query("SELECT value FROM public.platform_settings WHERE key='shared_meter'")).rows[0].value, before);
  await flag(false);
  assert.equal((await db.query("SELECT feature_flags->'shared_meter' f FROM public.organizations WHERE id=$1", [sandbox])).rows[0].f, true, "the sandbox keeps its own value");
  await db.query("UPDATE public.organizations SET feature_flags=feature_flags-'shared_meter' WHERE id=$1", [sandbox]);
});

test("flag OFF (platform, org, or both) and brand_v3 OFF alone: no access, nothing written", async () => {
  for (const [platform, org] of [[false, false], [false, true], [true, false]] as const) {
    await flag(platform, org);
    await unchanged(`platform ${platform} org ${org}`, async () => {
      assert.equal(await view("admin"), null);
      assert.deepEqual(await save("admin", [roomA], "even", 10), { status: "disabled" });
      assert.equal(await split("admin", next, 100), null);
      assert.deepEqual(await sharedMeterView(session("admin", "admin"), property, { v3 }), { state: "off" });
      assert.deepEqual(await saveSharedMeter(session("admin", "admin"), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA], method: "even", startReading: "10" }, { v3 }), { ok: false, reason: "off" });
      assert.deepEqual(await sharedMeterSplit(session("admin", "admin"), { propertyId: property, period: next, kwh: "10" }, { v3 }), { state: "off" });
    });
  }
  // Only brand_v3 off: an otherwise valid save, read and split never reach the gateways.
  await flag(true);
  const never = (async () => { throw new Error("no transaction expected"); }) as never;
  await unchanged("brand_v3 off", async () => {
    assert.deepEqual(await sharedMeterView(session("admin", "admin"), property, { v3: async () => false, transaction: never }), { state: "off" });
    assert.deepEqual(await saveSharedMeter(session("admin", "admin"), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA, roomB], method: "even", startReading: "10" },
      { v3: async () => false, transaction: never }), { ok: false, reason: "off" });
    assert.deepEqual(await sharedMeterSplit(session("admin", "admin"), { propertyId: property, period: next, kwh: "10" }, { v3: async () => false, transaction: never }), { state: "off" });
  });
  assert.equal((await snapshot()).n, 0);
});

test("MGT-90-AC4: save takes effect from the next period, audited; the view prefills; this period has nothing", async () => {
  await flag(true);
  const v0 = await view("manager");
  assert.ok(v0);
  assert.equal(v0.config, null);
  assert.equal(v0.nextEffectiveFrom, next);
  assert.deepEqual((v0.spaces as { label: string | null; unitLabel: string }[]).map(s => [s.unitLabel, s.label]), [["3F", "A"], ["3F", "B"], ["3F", "C"], ["5F", null]]);
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
  assert.equal(audit[0].new_row.effective_from, next);
  assert.deepEqual(await split("admin", thisMonth, 100), { status: "none", period: thisMonth });
  assert.equal((await split("admin", next, 100))!.status, "ready");
  assert.deepEqual((await view("admin"))!.config, { revision: 1, spaceIds: [roomA, roomB, roomC], method: "even", startReading: "1284.000", effectiveFrom: next });
  const ts = await sharedMeterView(session("manager", "manager"), property, { v3 });
  if (ts.state !== "ready") assert.fail(ts.state);
  assert.equal(ts.config?.revision, 1);
});

test("append-only revisions and idempotency: replay by id set survives renames, archiving and later saves", async () => {
  await flag(true);
  const roomD = await room(ORG_ID, floor, "D");
  const first = randomUUID();
  const one = await save("admin", [roomD, roomA], "days_occupied", "1300.5", first);
  assert.equal(one.status, "saved");
  const row1 = (await db.query("SELECT * FROM app.b109_shared_meter_configs WHERE id=$1", [one.configId])).rows[0];
  await unchanged("replay and conflict", async () => {
    assert.deepEqual(await save("admin", [roomA, roomD], "days_occupied", "1300.500", first), { ...one, replayed: true }, "same id set, any order");
    assert.deepEqual(await save("admin", [roomA], "days_occupied", "1300.5", first), { status: "conflict" });
    assert.deepEqual(await save("admin", [roomA, roomD, roomB], "days_occupied", "1300.5", first), { status: "conflict" });
    assert.deepEqual(await save("admin", [roomA, roomD], "even", "1300.5", first), { status: "conflict" });
    assert.deepEqual(await save("admin", [roomA, roomD], "days_occupied", "1300.6", first), { status: "conflict" });
    assert.deepEqual(await save("manager", [roomA, roomD], "days_occupied", "1300.5", first), { status: "conflict" });
  });
  const two = await save("admin", [roomA, roomB, roomC], "even", "1", randomUUID());
  const three = await saveSharedMeter(session("admin", "admin"), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA, roomB, roomC], method: "even", startReading: "1,284" }, { v3 });
  assert.equal(two.revision, (one.revision as number) + 1);
  assert.deepEqual(three, { ok: true, revision: (one.revision as number) + 2, effectiveFrom: next, spaceCount: 3, method: "even", replayed: false });
  // Renaming and then archiving a space never turns the old identical retry into a conflict or an invalid.
  await db.query("UPDATE public.rooms SET label='Z' WHERE id=$1", [roomD]);
  assert.deepEqual(await save("admin", [roomD, roomA], "days_occupied", "1300.5", first), { ...one, replayed: true });
  await db.query("UPDATE public.rooms SET archived_at=clock_timestamp() WHERE id=$1", [roomD]);
  assert.deepEqual(await save("admin", [roomD, roomA], "days_occupied", "1300.5", first), { ...one, replayed: true });
  // Earlier revisions are never touched; a new save with the archived room is invalid.
  assert.deepEqual((await db.query("SELECT * FROM app.b109_shared_meter_configs WHERE id=$1", [one.configId])).rows[0], row1);
  assert.deepEqual((await db.query("SELECT revision FROM app.b109_shared_meter_configs WHERE property_id=$1 ORDER BY revision", [property])).rows.map(r => r.revision),
    Array.from({ length: (one.revision as number) + 2 }, (_, i) => i + 1));
  assert.deepEqual(await save("admin", [roomD, roomA], "days_occupied", "1300.5"), { status: "invalid" });
});

test("split 平均分: every space gets its own floored share; the remainder goes to the first (kWh to 0.001 and minor units)", async () => {
  await flag(true);
  await save("admin", [roomA, roomB, roomC, whole], "even", 0);
  const s = await split("admin", next, "100.003", 1001);
  assert.equal(s!.status, "ready");
  assert.deepEqual(s!.rows!.map(r => [r.id, r.weight, r.kwh, r.amountMinor]), [
    [roomA, "1", "25.003", "251"], [roomB, "1", "25.000", "250"], [roomC, "1", "25.000", "250"], [whole, "1", "25.000", "250"]]);
  const ts = await sharedMeterSplit(session("manager", "manager"), { propertyId: property, period: next, kwh: "100.003", amountMinor: "1001" }, { v3 });
  if (ts.state !== "ready") assert.fail(ts.state);
  assert.deepEqual(ts.rows.map(r => r.kwh), ["25.003", "25.000", "25.000", "25.000"]);
});

test("split 依住的天數分: leases crossing month boundaries, a whole unit, vacant rooms; per-space kWh and amounts", async () => {
  await flag(true);
  await save("admin", [roomA, roomB, roomC, whole], "days_occupied", 0);
  const s = await split("admin", next, "123.457", 98765);
  const weights = [10, days - 20, 0, days];
  assert.deepEqual(s!.rows!.map(r => [r.id, Number(r.weight)]), [[roomA, 10], [roomB, days - 20], [roomC, 0], [whole, days]]);
  assert.deepEqual(s!.rows!.map(r => r.kwh), expectShares(123457, weights).map(kwhOf));
  assert.deepEqual(s!.rows!.map(r => Number(r.amountMinor)), expectShares(98765, weights));
  // The month after: A has ended; B's lease ends on its 1st (1 day); 5F is open-ended (the whole month).
  const after = await shift(next, 1, "month");
  const afterDays = Number((await db.query("SELECT (($1::date + interval '1 month') - interval '1 day')::date::text d", [after])).rows[0].d.slice(8));
  const s2 = await split("admin", after, 10, 10);
  assert.deepEqual(s2!.rows!.map(r => Number(r.weight)), [0, 1, 0, afterDays]);
  assert.deepEqual(s2!.rows!.map(r => r.kwh), expectShares(10000, [0, 1, 0, afterDays]).map(kwhOf));
  // Nobody living there: all weights 0 split evenly, the remainder to the first space.
  const far = await shift(next, -3, "month");
  await save("admin", [roomC], "days_occupied", 0);
  assert.equal((await split("admin", far, 10, 10))!.status, "none", "before the config's effective month");
  const vacant = await split("admin", next, "0.010", 10);
  assert.deepEqual(vacant!.rows!.map(r => [r.weight, r.kwh, r.amountMinor]), [["1", "0.010", "10"]]);
});

test("split 依分表度數: one meter per space, latest readings, missing baseline, estimates, ambiguity, 3-decimal rounding", async () => {
  await flag(true);
  await save("admin", [roomA, roomB, roomC, whole], "sub_meter", 0);
  const mA = await meter({ room: roomA }), mB = await meter({ room: roomB }), mC = await meter({ room: roomC });
  const wholeMeter = (await db.query("SELECT id FROM public.meters WHERE unit_id=$1 AND room_id IS NULL", [whole])).rows[0].id;
  const before = (n: number) => shift(next, -n, "day"), inside = (n: number) => shift(next, n - 1, "day");
  // A: several readings before and within the month, and one after it; latest-before 100, latest-within 160.
  await reading(mA, await before(40), 20); await reading(mA, await before(1), 100); await reading(mA, await before(5), 90);
  await reading(mA, await inside(10), 130); await reading(mA, nextEnd, 160); await reading(mA, await shift(nextEnd, 3, "day"), 999);
  // B: no reading before the month (missing baseline).
  await reading(mB, await inside(1), 50); await reading(mB, nextEnd, 80);
  // C: baseline, then an estimated end reading.
  await reading(mC, await before(2), 10); await reading(mC, nextEnd, 20, true);
  // 5F: its main meter (the issued bill's meter) with a baseline and an end reading.
  await reading(wholeMeter, await before(3), 500); await reading(wholeMeter, nextEnd, 507);
  assert.deepEqual(await split("admin", next, 10, 100), { status: "missing_readings", period: next, revision: ((await view("admin"))!.config as { revision: number }).revision,
    spaces: [{ id: roomB, problem: "missing_reading" }, { id: roomC, problem: "estimated_reading" }] });
  // Mixed failures across spaces in one call: A ambiguous (a second room meter; a unit allows only one active
  // main meter, so a whole unit cannot be ambiguous), B missing, C estimated.
  const second = await meter({ room: roomA });
  const mixed = await split("admin", next, 10);
  assert.equal(mixed!.status, "ambiguous_meters", "precedence: ambiguous > missing > estimated");
  assert.deepEqual(mixed!.spaces, [{ id: roomA, problem: "ambiguous_meter" }, { id: roomB, problem: "missing_reading" }, { id: roomC, problem: "estimated_reading" }]);
  const tsMixed = await sharedMeterSplit(session("admin", "admin"), { propertyId: property, period: next, kwh: "10" }, { v3 });
  assert.deepEqual(tsMixed, { state: "not_ready", reason: "ambiguous_meters", problems: [
    { spaceId: roomA, problem: "ambiguous_meter" }, { spaceId: roomB, problem: "missing_reading" }, { spaceId: roomC, problem: "estimated_reading" }] });
  await db.query("UPDATE public.meters SET archived_at=clock_timestamp() WHERE id=$1", [second]);
  await reading(mB, await before(10), 50);
  const estimated = await split("admin", next, 10);
  assert.equal(estimated!.status, "estimated_readings");
  assert.deepEqual(estimated!.spaces, [{ id: roomC, problem: "estimated_reading" }]);
  // A measured reading later in the month becomes the latest endpoint (same day: latest created wins).
  await reading(mC, nextEnd, 20);
  // Two active meters on one space: ambiguous, even with complete readings; precedence over everything else.
  const extra = await meter({ room: roomC });
  await reading(extra, await before(2), 0); await reading(extra, nextEnd, 5000);
  const ambiguous = await split("admin", next, 10);
  assert.deepEqual([ambiguous!.status, ambiguous!.spaces], ["ambiguous_meters", [{ id: roomC, problem: "ambiguous_meter" }]]);
  await db.query("UPDATE public.meters SET archived_at=clock_timestamp() WHERE id=$1", [extra]);
  // Ready: A 60, B 30, C 10, 5F 7 → 10 kWh needs rounding at 3 decimals; every share is floored, the remainder to A.
  const s = await split("admin", next, 10, 1000);
  const weights = [60, 30, 10, 7];
  assert.deepEqual(s!.rows!.map(r => Number(r.weight)), weights);
  assert.deepEqual(s!.rows!.map(r => r.kwh), expectShares(10000, weights).map(kwhOf));
  assert.deepEqual(s!.rows!.map(r => r.kwh), ["5.609", "2.803", "0.934", "0.654"]);
  assert.deepEqual(s!.rows!.map(r => Number(r.amountMinor)), expectShares(1000, weights));
  const ts = await sharedMeterSplit(session("admin", "admin"), { propertyId: property, period: next, kwh: "10" }, { v3 });
  if (ts.state !== "ready") assert.fail(ts.state);
  // A space without any meter is missing, not zero.
  await save("admin", [roomA, roomB, roomC, whole], "sub_meter", 0);
  await db.query("UPDATE public.meters SET archived_at=clock_timestamp() WHERE id=$1", [mB]);
  assert.deepEqual((await sharedMeterSplit(session("admin", "admin"), { propertyId: property, period: next, kwh: "10" }, { v3 })),
    { state: "not_ready", reason: "missing_readings", problems: [{ spaceId: roomB, problem: "missing_reading" }] });
});

test("invalid input saves nothing", async () => {
  await flag(true);
  await unchanged("invalid", async () => {
    for (const [spaces, method, reading] of [
      [[], "even", "1"], [[roomA, roomA], "even", "1"], [[roomA, foreignRoom], "even", "1"], [[roomA], "none", "1"],
      [[roomA], "even", "-1"], [[roomA], "even", "1.2345"], [[roomA], "even", "100000000000"],
    ] as const) assert.deepEqual(await save("admin", [...spaces], method, reading), { status: "invalid" }, JSON.stringify([spaces, method, reading]));
    await assert.rejects(split("admin", await shift(next, 1, "day"), 1), code("22023"));
    await assert.rejects(split("admin", next, -1), code("22023"));
    for (const bad of [{ spaceIds: [] }, { startReading: "" }, { startReading: "abc" }, { method: "x" }, { spaceIds: ["x"] }])
      assert.deepEqual(await saveSharedMeter(session("admin", "admin"), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA], method: "even", startReading: "1", ...bad }, { v3 }),
        { ok: false, reason: "invalid" }, JSON.stringify(bad));
    for (const bad of [{ period: await shift(next, 1, "day") }, { kwh: "-1" }, { kwh: "1.2345" }, { amountMinor: "1.5" }])
      assert.deepEqual(await sharedMeterSplit(session("admin", "admin"), { propertyId: property, period: next, kwh: "1", ...bad }, { v3 }), { state: "unavailable" }, JSON.stringify(bad));
  });
});

test("denials on all three gateways: roles, revoked session, cross-org, archived/missing property, tuple and app.env; nothing written", async () => {
  await flag(true);
  const calls: [string, (who: string, target: string, opts?: Opts) => Promise<unknown>][] = [
    ["view", (who, target, opts) => view(who, target, opts)],
    ["save", (who, target, opts) => save(who, [roomA], "even", 1, randomUUID(), target, opts)],
    ["split", (who, target, opts) => split(who, next, 1, null, target, opts)],
  ];
  await unchanged("denials", async () => {
    for (const [name, run] of calls) {
      for (const who of ["accountant", "maintenance", "revoked", "tenant", "owner"]) await assert.rejects(run(who, property), code("42501"), `${who} ${name}`);
      await assert.rejects(run("coastAdmin", property), code("42501"), `another company's admin ${name}`);
      await assert.rejects(run("coastAdmin", property, { org: ORG2_ID }), code("42501"), `this org's property via another org ${name}`);
      await assert.rejects(run("admin", archivedProperty), code("42501"), `archived property ${name}`);
      await assert.rejects(run("admin", randomUUID()), code("42501"), `missing property ${name}`);
      for (const [label, opts] of [["env", { env: "sandbox" }], ["live", { live: ORG2_ID }], ["org pin", { pin: ORG2_ID }], ["no org pin", { pin: null }],
        ["app.env mismatch", { pinEnv: "sandbox" }], ["app.env missing", { pinEnv: null }]] as [string, Opts][])
        await assert.rejects(run("admin", property, opts), code("42501"), `${label} ${name}`);
    }
    for (const [who, role] of [["accountant", "accountant"], ["maintenance", "maintenance"]] as const) {
      assert.deepEqual(await sharedMeterView(session(who, role), property, { v3 }), { state: "forbidden" });
      assert.deepEqual(await saveSharedMeter(session(who, role), { propertyId: property, requestId: randomUUID(), spaceIds: [roomA], method: "even", startReading: "1" }, { v3 }), { ok: false, reason: "forbidden" });
      assert.deepEqual(await sharedMeterSplit(session(who, role), { propertyId: property, period: next, kwh: "1" }, { v3 }), { state: "forbidden" });
    }
    assert.deepEqual(await sharedMeterView({ ...session("admin", "admin"), sessionId: sid.revoked }, property, { v3 }), { state: "forbidden" });
    assert.deepEqual(await sharedMeterSplit(session("coastAdmin", "admin", ORG2_ID), { propertyId: property, period: next, kwh: "1" }, { v3 }), { state: "forbidden" });
  });
});

test("not ready, each alone and together: estimated baseline, negative usage, baseline with no in-month reading", async () => {
  await flag(true);
  const [e, f, g] = [await room(ORG_ID, floor, "E"), await room(ORG_ID, floor, "F"), await room(ORG_ID, floor, "G")];
  const [mE, mF, mG] = [await meter({ room: e }), await meter({ room: f }), await meter({ room: g })];
  const before = await shift(next, -1, "day");
  await reading(mE, before, 10, true); await reading(mE, nextEnd, 20);      // estimated baseline
  await reading(mF, before, 100); await reading(mF, nextEnd, 90);          // negative delta
  await reading(mG, before, 5);                                             // nothing inside the month
  for (const [spaces, status, problems] of [
    [[e], "estimated_readings", [{ id: e, problem: "estimated_reading" }]],
    [[f], "missing_readings", [{ id: f, problem: "missing_reading" }]],
    [[g], "missing_readings", [{ id: g, problem: "missing_reading" }]],
    [[e, f, g], "missing_readings", [{ id: e, problem: "estimated_reading" }, { id: f, problem: "missing_reading" }, { id: g, problem: "missing_reading" }]],
  ] as const) {
    await save("admin", [...spaces], "sub_meter", 0);
    const r = await split("admin", next, 10, 10);
    assert.notEqual(r!.status, "ready");
    assert.deepEqual([r!.status, r!.spaces], [status, problems]);
  }
});

test("all-zero fallback: several vacant spaces split evenly, the remainder to the first", async () => {
  await flag(true);
  const vacant = [await room(ORG_ID, floor, "V1"), await room(ORG_ID, floor, "V2"), await room(ORG_ID, floor, "V3")];
  await save("admin", vacant, "days_occupied", 0);
  const r = await split("admin", next, "0.010", 10);
  assert.deepEqual(r!.rows!.map(x => [x.id, x.weight, x.kwh, x.amountMinor]), [
    [vacant[0], "1", "0.004", "4"], [vacant[1], "1", "0.003", "3"], [vacant[2], "1", "0.003", "3"]]);
});

test("exact integer shares: weights 1000.001 / 1000.000 with amount 999999999999752 never round a share up", async () => {
  await flag(true);
  const [h, i] = [await room(ORG_ID, floor, "H"), await room(ORG_ID, floor, "I")];
  const [mH, mI] = [await meter({ room: h }), await meter({ room: i })];
  const before = await shift(next, -1, "day");
  await reading(mH, before, 0); await reading(mH, nextEnd, 1000.001);
  await reading(mI, before, 0); await reading(mI, nextEnd, 1000);
  await save("admin", [h, i], "sub_meter", 0);
  const amount = BigInt("999999999999752"), wH = BigInt(1000001), wI = BigInt(1000000), tw = wH + wI;
  const shareI = amount * wI / tw, shareH = amount - shareI;   // floor(I); the remainder (incl. H's own floor) to H
  assert.equal(amount * wH / tw + amount * wI / tw + BigInt(1), amount, "the exact floors leave exactly one unit over");
  const r = await split("admin", next, 10, Number(amount));
  assert.deepEqual(r!.rows!.map(x => [x.id, x.weight, x.amountMinor]), [[h, "1000.001", shareH.toString()], [i, "1000.000", shareI.toString()]]);
  assert.equal(BigInt(r!.rows![0].amountMinor!) + BigInt(r!.rows![1].amountMinor!), amount);
  const ts = await sharedMeterSplit(session("admin", "admin"), { propertyId: property, period: next, kwh: "10", amountMinor: amount.toString() }, { v3 });
  if (ts.state !== "ready") assert.fail(ts.state);
  assert.deepEqual(ts.rows.map(x => x.amountMinor), [shareH.toString(), shareI.toString()]);
});
