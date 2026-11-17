import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
import { createProperty } from "./domain";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { allocateUtilityMinor } from "./utility-post";
import { confirmUtilityRun, prepareUtilityRun, voidUtilityRun, type UtilityRunInput } from "./utility-posting";

// B-109b (PR-036 = a; GS-53 = A; MGT-90-AC4…AC6) on a cloned disposable database: the real save gateway, the real
// posting flow (prepareUtilityRun / confirmUtilityRun) and the real run-config gateway through service_role, with
// lock-wait races against real row-lock holders. Never a pg mock or a grant.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const SAVE = "app.b109_shared_meter_save";
const RUN = "app.b109b_run_config";
const SHARES = "app.b109_split_shares";
const sid: Record<string, string> = {};
let property: string, unitId: string, roomA: string, roomB: string, roomC: string, mainMeter: string, otherUnit: string, otherRoom: string, wholeUnit: string;
let leaseA: string, leaseB: string;
let next: { start: string; end: string }, after: { start: string; end: string }, thisMonth: { start: string; end: string };
type Opts = { org?: string; live?: string; env?: string; pin?: string | null; pinEnv?: string | null; lockTimeout?: string };
type Config = Record<string, unknown> & { status: string } | null;
const code = (c: string) => (e: unknown) => ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === c;
const flowKey = (key: string) => (e: unknown) => (e as { key?: string }).key === key;

async function flag(platform: boolean, org = platform) {
  await db.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text,$3::text)) WHERE key='shared_meter'`, [platform, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('shared_meter',$2::boolean) WHERE id = ANY($1::uuid[])`, [[ORG_ID, ORG2_ID], org]);
}
async function call<T>(fn: string, who: string, args: unknown[], opts: Opts = {}): Promise<T> {
  const org = opts.org ?? ORG_ID, env = opts.env ?? "live";
  return svc(null, async client => {
    await client.query(`SET LOCAL lock_timeout = '${opts.lockTimeout ?? "10s"}'`);
    if (opts.pin !== null) await client.query("SELECT set_config('app.active_org_id',$1,true)", [opts.pin ?? org]);
    if (opts.pinEnv !== null) await client.query("SELECT set_config('app.env',$1,true)", [opts.pinEnv ?? env]);
    const params = args.map((_, i) => `$${i + 5}`).join(",");
    return (await client.query(`SELECT ${fn}($1,$2,$3,$4,${params}) r`, [org, opts.live ?? org, env, sid[who], ...args])).rows[0].r;
  }, { isolation: "read committed" });
}
/** A B-109 revision through the real save gateway (effective from next month). */
async function save(spaces: string[], method: "even" | "days_occupied" | "sub_meter", reading: number | string = 0) {
  const r = await call<{ status: string; revision: number }>(SAVE, "admin", [randomUUID(), property, spaces, method, String(reading)]);
  assert.equal(r.status, "saved", JSON.stringify(r));
  return r.revision;
}
const runConfig = (who: string, unit = unitId, period = next, opts: Opts = {}) => call<Config>(RUN, who, [unit, period.start, period.end], opts);
const staff = (who: keyof typeof USERS, role: Session["role"]): Session => ({ kind: "staff", role, orgId: ORG_ID, liveOrgId: ORG_ID, userId: USERS[who],
  sessionId: sid[who], name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });
/** The run's lines by room label (owner + tenant lines per room in label, then lease order). */
async function lines(runId: string) {
  return (await db.query(`SELECT r.label, l.room_id::text room, l.lease_id::text lease, l.bearer::text bearer,
      round(l.allocated_usage*1000)::bigint::text milli, l.amount_minor::text amount, l.explanation
    FROM public.utility_allocation_lines l JOIN public.rooms r ON r.id=l.room_id WHERE l.run_id=$1 ORDER BY r.label, l.lease_id NULLS FIRST`, [runId])).rows as
    { label: string; room: string; lease: string | null; bearer: string; milli: string; amount: string; explanation: Record<string, unknown> }[];
}
const inputsOf = async (runId: string) => (await db.query("SELECT inputs FROM public.utility_allocation_runs WHERE id=$1", [runId])).rows[0].inputs as Record<string, unknown>;
/** Every billing row (runs, their lines, utility bills, invoices and lines, expenses), all orgs. */
const billing = async () => (await db.query(`SELECT
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.utility_allocation_runs x) runs,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.utility_allocation_lines x) run_lines,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.utility_bills x) utility_bills,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.invoices x) invoices,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.invoice_lines x) invoice_lines,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.expenses x) expenses,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM app.b109_shared_meter_configs x) configs`)).rows[0] as Record<string, string>;
const runInput = (readings: [string, number][], totalKwh: number | null, period = next, extra: Partial<UtilityRunInput> = {}): UtilityRunInput => ({
  unitId, periodStart: period.start, periodEnd: period.end, rateMajor: 5, totalKwh, billTotalMajor: null, overrideReason: "",
  readings: readings.map(([spaceId, kwh]) => ({ spaceId, kwh, previousKwh: null, currentKwh: null })), ...extra,
});
/** The posting rule recomputed: floor each share, the remainder to the first room. */
function expectShares(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0), w = sum === 0 ? weights.map(() => 1) : weights, tw = sum === 0 ? weights.length : sum;
  const shares = w.map(x => Math.floor(total * x / tw));
  shares[0] += total - shares.reduce((a, b) => a + b, 0);
  return shares;
}
const price = (milli: number) => allocateUtilityMinor({ currency: "TWD", rateMajor: 5, mode: "each", parts: [{ key: "x", kwhMilli: milli }] })[0].amountMinor;
/** Each test starts from no live run of the unit: posted runs are voided through the real flow, open ones removed. */
async function resetRuns() {
  for (const { id } of (await db.query("SELECT id FROM public.utility_allocation_runs WHERE unit_id=$1 AND status::text IN ('posted','pending_repost')", [unitId])).rows)
    await voidUtilityRun(staff("admin", "admin"), id, "測試重設");
  await voidOpen();
}
async function voidOpen() {
  // Open (unconfirmed) runs of the unit are recomputed by the next prepare; posted runs are left alone.
  await db.query("DELETE FROM public.utility_allocation_lines WHERE run_id IN (SELECT id FROM public.utility_allocation_runs WHERE unit_id=$1 AND status::text NOT IN ('posted','pending_repost','void'))", [unitId]);
  await db.query("DELETE FROM public.utility_allocation_runs WHERE unit_id=$1 AND status::text NOT IN ('posted','pending_repost','void')", [unitId]);
}
const holders: Client[] = [];
async function holder() { const c = new Client({ connectionString: process.env.DATABASE_URL }); holders.push(c); await c.connect(); await c.query("BEGIN"); return c; }
async function waitForBlocked(h: Client) {
  const pid = (await h.query("SELECT pg_backend_pid() p")).rows[0].p;
  for (let i = 0; i < 100; i++) {
    if ((await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid])).rows[0].n > 0) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail("no waiter appeared");
}
async function session(who: string, user: string) {
  sid[who] = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid[who], user, randomUUID()]);
}
function form(fields: Record<string, string>) { const data = new FormData(); for (const [k, v] of Object.entries(fields)) data.set(k, v); return data; }

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
  for (const who of Object.keys(USERS)) await session(who, USERS[who as keyof typeof USERS]);
  await flag(true);
  const created = await createProperty(staff("admin", "admin"), {
    name: "民生東路三段 25 號", city: "台北市", district: "松山區", street: "民生東路三段 25 號", currency: "TWD",
    ownerMode: "new", ownerName: "陳建宏", ownerPhone: "0912000555", ownerEmail: "b109b.owner@example.com", canViewTenantPhone: false,
    unitLabel: "3F", floor: "3", rentalMode: "by_room",
    rooms: ["A", "B", "C"].map(label => ({ label, roomType: "suite", baseRentMajor: 9000 })),
  } as never);
  property = created.propertyId;
  [roomA, roomB, roomC] = created.roomIds;
  unitId = (await db.query("SELECT unit_id FROM public.rooms WHERE id=$1", [roomA])).rows[0].unit_id;
  await db.query("UPDATE public.rooms SET electricity_method='submeter', rate_per_kwh=5 WHERE unit_id=$1", [unitId]);
  const months = (await db.query(`SELECT to_char(m,'YYYY-MM') k FROM (SELECT date_trunc('month',(clock_timestamp() AT TIME ZONE 'Asia/Taipei')) + (n||' month')::interval m FROM generate_series(0,2) n) x ORDER BY m`)).rows.map(r => r.k as string);
  const bounds = (k: string) => { const [y, m] = k.split("-").map(Number); return { start: `${k}-01`, end: `${k}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` }; };
  [thisMonth, next, after] = months.map(bounds);
  // Tenants: A from this month for a year (all of next month); B from the 11th of next month. C stays vacant.
  const lease = async (room: string, start: string, name: string, n: number) => {
    const l = await createLeaseFromForm(staff("admin", "admin"), form({ tenantName: name, tenantPhone: `09120000${10 + n}`, tenantEmail: `b109b.t${n}@example.com`,
      lineUserId: "", startDate: start, months: "12", rent: "9000", depositMonths: "2", depositReason: "", dueDay: "5", splitMethod: "even",
      billTotal: "", usage: "", rate: "", overrideReason: "", roomId: room }));
    await db.query("UPDATE public.leases SET status='active', esign_status='fully_signed', signed_at=coalesce(signed_at,now()) WHERE id=$1", [l.leaseId]);
    return l.leaseId as string;
  };
  leaseA = await lease(roomA, thisMonth.start, "王小明", 1);
  leaseB = await lease(roomB, `${next.start.slice(0, 8)}11`, "林美玲", 2);
  // A second by-room unit (one room) and a whole unit in the same property, for the blocked shapes.
  otherUnit = (await db.query(`INSERT INTO public.units(org_id,property_id,label,rental_mode) VALUES($1,$2,'4F','by_room') RETURNING id`, [ORG_ID, property])).rows[0].id;
  otherRoom = (await db.query(`INSERT INTO public.rooms(org_id,unit_id,label) VALUES($1,$2,'A') RETURNING id`, [ORG_ID, otherUnit])).rows[0].id;
  wholeUnit = (await db.query(`INSERT INTO public.units(org_id,property_id,label,rental_mode) VALUES($1,$2,'5F','whole_unit') RETURNING id`, [ORG_ID, property])).rows[0].id;
  const main = (await db.query(`SELECT id FROM public.meters WHERE unit_id=$1 AND room_id IS NULL AND utility='electricity' AND archived_at IS NULL`, [unitId])).rows;
  mainMeter = main[0]?.id ?? (await db.query(`INSERT INTO public.meters(org_id,property_id,unit_id,utility,usage_unit,payer,split_method,rate_source,rate_minor_per_unit)
    VALUES($1,$2,$3,'electricity','kWh','owner','none','fixed_rate',500) RETURNING id`, [ORG_ID, property, unitId])).rows[0].id;
});

test.after(async () => {
  try { for (const h of holders) await h.end().catch(() => undefined); if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("fixture: one by-room unit with three rooms, two tenants, a main meter; periods", async () => {
  assert.ok(property && unitId && mainMeter && leaseA && leaseB);
  assert.ok(next.start > thisMonth.start && after.start > next.start);
});

test("OFF (org flag off, or platform off): byte-identical PUBLIC_POWER_RULE, no gateway call and no lock wait, even with a revision saved", async () => {
  await flag(true);
  await save([roomA, roomB], "even");
  const input = runInput([[roomA, 100.1], [roomB, 50.1], [roomC, 10]], 161.201);
  const results: Record<string, unknown>[] = [];
  for (const [platform, org] of [[false, false], [true, false], [false, true]] as const) {
    await voidOpen();
    await flag(platform, org);
    const h = await holder();
    await h.query("SELECT 1 FROM app.b109_shared_meter_configs WHERE property_id=$1 FOR UPDATE", [property]);
    const started = Date.now();
    // Any OFF part: no gateway call, so a holder with the revisions locked FOR UPDATE does not delay posting.
    const run = await prepareUtilityRun(staff("admin", "admin"), input).finally(async () => { await h.query("ROLLBACK"); await h.end(); });
    assert.ok(Date.now() - started < 5000, "OFF: no wait on the revisions");
    const inputs = await inputsOf(run.runId);
    assert.equal("sharedMeter" in inputs, false);
    assert.equal(inputs.publicKwhMilli, 1001, "PUBLIC_POWER_RULE: total minus the room meters stays with the owner");
    const rows = await lines(run.runId);
    assert.deepEqual(rows.map(r => [r.label, r.milli, r.amount]), [["A", "100100", String(price(100100))], ["B", "50100", String(price(50100))], ["C", "10000", String(price(10000))]]);
    assert.ok(rows.every(r => !("sharedKwh" in (r.explanation ?? {}))));
    results.push({ inputs: { ...inputs }, rows: rows.map(({ label, lease, bearer, milli, amount, explanation }) => ({ label, lease, bearer, milli, amount, explanation })) });
  }
  assert.deepEqual(results[1], results[0], "org off == both off");
  assert.deepEqual(results[2], results[0], "platform off == both off");
  await voidOpen();
  await flag(true);
});

test("ON, each method on a real run: the unit's shared kWh goes to the selected rooms (remainder to the first), priced once at the typed rate; unselected rooms unchanged", async () => {
  await flag(true);
  // A 100.1, B 50.1, C 10 (unselected) of a 161.201 kWh total: 1.001 kWh shared between A and B.
  const own = { A: 100100, B: 50100, C: 10000 }, shared = 1001;
  const nextDays = Number(next.end.slice(8));
  await resetRuns();
  for (const [method, weights] of [["even", [1, 1]], ["days_occupied", [nextDays, nextDays - 10]], ["sub_meter", [own.A, own.B]]] as const) {
    await voidOpen();
    const revision = await save([roomB, roomA], method);
    const run = await prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100.1], [roomB, 50.1], [roomC, 10]], 161.201));
    const shares = expectShares(shared, [...weights]);
    assert.equal(shares[0] - Math.floor(shared * weights[0] / (weights[0] + weights[1])) >= 0, true);
    const inputs = await inputsOf(run.runId);
    assert.deepEqual(inputs.sharedMeter, { revision, method, roomIds: [roomA, roomB], weights: weights.map(String), sharesMilli: shares, kwhMilli: shared, seededTotalMilli: null }, method);
    assert.equal(inputs.publicKwhMilli, 0, "nothing left on the owner's 公共用電");
    assert.equal(inputs.publicAmountMinor, 0);
    const rows = await lines(run.runId);
    const a = rows.find(r => r.label === "A")!, b = rows.find(r => r.label === "B")!, c = rows.find(r => r.label === "C")!;
    assert.equal(rows.filter(r => r.label === "A").length, 1);
    assert.deepEqual([a.lease, a.bearer, Number(a.milli)], [leaseA, "tenant", own.A + shares[0]], method);
    assert.deepEqual([b.lease, b.bearer, Number(b.milli)], [leaseB, "tenant", own.B + shares[1]], method);
    // Priced once on own + shared at the typed rate (never two separately rounded amounts).
    assert.equal(Number(a.amount), price(own.A + shares[0]));
    assert.equal(Number(b.amount), price(own.B + shares[1]));
    assert.equal(a.explanation.sharedKwh, shares[0] / 1000);
    assert.equal(b.explanation.sharedKwh, shares[1] / 1000);
    // C is not selected: its own kWh, its own bearer, no shared part.
    assert.deepEqual([c.bearer, Number(c.milli), Number(c.amount), "sharedKwh" in c.explanation], ["owner", own.C, price(own.C), false]);
    // The B-109 preview (with this run's typed readings) gives the same shares.
    const preview = await call<{ status: string; rows: { id: string; kwh: string }[] }>("app.b109_shared_meter_split", "admin", [property, next.start, String(shared / 1000), null]);
    assert.equal(preview.status, "ready");
    assert.deepEqual(preview.rows.map(r => [r.id, Math.round(Number(r.kwh) * 1000)]), [[roomA, shares[0]], [roomB, shares[1]]], `${method} preview aligned`);
  }
  // Rounding once matters for these numbers: the even split priced separately would differ.
  const even = expectShares(shared, [1, 1]);
  assert.notEqual(price(own.A) + price(even[0]), price(own.A + even[0]));
  await voidOpen();
});

test("a negative shared kWh (room meters above the total) stays an owner credit; nothing is split", async () => {
  await flag(true);
  await resetRuns();
  await save([roomA, roomB], "even");
  const run = await prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 150));
  const inputs = await inputsOf(run.runId);
  assert.equal(inputs.publicKwhMilli, -10000);
  assert.deepEqual((inputs.sharedMeter as { sharesMilli: number[]; kwhMilli: number }).sharesMilli, [0, 0]);
  assert.equal((inputs.sharedMeter as { kwhMilli: number }).kwhMilli, 0);
  assert.deepEqual((await lines(run.runId)).map(r => Number(r.milli)), [100000, 50000, 10000]);
  await voidOpen();
});

test("issued bills never change; the period before a revision is unaffected; a correction of a run computed without it stays without it", async () => {
  await flag(true);
  await resetRuns();
  // This month: the revision takes effect next month, so this month's run keeps PUBLIC_POWER_RULE.
  await save([roomA, roomB], "even");
  const current = await prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 161, thisMonth));
  assert.equal("sharedMeter" in await inputsOf(current.runId), false);
  assert.equal((await inputsOf(current.runId)).publicKwhMilli, 1000);
  assert.equal((await runConfig("admin", unitId, thisMonth))!.status, "none");
  // Next month: posted with the split, then issued.
  const issued = await prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 161));
  await confirmUtilityRun(staff("admin", "admin"), issued.runId);
  const snapshotOf = async () => (await db.query(`SELECT md5(row_to_json(r)::text) run,
      (SELECT md5(string_agg(row_to_json(l)::text,'|' ORDER BY l.id)) FROM public.utility_allocation_lines l WHERE l.run_id=r.id) lines,
      (SELECT md5(coalesce(string_agg(row_to_json(i)::text,'|' ORDER BY i.id),'')) FROM public.invoice_lines i WHERE i.id IN (SELECT posted_invoice_line_id FROM public.utility_allocation_lines WHERE run_id=r.id)) invoice_lines
    FROM public.utility_allocation_runs r WHERE r.id=$1`, [issued.runId])).rows[0];
  const before = await snapshotOf();
  // A later revision (another method, other rooms) and the flag turned off and on: the issued run is untouched.
  await save([roomA, roomC], "sub_meter");
  await flag(false); await flag(true);
  assert.deepEqual(await snapshotOf(), before, "issued run, lines and invoice lines unchanged");
  // A correction of this month's run (computed without the split) is recomputed without it.
  await confirmUtilityRun(staff("admin", "admin"), current.runId);
  const corrected = await prepareUtilityRun(staff("admin", "admin"), { ...runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 162, thisMonth), sourceRunId: current.runId });
  assert.equal("sharedMeter" in await inputsOf(corrected.runId), false);
  assert.equal((await inputsOf(corrected.runId)).publicKwhMilli, 2000);
});

test("blocked shapes: a revision spanning units or naming a whole unit stops posting with nothing written; a revision not naming this unit leaves it alone", async () => {
  await flag(true);
  await resetRuns();
  const input = runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 161);
  await save([roomA, otherRoom], "even");
  let before = await billing();
  await assert.rejects(prepareUtilityRun(staff("admin", "admin"), input), flowKey("errors.sharedMeterUnits"), "spans two units");
  assert.deepEqual(await billing(), before, "nothing written");
  assert.deepEqual(await runConfig("admin"), { status: "multi_unit", revision: (await runConfig("admin"))!.revision });
  await save([roomA, wholeUnit], "even");
  before = await billing();
  await assert.rejects(prepareUtilityRun(staff("admin", "admin"), input), flowKey("errors.sharedMeterUnits"), "names a whole unit too");
  assert.deepEqual(await billing(), before);
  // The whole unit itself, as a run: blocked (whole_unit), never split.
  const wholeRevision = await save([wholeUnit], "even");
  assert.deepEqual(await runConfig("admin", wholeUnit), { status: "whole_unit", revision: wholeRevision });
  // A revision naming only another unit's room: this unit is not in it and posts by PUBLIC_POWER_RULE.
  const elsewhere = await save([otherRoom], "even");
  assert.deepEqual(await runConfig("admin"), { status: "none", revision: elsewhere });
  const run = await prepareUtilityRun(staff("admin", "admin"), input);
  assert.equal("sharedMeter" in await inputsOf(run.runId), false);
  assert.equal((await inputsOf(run.runId)).publicKwhMilli, 1000);
  await voidOpen();
});

test("readings: the first period may take its total from the main meter minus the starting reading; missing or estimated readings, a later period without a total, or a selected room without a typed reading stop posting, nothing written", async () => {
  await flag(true);
  await resetRuns();
  await save([roomA, roomB], "sub_meter", "1000.5");
  const noTotal = runInput([[roomA, 100], [roomB, 50], [roomC, 10]], null);
  // No in-period main reading: blocked.
  let before = await billing();
  await assert.rejects(prepareUtilityRun(staff("admin", "admin"), noTotal), flowKey("errors.sharedMeterReadings"), "missing main reading");
  assert.deepEqual(await billing(), before);
  // An estimated in-period main reading: blocked.
  await db.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value,is_estimate) VALUES($1,$2,$3,1162.5,true)", [ORG_ID, mainMeter, next.end]);
  before = await billing();
  await assert.rejects(prepareUtilityRun(staff("admin", "admin"), noTotal), flowKey("errors.sharedMeterReadings"), "estimated main reading");
  assert.deepEqual(await billing(), before);
  // A real reading superseding it: seeded total 1162.5 − 1000.5 = 162 kWh; 2 kWh shared by sub-meter 100:50.
  const estimated = (await db.query("SELECT id FROM public.meter_readings WHERE meter_id=$1 AND is_estimate", [mainMeter])).rows[0].id;
  await db.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value,is_estimate,supersedes_id) VALUES($1,$2,$3,1162.5,false,$4)", [ORG_ID, mainMeter, next.end, estimated]);
  const config = await runConfig("admin");
  assert.deepEqual([config!.status, config!.firstPeriod, (config!.mainReading as { value: string; estimated: boolean }).estimated], ["applies", true, false]);
  const seeded = await prepareUtilityRun(staff("admin", "admin"), noTotal);
  const inputs = await inputsOf(seeded.runId);
  assert.equal(inputs.totalKwh, 162);
  assert.deepEqual((inputs.sharedMeter as Record<string, unknown>).sharesMilli, expectShares(2000, [100000, 50000]));
  assert.equal((inputs.sharedMeter as Record<string, unknown>).seededTotalMilli, 162000);
  await confirmUtilityRun(staff("admin", "admin"), seeded.runId);
  // The period after: no longer the first period, so a total must be typed.
  const later = runInput([[roomA, 100], [roomB, 50], [roomC, 10]], null, after);
  assert.equal((await runConfig("admin", unitId, after))!.firstPeriod, false);
  before = await billing();
  await assert.rejects(prepareUtilityRun(staff("admin", "admin"), later), flowKey("errors.sharedMeterReadings"), "later period needs a typed total");
  assert.deepEqual(await billing(), before);
  // A metered room without its typed reading is refused by posting itself, as before B-109b.
  before = await billing();
  await assert.rejects(prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100], [roomC, 10]], 161, after)), flowKey("errors.amount"), "room B has no reading");
  assert.deepEqual(await billing(), before);
  // A selected room that is not metered in this run (tenant pays the utility directly) cannot carry a share: blocked.
  await db.query("UPDATE public.rooms SET electricity_method='tenant_direct' WHERE id=$1", [roomB]);
  try {
    before = await billing();
    await assert.rejects(prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100], [roomC, 10]], 161, after)), flowKey("errors.sharedMeterReadings"), "room B has no line");
    assert.deepEqual(await billing(), before);
  } finally { await db.query("UPDATE public.rooms SET electricity_method='submeter' WHERE id=$1", [roomB]); }
  // With the total typed, the later period posts.
  const typed = await prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 163, after));
  assert.deepEqual(((await inputsOf(typed.runId)).sharedMeter as Record<string, unknown>).sharesMilli, expectShares(3000, [100000, 50000]));
  await voidOpen();
});

test("privileges and denials: service-only functions; staff admin/manager only; revoked, cross-org, tuple and app.env refused; read-only (no writes)", async () => {
  await flag(true);
  await resetRuns();
  await save([roomA, roomB], "even");
  for (const fn of ["app.b109_split_shares(jsonb,bigint,bigint)", "app.b109b_run_config(uuid,uuid,text,uuid,uuid,date,date)"]) {
    const r = (await db.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') anon, has_function_privilege('authenticated',$1,'EXECUTE') auth,
      has_function_privilege('service_role',$1,'EXECUTE') svc, p.prosecdef def, p.proconfig cfg FROM pg_proc p WHERE p.oid=$1::regprocedure`, [fn])).rows[0];
    assert.deepEqual([r.anon, r.auth, r.svc, r.def], [false, false, true, true], fn);
    assert.deepEqual(r.cfg, ["search_path=pg_catalog, pg_temp"], fn);
  }
  await assert.rejects(svc(null, async c => { await c.query("SET LOCAL ROLE authenticated"); await c.query(`SELECT ${SHARES}('[{"id":"a","weight":1}]'::jsonb,1,NULL)`); }), code("42501"));
  const before = await billing();
  assert.equal((await runConfig("admin"))!.status, "applies");
  assert.equal((await runConfig("manager"))!.status, "applies");
  for (const who of ["accountant", "maintenance", "tenant", "owner", "coastAdmin"]) await assert.rejects(runConfig(who), code("42501"), who);
  sid.revoked = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours',clock_timestamp())", [sid.revoked, USERS.admin, randomUUID()]);
  await assert.rejects(runConfig("revoked"), code("42501"), "revoked");
  await assert.rejects(runConfig("admin", unitId, next, { org: ORG2_ID }), code("42501"), "the other company");
  await assert.rejects(runConfig("coastAdmin", unitId, next, { org: ORG2_ID }), code("42501"), "the other company's admin, this company's unit");
  await assert.rejects(runConfig("admin", unitId, next, { live: ORG2_ID }), code("42501"), "tuple");
  await assert.rejects(runConfig("admin", unitId, next, { pin: null }), code("42501"), "no org pin");
  await assert.rejects(runConfig("admin", unitId, next, { pinEnv: "sandbox" }), code("42501"), "app.env");
  await assert.rejects(runConfig("admin", randomUUID()), code("42501"), "unknown unit");
  await assert.rejects(runConfig("admin", unitId, { start: next.end, end: next.start }), code("22023"), "bad period");
  // Accountants cannot post at all (posting's own guard), whatever the flag.
  await assert.rejects(prepareUtilityRun(staff("accountant", "accountant"), runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 161)));
  // The flag off: null (posting then never calls it).
  await flag(false, true);
  assert.equal(await runConfig("admin"), null);
  await flag(true);
  assert.deepEqual(await billing(), before, "read-only: nothing written by any call");
  // The split helper is exact and validates its input.
  const shares = await svc(null, async c => (await c.query(`SELECT ${SHARES}($1::jsonb,$2,$3) r`, [JSON.stringify([{ id: "a", weight: 2 }, { id: "b", weight: 1 }, { id: "c", weight: 0 }]), 1001, 1001])).rows[0].r);
  assert.deepEqual(shares.map((x: { milli: string; amount: string }) => [x.milli, x.amount]), [["668", "668"], ["333", "333"], ["0", "0"]]);
  const zero = await svc(null, async c => (await c.query(`SELECT ${SHARES}($1::jsonb,10,NULL) r`, [JSON.stringify([{ id: "a", weight: 0 }, { id: "b", weight: 0 }, { id: "c", weight: 0 }])])).rows[0].r);
  assert.deepEqual(zero.map((x: { milli: string }) => x.milli), ["4", "3", "3"], "all-zero weights split evenly, remainder to the first");
  for (const bad of ['[]', '[{"id":"a","weight":-1}]', '[{"weight":1}]', '[{"id":"a","weight":"1"}]', '{}'])
    await assert.rejects(svc(null, c => c.query(`SELECT ${SHARES}($1::jsonb,1,NULL)`, [bad])), code("22023"), bad);
  await assert.rejects(svc(null, c => c.query(`SELECT ${SHARES}('[{"id":"a","weight":1}]'::jsonb,-1,NULL)`)), code("22023"));
});

test("lock races (real holders, pid-matched waits, lock_timeout): a revoked session, a demoted member, a new revision, a swapped main meter or the flag turned off while waiting → refused / OFF; positive controls serialise", async () => {
  await flag(true);
  await resetRuns();
  await save([roomA, roomB], "even");
  const race = async (setup: (h: Client) => Promise<void>, who = "admin") => {
    const h = await holder();
    try {
      await setup(h);
      const pending = runConfig(who, unitId, next, { lockTimeout: "5s" }).then(x => x, e => e);
      await waitForBlocked(h);
      await h.query("COMMIT");
      return await pending;
    } finally { await h.end(); }
  };
  const before = await billing();
  // 1. The session revoked while the gateway waits on it.
  await session("racer", USERS.admin);
  assert.ok(code("42501")(await race(h => h.query("UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [sid.racer]).then(() => undefined), "racer")));
  // 2. The member demoted to accountant while the gateway waits on the membership row.
  await session("racer2", USERS.manager);
  assert.ok(code("42501")(await race(h => h.query("UPDATE public.org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]).then(() => undefined), "racer2")));
  await db.query("UPDATE public.org_members SET role='manager' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]);
  // Positive control: the same holder committing no change → serialised and admitted.
  assert.equal((await race(h => h.query("UPDATE public.org_members SET role=role WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]).then(() => undefined), "racer2") as Config)!.status, "applies");
  // 3. A new revision saved while the gateway waits (holder on a room row the gateway locks after the revisions):
  //    the locked revision set no longer equals the current one → refused.
  const latest = (await runConfig("admin"))!.revision as number;
  const insertRevision = (h: Client, method: string) => h.query(`INSERT INTO app.b109_shared_meter_configs(org_id,property_id,revision,space_ids,split_method,start_reading,effective_from,request_id,created_by)
    VALUES($1,$2,$3,$4,$5,0,$6,$7,$8)`, [ORG_ID, property, latest + 1, [roomA, roomB], method, next.start, randomUUID(), USERS.admin]);
  assert.ok(code("42501")(await race(async h => { await h.query("UPDATE public.rooms SET label=label WHERE id=$1", [roomC]); await insertRevision(h, "days_occupied"); })));
  // Positive control: committed before the call, the new revision is the one applied.
  const now = await runConfig("admin");
  assert.deepEqual([now!.status, now!.revision, now!.method], ["applies", latest + 1, "days_occupied"]);
  // 4. The main meter swapped while waiting (holder on the meter row): the locked meter set differs → refused.
  const newMeter = randomUUID();
  assert.ok(code("42501")(await race(async h => {
    await h.query("UPDATE public.meters SET archived_at=clock_timestamp() WHERE id=$1", [mainMeter]);
    await h.query(`INSERT INTO public.meters(id,org_id,property_id,unit_id,utility,usage_unit,payer,split_method,rate_source,rate_minor_per_unit)
      VALUES($1,$2,$3,$4,'electricity','kWh','owner','none','fixed_rate',500)`, [newMeter, ORG_ID, property, unitId]);
  })));
  await db.query("DELETE FROM public.meters WHERE id=$1", [newMeter]);
  await db.query("UPDATE public.meters SET archived_at=NULL WHERE id=$1", [mainMeter]);
  // 5. The flag turned off while waiting on the flag row → OFF (null), never applied.
  assert.equal(await race(h => h.query(`UPDATE public.platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb) WHERE key='shared_meter'`).then(() => undefined)), null);
  await flag(true);
  assert.equal((await runConfig("admin"))!.status, "applies", "positive control after the flag is back");
  // 6. Posting itself, end to end, with a holder on a room row: serialised, the split applied once, no partial write.
  const h = await holder();
  let run: { runId: string } | undefined;
  try {
    await h.query("UPDATE public.rooms SET label=label WHERE id=$1", [roomC]);
    const pending = prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 161)).then(x => x, e => e);
    await waitForBlocked(h);
    await h.query("COMMIT");
    run = await pending as { runId: string };
  } finally { await h.end(); }
  assert.ok(run?.runId, "serialised behind the holder");
  assert.equal(((await inputsOf(run.runId)).sharedMeter as { kwhMilli: number }).kwhMilli, 1000);
  assert.notDeepEqual(await billing(), before);
  await resetRuns();
});
