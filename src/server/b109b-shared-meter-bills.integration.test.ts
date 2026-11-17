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
import { BILL_GAP_DESCRIPTION, PUBLIC_ELECTRICITY_DESCRIPTION, VACANT_ELECTRICITY_DESCRIPTION } from "./utility-expense";
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
let leaseA: string, leaseB: string, leaseB0: string, days: number;
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
/** What an issued bill is: utility bills, run lines, invoice headers and lines, owner expenses (run headers excluded). */
const issuedSnapshot = async () => (await db.query(`SELECT
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.utility_bills x) utility_bills,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.utility_allocation_lines x) run_lines,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.invoices x) invoices,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.invoice_lines x) invoice_lines,
  (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY x.id),'')) FROM public.expenses x) expenses`)).rows[0] as Record<string, string>;
/** The billing rows only (the revisions excluded): what a refused posting must leave unchanged. */
async function billingRows() { const all: Record<string, string | undefined> = { ...await billing() }; delete all.configs; return all; }
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
// Hand oracles, independent of the posting code: TWD prices whole NT$, half-up, on kWh × rate.
/** rateTenths: the typed rate in tenths of NT$ (5 → 50, 4.4 → 44). */
const price = (milli: number, rateTenths = 50) => Math.floor((milli * rateTenths + 5000) / 10000) * 100;
/** A room's kWh between occupants by days: floors, then the leftover units to the largest remainders (ties by key). */
function byDays(total: number, parts: { key: string; days: number }[]) {
  if (parts.length === 1) return new Map([[parts[0].key, total]]);
  const sum = parts.reduce((a, p) => a + p.days, 0);
  const rows = parts.map(p => ({ key: p.key, floor: Math.floor(total * p.days / sum), frac: (total * p.days) % sum }));
  let left = total - rows.reduce((a, r) => a + r.floor, 0);
  for (const r of [...rows].sort((a, b) => a.frac !== b.frac ? b.frac - a.frac : a.key < b.key ? -1 : 1)) { if (left <= 0) break; r.floor += 1; left -= 1; }
  return new Map(rows.map(r => [r.key, r.floor]));
}
/** meter_readings is append-only: a test that needs no main reading gets a fresh main meter (the old one archived). */
async function clearMainReadings() {
  await db.query("UPDATE public.meters SET archived_at=clock_timestamp() WHERE id=$1", [mainMeter]);
  mainMeter = (await db.query(`INSERT INTO public.meters(org_id,property_id,unit_id,utility,usage_unit,payer,split_method,rate_source,rate_minor_per_unit)
    VALUES($1,$2,$3,'electricity','kWh','owner','none','fixed_rate',500) RETURNING id`, [ORG_ID, property, unitId])).rows[0].id;
}
const mainReading = (on: string, value: number, estimate = false) =>
  db.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value,is_estimate) VALUES($1,$2,$3,$4,$5) RETURNING id", [ORG_ID, mainMeter, on, value, estimate]);
const day = (period: { start: string }, n: number) => `${period.start.slice(0, 8)}${String(n).padStart(2, "0")}`;
/** A revision written directly (fixture only): for ids the save gateway would refuse (a missing room). */
const rawRevision = async (spaces: string[], method = "even") => {
  const revision = (await db.query("SELECT coalesce(max(revision),0)+1 r FROM app.b109_shared_meter_configs WHERE property_id=$1", [property])).rows[0].r;
  await db.query(`INSERT INTO app.b109_shared_meter_configs(org_id,property_id,revision,space_ids,split_method,start_reading,effective_from,request_id,created_by)
    VALUES($1,$2,$3,$4,$5,0,$6,$7,$8)`, [ORG_ID, property, revision, spaces, method, next.start, randomUUID(), USERS.admin]);
  return revision as number;
};
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
  // Tenants: A from this month for a year (all of next month); B two tenants (below). C stays vacant.
  const lease = async (room: string, start: string, name: string, n: number) => {
    const l = await createLeaseFromForm(staff("admin", "admin"), form({ tenantName: name, tenantPhone: `09120000${10 + n}`, tenantEmail: `b109b.t${n}@example.com`,
      lineUserId: "", startDate: start, months: "12", rent: "9000", depositMonths: "2", depositReason: "", dueDay: "5", splitMethod: "even",
      billTotal: "", usage: "", rate: "", overrideReason: "", roomId: room }));
    await db.query("UPDATE public.leases SET status='active', esign_status='fully_signed', signed_at=coalesce(signed_at,now()) WHERE id=$1", [l.leaseId]);
    return l.leaseId as string;
  };
  leaseA = await lease(roomA, thisMonth.start, "王小明", 1);
  // B has an earlier tenant until the 5th of next month, then another from the 11th: two occupants with unequal days.
  leaseB0 = await lease(roomB, thisMonth.start, "張家豪", 3);
  await db.query("UPDATE public.leases SET end_date=$2 WHERE id=$1", [leaseB0, day(next, 5)]);
  leaseB = await lease(roomB, `${next.start.slice(0, 8)}11`, "林美玲", 2);
  days = Number(next.end.slice(8));
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

test("fixture: one by-room unit with three rooms, three tenants (two in B), a main meter; periods", async () => {
  assert.ok(property && unitId && mainMeter && leaseA && leaseB && leaseB0);
  assert.ok(next.start > thisMonth.start && after.start > next.start);
});

// The B-109b DB tests share one unit, so each starts from no live run and no main reading.
async function fresh() { await flag(true); await resetRuns(); await clearMainReadings(); }
const R = { A: 100.1, B: 50.1, C: 10 }, OWN = { A: 100100, B: 50100, C: 10000 }, TOTAL = 161.201, SHARED = 1001;
const readings = (): [string, number][] => [[roomA, R.A], [roomB, R.B], [roomC, R.C]];
/** The expected lines (label, lease, bearer, kWh milli, amount) for own kWh plus shares[A,B], at rateTenths. */
function expectedLines(shareA: number, shareB: number, rateTenths: number) {
  const bOwn = byDays(OWN.B, [{ key: leaseB0, days: 5 }, { key: leaseB, days: days - 10 }]);
  const bShared = byDays(shareB, [{ key: leaseB0, days: 5 }, { key: leaseB, days: days - 10 }]);
  const b = [leaseB0, leaseB].sort().map(lease => ["B", lease, "tenant", bOwn.get(lease)! + bShared.get(lease)!]);
  return [["A", leaseA, "tenant", OWN.A + shareA], ...b, ["C", null, "owner", OWN.C]].map(([label, lease, bearer, milli]) =>
    [label, lease, bearer, String(milli), String(price(milli as number, rateTenths))]);
}
const lineRows = async (runId: string) => (await lines(runId)).map(r => [r.label, r.lease, r.bearer, r.milli, r.amount]);
const sharedKwhOf = async (runId: string) => (await lines(runId)).map(r => r.explanation.sharedKwh ?? null);

test("OFF: equals a hand-computed legacy oracle (lines, 公共用電, gap, owner expenses, tenant invoice lines); no gateway call (EXECUTE revoked)", async () => {
  await fresh();
  await save([roomA, roomB], "even");
  await mainReading(next.end, 500);
  // The legacy path: PUBLIC_POWER_RULE keeps total − room meters with the owner; every line is its own kWh.
  const legacy = expectedLines(0, 0, 50);
  const roomTotal = legacy.reduce((a, l) => a + Number(l[4]), 0), publicMinor = price(SHARED), bill = 81000;
  const outputs: unknown[] = [];
  // Any call to the B-109b functions while OFF would now fail with 42501.
  await db.query("REVOKE EXECUTE ON FUNCTION app.b109b_run_config(uuid,uuid,text,uuid,uuid,date,date), app.b109_split_shares(jsonb,bigint,bigint) FROM service_role");
  try {
    for (const [platform, org] of [[false, false], [true, false], [false, true]] as const) {
      await resetRuns();
      await flag(platform, org);
      const run = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, next, { billTotalMajor: bill / 100 }));
      const inputs = await inputsOf(run.runId);
      assert.equal("sharedMeter" in inputs, false);
      assert.deepEqual([inputs.totalKwh, inputs.publicKwhMilli, inputs.publicAmountMinor, inputs.billGapMinor], [TOTAL, SHARED, publicMinor, bill - roomTotal - publicMinor]);
      assert.deepEqual(await lineRows(run.runId), legacy, `lines (platform ${platform}, org ${org})`);
      assert.deepEqual(await sharedKwhOf(run.runId), legacy.map(() => null));
      const usage = (await db.query("SELECT r.total_usage::text run, b.total_usage::text bill, b.total_amount_minor::text amount FROM public.utility_allocation_runs r JOIN public.utility_bills b ON b.id=r.utility_bill_id WHERE r.id=$1", [run.runId])).rows[0];
      assert.deepEqual([Number(usage.run), Number(usage.bill), usage.amount], [160.2, 160.2, String(bill)], "legacy usage: the room meters");
      await confirmUtilityRun(staff("admin", "admin"), run.runId);
      // Earlier iterations' runs were voided (with their expenses), so the live expenses are this run's.
      const expenses = Object.fromEntries((await db.query(`SELECT description, sum(amount_minor)::text amount FROM public.expenses
        WHERE property_id=$1 AND status::text<>'void' GROUP BY description`, [property])).rows.map(r => [r.description, r.amount]));
      assert.deepEqual(expenses, { [PUBLIC_ELECTRICITY_DESCRIPTION]: String(publicMinor), [VACANT_ELECTRICITY_DESCRIPTION]: legacy.find(l => l[0] === "C")![4],
        [BILL_GAP_DESCRIPTION]: String(bill - roomTotal - publicMinor) }, "owner expense lines");
      const invoiced = (await db.query(`SELECT l.lease_id::text lease, il.amount_minor::text amount FROM public.utility_allocation_lines l
        JOIN public.invoice_lines il ON il.id=l.posted_invoice_line_id WHERE l.run_id=$1 ORDER BY l.lease_id`, [run.runId])).rows.map(r => [r.lease, r.amount]);
      assert.deepEqual(invoiced, legacy.filter(l => l[2] === "tenant").map(l => [l[1], l[4]]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1), "tenant invoice lines");
      outputs.push({ inputs, lines: await lineRows(run.runId), expenses, invoiced });
    }
  } finally {
    await db.query("GRANT EXECUTE ON FUNCTION app.b109b_run_config(uuid,uuid,text,uuid,uuid,date,date), app.b109_split_shares(jsonb,bigint,bigint) TO service_role");
  }
  assert.deepEqual(outputs[1], outputs[0], "org off == both off");
  assert.deepEqual(outputs[2], outputs[0], "platform off == both off");
  // Control: ON, the same revoked grant makes posting fail, so the OFF passes above really made no call.
  await resetRuns(); await flag(true);
  await db.query("REVOKE EXECUTE ON FUNCTION app.b109b_run_config(uuid,uuid,text,uuid,uuid,date,date) FROM service_role");
  try { await assert.rejects(prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL))); }
  finally { await db.query("GRANT EXECUTE ON FUNCTION app.b109b_run_config(uuid,uuid,text,uuid,uuid,date,date) TO service_role"); }
});

test("ON, each method, a typed rate unlike the configured one: shares (remainder to the first room) go to the selected rooms, then to each occupant by days; priced once at the typed rate; unselected room unchanged", async () => {
  await fresh();
  await mainReading(next.end, 500);
  assert.equal((await db.query("SELECT rate_per_kwh::text r FROM public.rooms WHERE id=$1", [roomA])).rows[0].r.replace(/\.0+$/, ""), "5", "configured 5; typed 4.4");
  for (const [method, weights] of [["even", [1, 1]], ["days_occupied", [days, days - 5]], ["sub_meter", [OWN.A, OWN.B]]] as const) {
    await resetRuns();
    const revision = await save([roomB, roomA], method);
    const run = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, next, { rateMajor: 4.4 }));
    const shares = expectShares(SHARED, [...weights]);
    const inputs = await inputsOf(run.runId);
    assert.deepEqual(inputs.sharedMeter, { revision, method, roomIds: [roomA, roomB], weights: weights.map(String), sharesMilli: shares, kwhMilli: SHARED, seededTotalMilli: null }, method);
    assert.deepEqual([inputs.publicKwhMilli, inputs.publicAmountMinor, inputs.rate], [0, 0, 4.4]);
    assert.deepEqual(await lineRows(run.runId), expectedLines(shares[0], shares[1], 44), method);
    const bShared = byDays(shares[1], [{ key: leaseB0, days: 5 }, { key: leaseB, days: days - 10 }]);
    assert.deepEqual(await sharedKwhOf(run.runId), [shares[0], ...[leaseB0, leaseB].sort().map(l => bShared.get(l)!), null].map(x => x === null ? null : x / 1000));
    const usage = (await db.query("SELECT total_usage::text u FROM public.utility_allocation_runs WHERE id=$1", [run.runId])).rows[0].u;
    assert.equal(Number(usage), TOTAL, "billed usage: room meters + shared kWh");
    const preview = await call<{ status: string; rows: { id: string; kwh: string }[] }>("app.b109_shared_meter_split", "admin", [property, next.start, String(SHARED / 1000), null]);
    assert.deepEqual(preview.rows.map(r => [r.id, Math.round(Number(r.kwh) * 1000)]), [[roomA, shares[0]], [roomB, shares[1]]], `${method} preview aligned`);
    // Confirmed: each tenant is invoiced its own + shared kWh at the typed rate; the owner gets no 公共用電 (all of it
    // went to the selected rooms); the unselected vacant room C keeps its own owner expense.
    await confirmUtilityRun(staff("admin", "admin"), run.runId);
    const expected = expectedLines(shares[0], shares[1], 44);
    const invoiced = (await db.query(`SELECT l.lease_id::text lease, il.amount_minor::text amount FROM public.utility_allocation_lines l
      JOIN public.invoice_lines il ON il.id=l.posted_invoice_line_id WHERE l.run_id=$1 ORDER BY l.lease_id`, [run.runId])).rows.map(r => [r.lease, r.amount]);
    assert.deepEqual(invoiced, expected.filter(l => l[2] === "tenant").map(l => [l[1], l[4]]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1), `${method} tenant invoices`);
    const expenses = Object.fromEntries((await db.query(`SELECT description, sum(amount_minor)::text amount FROM public.expenses
      WHERE property_id=$1 AND status::text<>'void' GROUP BY description`, [property])).rows.map(r => [r.description, r.amount]));
    assert.deepEqual(expenses, { [VACANT_ELECTRICITY_DESCRIPTION]: expected.find(l => l[0] === "C")![4] }, `${method}: no 公共用電; C's own owner expense`);
  }
  // These numbers make pricing once matter: own and shared priced separately would differ for room A.
  const even = expectShares(SHARED, [1, 1]);
  assert.notEqual(price(OWN.A, 44) + price(even[0], 44), price(OWN.A + even[0], 44));
});

test("the per-kWh cap (Taipower bill average) is checked once, on every billed kWh: binding with the split, not without; one override record", async () => {
  // Bill NT$803: over the room meters only (160.2 kWh) the average is above NT$5; over all 161.201 kWh billed it is below.
  await fresh();
  await mainReading(next.end, 500);
  await save([roomA, roomB], "even");
  const capOf = async (runId: string) => (await db.query(`SELECT r.rate_exceeds_cap, r.cap_minor_per_unit::text cap, r.cap_override_reason IS NOT NULL overridden,
      b.total_usage::text usage, (SELECT count(*)::int FROM public.rule_check_results x WHERE x.entity_id=r.id) checks
    FROM public.utility_allocation_runs r JOIN public.utility_bills b ON b.id=r.utility_bill_id WHERE r.id=$1`, [runId])).rows[0];
  const on = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, next, { billTotalMajor: 803 }));
  let cap = await capOf(on.runId);
  assert.deepEqual([cap.rate_exceeds_cap, cap.overridden, Number(cap.usage), cap.checks], [true, true, TOTAL, 1]);
  assert.ok(Number(cap.cap) < 500 && Math.abs(Number(cap.cap) - 80300 / TOTAL) < 0.000001);
  // Recomputing the same open run keeps one override record; the lines are priced once at the typed rate.
  const again = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, next, { billTotalMajor: 803 }));
  assert.equal(again.runId, on.runId);
  cap = await capOf(on.runId);
  assert.equal(cap.checks, 1);
  const shares = expectShares(SHARED, [1, 1]);
  assert.deepEqual(await lineRows(on.runId), expectedLines(shares[0], shares[1], 50));
  await confirmUtilityRun(staff("admin", "admin"), on.runId);
  // Without the split (OFF), the same bill is not over the cap (the legacy usage is the room meters).
  await resetRuns(); await flag(false);
  const off = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, next, { billTotalMajor: 803 }));
  cap = await capOf(off.runId);
  assert.deepEqual([cap.rate_exceeds_cap, Number(cap.usage), cap.checks], [false, 160.2, 0]);
  await flag(true);
});

test("a negative shared kWh (room meters above the total) stays an owner credit; nothing is split", async () => {
  await fresh();
  await mainReading(next.end, 500);
  await save([roomA, roomB], "even");
  const run = await prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, 100], [roomB, 50], [roomC, 10]], 150));
  const inputs = await inputsOf(run.runId);
  assert.equal(inputs.publicKwhMilli, -10000);
  assert.deepEqual([(inputs.sharedMeter as { sharesMilli: number[] }).sharesMilli, (inputs.sharedMeter as { kwhMilli: number }).kwhMilli], [[0, 0], 0]);
  assert.deepEqual((await lines(run.runId)).map(r => Number(r.milli)), [100000, ...[leaseB0, leaseB].sort().map(l => byDays(50000, [{ key: leaseB0, days: 5 }, { key: leaseB, days: days - 10 }]).get(l)!), 10000]);
});

test("issued bills never change. A same-period re-prepare of an issued run is a correction that keeps the split it was issued with: after a revision change (and with the flag off), the same inputs reproduce the issued bill, run lines, invoices, invoice lines and expenses exactly; refused postings write nothing", async () => {
  await fresh();
  await mainReading(next.end, 500);
  const issuedRevision = await save([roomA, roomB], "even");
  const input = { ...runInput(readings(), TOTAL, next, { billTotalMajor: 810 }) };
  const issued = await prepareUtilityRun(staff("admin", "admin"), input);
  await confirmUtilityRun(staff("admin", "admin"), issued.runId);
  const counts = (await db.query(`SELECT (SELECT count(*)::int FROM public.utility_allocation_lines WHERE run_id=$1) lines,
      (SELECT count(*)::int FROM public.utility_bills b JOIN public.utility_allocation_runs r ON r.utility_bill_id=b.id WHERE r.id=$1) bills,
      (SELECT count(DISTINCT posted_invoice_id)::int FROM public.utility_allocation_lines WHERE run_id=$1 AND posted_invoice_id IS NOT NULL) invoices,
      (SELECT count(*)::int FROM public.utility_allocation_lines WHERE run_id=$1 AND posted_invoice_line_id IS NOT NULL) invoice_lines,
      (SELECT count(*)::int FROM public.expenses WHERE property_id=$2 AND status::text<>'void') expenses`, [issued.runId, property])).rows[0];
  assert.deepEqual([counts.lines, counts.bills, counts.invoice_lines], [4, 1, 3], "a non-empty issued fixture: 4 lines, its utility bill, 3 tenant invoice lines");
  assert.ok(counts.invoices > 0 && counts.expenses > 0, "invoice headers and owner expenses exist");
  const before = await issuedSnapshot();
  // A valid revision change (other rooms, other method) and flag toggles write nothing.
  await save([roomA, roomC], "sub_meter");
  await flag(false); await flag(true);
  assert.deepEqual(await issuedSnapshot(), before, "revision and flag changes");
  // An authorized same-period re-prepare (admin, the issued run as source, the same inputs): a correction draft that
  // keeps the issued split (revision, method, rooms), so every issued row is reproduced exactly.
  const again = await prepareUtilityRun(staff("admin", "admin"), { ...input, sourceRunId: issued.runId });
  assert.equal(again.runId, issued.runId);
  assert.deepEqual(((await inputsOf(issued.runId)).sharedMeter as { revision: number; method: string; roomIds: string[] }), {
    ...((await inputsOf(issued.runId)).sharedMeter as object), revision: issuedRevision, method: "even", roomIds: [roomA, roomB] });
  assert.deepEqual(await issuedSnapshot(), before, "authorized re-prepare after a revision change");
  // The same with the flag off and a revision that would now block a new run.
  await save([roomA, otherRoom], "even");
  await flag(false);
  await prepareUtilityRun(staff("admin", "admin"), { ...input, sourceRunId: issued.runId });
  assert.deepEqual(await issuedSnapshot(), before, "authorized re-prepare, flag off, spanning revision");
  // Confirming that unchanged correction changes no issued row either.
  await confirmUtilityRun(staff("admin", "admin"), issued.runId);
  assert.deepEqual(await issuedSnapshot(), before, "confirming an unchanged correction");
  await flag(true);
  // Refused postings for the issued period write nothing at all: an accountant; a revoked session.
  const all = await billingRows();
  await assert.rejects(prepareUtilityRun(staff("accountant", "accountant"), { ...input, sourceRunId: issued.runId }));
  await session("gone", USERS.admin);
  await db.query("UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [sid.gone]);
  await assert.rejects(prepareUtilityRun({ ...staff("admin", "admin"), sessionId: sid.gone }, { ...input, sourceRunId: issued.runId }));
  assert.deepEqual(await billingRows(), all, "refused postings write nothing");
  // The period before the revision's effective date is not governed by it.
  await save([roomA, roomB], "even");
  const current = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, thisMonth));
  assert.deepEqual([("sharedMeter" in await inputsOf(current.runId)), (await inputsOf(current.runId)).publicKwhMilli], [false, SHARED]);
});

test("admission by period start, and corrections keep their method: a straddling period is not governed; a later-starting one is; a correction of a run computed OFF stays without the split", async () => {
  await fresh();
  await save([roomA, roomB], "even");
  // Straddles the effective date (starts mid this month, ends mid next month): not governed (period start rule).
  const straddle = { start: day(thisMonth, 15), end: day(next, 14) };
  assert.deepEqual(await runConfig("admin", unitId, straddle), { status: "none" });
  const s1 = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, straddle));
  assert.deepEqual([("sharedMeter" in await inputsOf(s1.runId)), (await inputsOf(s1.runId)).publicKwhMilli], [false, SHARED]);
  // Starts after the effective date and ends next-next month: governed.
  const later = { start: day(next, 15), end: day(after, 14) };
  await mainReading(day(after, 14), 500);
  assert.equal((await runConfig("admin", unitId, later))!.status, "applies");
  const s2 = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, later));
  assert.equal(((await inputsOf(s2.runId)).sharedMeter as { kwhMilli: number }).kwhMilli, SHARED);
  // The B-109 preview for the month: the unit's runs only overlap it (neither is exactly this month), so 依分表度數
  // reports the ambiguity instead of picking one.
  await save([roomA, roomB], "sub_meter");
  const preview = await call<{ status: string; spaces: { id: string; problem: string }[] }>("app.b109_shared_meter_split", "admin", [property, next.start, "1", null]);
  assert.deepEqual([preview.status, preview.spaces], ["ambiguous_runs", [{ id: roomA, problem: "ambiguous_run" }, { id: roomB, problem: "ambiguous_run" }]]);
  // A run of an eligible period computed with the flag OFF, issued, then corrected with the flag ON: the correction
  // keeps the method its issued bill used (no split).
  await resetRuns(); await clearMainReadings(); await mainReading(next.end, 500);
  await flag(false);
  const offRun = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, next, { billTotalMajor: 810 }));
  await confirmUtilityRun(staff("admin", "admin"), offRun.runId);
  await flag(true);
  assert.equal((await runConfig("admin"))!.status, "applies", "the period is eligible");
  const corrected = await prepareUtilityRun(staff("admin", "admin"), { ...runInput([[roomA, 100.1], [roomB, 50.1], [roomC, 11]], 162.201, next, { billTotalMajor: 810 }), sourceRunId: offRun.runId });
  assert.equal(corrected.runId, offRun.runId);
  let inputs = await inputsOf(corrected.runId);
  assert.deepEqual([("sharedMeter" in inputs), inputs.publicKwhMilli], [false, SHARED]);
  // Symmetric: a run issued WITH the split, corrected after the revision changed and the flag went off (and again
  // with a revision that would block a new run), keeps the split it was issued with.
  await resetRuns();
  const issuedRevision = await save([roomA, roomB], "even");
  const shared = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), TOTAL, next, { billTotalMajor: 810 }));
  await confirmUtilityRun(staff("admin", "admin"), shared.runId);
  await save([roomA, roomC], "sub_meter");
  await flag(false);
  const kept = await prepareUtilityRun(staff("admin", "admin"), { ...runInput([[roomA, 100.1], [roomB, 50.1], [roomC, 11]], 162.201, next, { billTotalMajor: 810 }), sourceRunId: shared.runId });
  inputs = await inputsOf(kept.runId);
  const shares = expectShares(SHARED, [1, 1]);
  assert.deepEqual(inputs.sharedMeter, { revision: issuedRevision, method: "even", roomIds: [roomA, roomB], weights: ["1", "1"], sharesMilli: shares, kwhMilli: SHARED, seededTotalMilli: null });
  assert.equal(inputs.publicKwhMilli, 0);
  const rows = await lineRows(kept.runId);
  assert.deepEqual(rows.filter(r => r[0] !== "C"), expectedLines(shares[0], shares[1], 50).filter(r => r[0] !== "C"));
  assert.deepEqual(rows.find(r => r[0] === "C"), ["C", null, "owner", "11000", String(price(11000))], "C corrected, still unselected");
  await flag(true);
  await save([roomA, otherRoom], "even");
  await prepareUtilityRun(staff("admin", "admin"), { ...runInput([[roomA, 100.1], [roomB, 50.1], [roomC, 11]], 162.201, next, { billTotalMajor: 810 }), sourceRunId: shared.runId });
  assert.equal(((await inputsOf(kept.runId)).sharedMeter as { revision: number }).revision, issuedRevision, "a spanning revision does not block or change a correction");
});

test("blocked shapes, each through prepareUtilityRun with nothing written: spans units; names a whole unit; the whole unit's own run; an archived or missing selected room (even all of them); 平均分攤 under a revision", async () => {
  await fresh();
  await mainReading(next.end, 500);
  const input = runInput(readings(), TOTAL);
  const blocked = async (key: string, run: () => Promise<unknown>, label: string) => {
    const before = await billing();
    await assert.rejects(run(), flowKey(key), label);
    assert.deepEqual(await billing(), before, `${label}: nothing written`);
  };
  await save([roomA, otherRoom], "even");
  await blocked("errors.sharedMeterUnits", () => prepareUtilityRun(staff("admin", "admin"), input), "spans two units");
  await save([roomA, wholeUnit], "even");
  await blocked("errors.sharedMeterUnits", () => prepareUtilityRun(staff("admin", "admin"), input), "names a whole unit too");
  // The whole unit's own run under a revision naming it.
  await save([wholeUnit], "even");
  await db.query("UPDATE public.units SET electricity_method='submeter' WHERE id=$1", [wholeUnit]);
  await blocked("errors.sharedMeterUnits", () => prepareUtilityRun(staff("admin", "admin"), { ...runInput([[wholeUnit, 100]], 100), unitId: wholeUnit }), "whole unit only");
  // Archived selected room: one of two, then the only one (never 'none', never PUBLIC_POWER_RULE).
  await save([roomA, roomB], "even");
  await db.query("UPDATE public.rooms SET archived_at=clock_timestamp() WHERE id=$1", [roomB]);
  try {
    assert.equal((await runConfig("admin"))!.status, "unavailable_rooms");
    await blocked("errors.sharedMeterRooms", () => prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, R.A], [roomC, R.C]], TOTAL)), "one archived");
    await rawRevision([roomB]);
    assert.equal((await runConfig("admin"))!.status, "unavailable_rooms", "all selected rooms archived");
    await blocked("errors.sharedMeterRooms", () => prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, R.A], [roomC, R.C]], TOTAL)), "all archived");
  } finally { await db.query("UPDATE public.rooms SET archived_at=NULL WHERE id=$1", [roomB]); }
  // A selected id that no longer exists.
  await rawRevision([roomA, randomUUID()]);
  await blocked("errors.sharedMeterRooms", () => prepareUtilityRun(staff("admin", "admin"), input), "missing room");
  // 平均分攤 (every room 'even') under a revision for this unit; and under one spanning units.
  await db.query("UPDATE public.rooms SET electricity_method='even' WHERE unit_id=$1", [unitId]);
  try {
    const even = runInput([], null, next, { billTotalMajor: 900 });
    await save([roomA, roomB], "even");
    await blocked("errors.sharedMeterMode", () => prepareUtilityRun(staff("admin", "admin"), even), "even split under a revision");
    await save([roomA, otherRoom], "even");
    await blocked("errors.sharedMeterUnits", () => prepareUtilityRun(staff("admin", "admin"), even), "even split, spanning revision");
    // Positive control: with a revision not naming this unit, the even split posts as before.
    await save([otherRoom], "even");
    const run = await prepareUtilityRun(staff("admin", "admin"), even);
    assert.equal("sharedMeter" in await inputsOf(run.runId), false);
  } finally { await db.query("UPDATE public.rooms SET electricity_method='submeter' WHERE unit_id=$1", [unitId]); }
  // A selected room without a line in a metered run (tenant pays directly).
  await save([roomA, roomB], "even");
  await db.query("UPDATE public.rooms SET electricity_method='tenant_direct' WHERE id=$1", [roomB]);
  try { await blocked("errors.sharedMeterReadings", () => prepareUtilityRun(staff("admin", "admin"), runInput([[roomA, R.A], [roomC, R.C]], TOTAL)), "room B has no line"); }
  finally { await db.query("UPDATE public.rooms SET electricity_method='submeter' WHERE id=$1", [roomB]); }
});

test("readings: an actual main reading is required in every period (typed total or not); the first period may seed its total; a later period needs a typed total; a backfill before a later run is not the first period", async () => {
  await fresh();
  await save([roomA, roomB], "sub_meter", "1000.5");
  const blocked = async (input: UtilityRunInput, label: string) => {
    const before = await billing();
    await assert.rejects(prepareUtilityRun(staff("admin", "admin"), input), flowKey("errors.sharedMeterReadings"), label);
    assert.deepEqual(await billing(), before, `${label}: nothing written`);
  };
  // First period, no main reading: blocked with or without a typed total.
  await blocked(runInput(readings(), null), "no main reading, no total");
  await blocked(runInput(readings(), TOTAL), "no main reading, typed total");
  // Estimated: blocked, typed or not. Below the starting reading: blocked.
  const est = (await mainReading(next.end, 1162.5, true)).rows[0].id;
  await blocked(runInput(readings(), null), "estimated, no total");
  await blocked(runInput(readings(), TOTAL), "estimated, typed total");
  const low = (await db.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value,is_estimate,supersedes_id) VALUES($1,$2,$3,999,false,$4) RETURNING id", [ORG_ID, mainMeter, next.end, est])).rows[0].id;
  await blocked(runInput(readings(), TOTAL), "below the starting reading");
  // An actual reading superseding it: seeded total 1162.5 − 1000.5 = 162 kWh.
  await db.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value,is_estimate,supersedes_id) VALUES($1,$2,$3,1162.5,false,$4)", [ORG_ID, mainMeter, next.end, low]);
  const config = await runConfig("admin");
  assert.deepEqual([config!.status, config!.firstPeriod, (config!.mainReading as { estimated: boolean }).estimated], ["applies", true, false]);
  const seeded = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), null));
  let inputs = await inputsOf(seeded.runId);
  assert.equal(inputs.totalKwh, 162);
  assert.deepEqual((inputs.sharedMeter as Record<string, unknown>).sharesMilli, expectShares(162000 - 160200, [OWN.A, OWN.B]));
  assert.equal((inputs.sharedMeter as Record<string, unknown>).seededTotalMilli, 162000);
  await confirmUtilityRun(staff("admin", "admin"), seeded.runId);
  // The period after: a typed total does not excuse a missing or an estimated main reading.
  assert.deepEqual([(await runConfig("admin", unitId, after))!.firstPeriod, (await runConfig("admin", unitId, after))!.mainReading], [false, null]);
  await blocked(runInput(readings(), 163, after), "later period, typed total, no main reading");
  const laterEst = (await mainReading(after.end, 1330.5, true)).rows[0].id;
  await blocked(runInput(readings(), 163, after), "later period, typed total, estimated main reading");
  // With a VALID main reading: not the first period, so only the missing typed total blocks.
  await db.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value,is_estimate,supersedes_id) VALUES($1,$2,$3,1330.5,false,$4)", [ORG_ID, mainMeter, after.end, laterEst]);
  const later = await runConfig("admin", unitId, after);
  assert.deepEqual([later!.firstPeriod, (later!.mainReading as { estimated: boolean }).estimated], [false, false]);
  await blocked(runInput(readings(), null, after), "later period needs a typed total");
  const typed = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), 163, after));
  inputs = await inputsOf(typed.runId);
  assert.deepEqual([inputs.totalKwh, (inputs.sharedMeter as Record<string, unknown>).sharesMilli], [163, expectShares(2800, [OWN.A, OWN.B])]);
  // Backfill: with the later run live, the first period's own run voided and re-prepared is no longer the first period.
  await voidUtilityRun(staff("admin", "admin"), seeded.runId, "測試重設");
  assert.equal((await runConfig("admin"))!.firstPeriod, false, "a later run used the baseline");
  await blocked(runInput(readings(), null), "backfill cannot seed from the starting reading");
  const backfill = await prepareUtilityRun(staff("admin", "admin"), runInput(readings(), 162));
  assert.equal(((await inputsOf(backfill.runId)).sharedMeter as Record<string, unknown>).seededTotalMilli, null);
});

test("privileges and denials: service-only functions; staff admin/manager only; revoked, cross-org, tuple and app.env refused; read-only; the split helper validates (a missing weight included)", async () => {
  await fresh();
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
  // The unit and its property are re-checked live on the locked rows.
  for (const [table, id] of [["units", unitId], ["properties", property]] as const) {
    await db.query(`UPDATE public.${table} SET archived_at=clock_timestamp() WHERE id=$1`, [id]);
    try { await assert.rejects(runConfig("admin"), code("42501"), `archived ${table}`); }
    finally { await db.query(`UPDATE public.${table} SET archived_at=NULL WHERE id=$1`, [id]); }
  }
  assert.equal((await runConfig("admin"))!.status, "applies", "positive control after restoring");
  await assert.rejects(prepareUtilityRun(staff("accountant", "accountant"), runInput(readings(), TOTAL)));
  await flag(false, true);
  assert.equal(await runConfig("admin"), null, "flag off: null");
  await flag(true);
  assert.deepEqual(await billing(), before, "read-only: nothing written by any call");
  const shares = await svc(null, async c => (await c.query(`SELECT ${SHARES}($1::jsonb,$2,$3) r`, [JSON.stringify([{ id: "a", weight: 2 }, { id: "b", weight: 1 }, { id: "c", weight: 0 }]), 1001, 1001])).rows[0].r);
  assert.deepEqual(shares.map((x: { milli: string; amount: string }) => [x.milli, x.amount]), [["668", "668"], ["333", "333"], ["0", "0"]]);
  const zero = await svc(null, async c => (await c.query(`SELECT ${SHARES}($1::jsonb,10,NULL) r`, [JSON.stringify([{ id: "a", weight: 0 }, { id: "b", weight: 0 }, { id: "c", weight: 0 }])])).rows[0].r);
  assert.deepEqual(zero.map((x: { milli: string }) => x.milli), ["4", "3", "3"], "all-zero weights split evenly, remainder to the first");
  for (const bad of ['[]', '[{"id":"a","weight":-1}]', '[{"weight":1}]', '[{"id":"a","weight":"1"}]', '[{"id":"a"}]', '[{"id":"a","weight":null}]', '[{"id":"a","weight":1},{"id":"b"}]', '{}'])
    await assert.rejects(svc(null, c => c.query(`SELECT ${SHARES}($1::jsonb,1,NULL)`, [bad])), code("22023"), bad);
  await assert.rejects(svc(null, c => c.query(`SELECT ${SHARES}('[{"id":"a","weight":1}]'::jsonb,-1,NULL)`)), code("22023"));
});

test("lock races, each through prepareUtilityRun with real holders, pid-matched waits and billing snapshots: revoked session, demoted member, new revision, swapped main meter → refused, nothing written; the flag turned off mid-wait → serialised OFF posting", async () => {
  await fresh();
  await mainReading(next.end, 500);
  await save([roomA, roomB], "even");
  const input = runInput(readings(), TOTAL, next, { billTotalMajor: 810 });
  /** Holder first, then posting; the holder commits once posting waits on it. Posting's result or error. */
  const race = async (setup: (h: Client) => Promise<unknown>, who: Session = staff("admin", "admin")) => {
    const h = await holder();
    try {
      await setup(h);
      const pending = prepareUtilityRun(who, input).then(x => x, e => e);
      await waitForBlocked(h);
      await h.query("COMMIT");
      return await pending;
    } finally { await h.end(); }
  };
  /** sqlstate: 42501 for a denial (session, membership); 40001 for the locked-set check (inputs changed mid-wait). */
  const refused = async (label: string, sqlstate: "42501" | "40001", setup: (h: Client) => Promise<unknown>, who?: Session) => {
    const before = await billingRows();
    const result = await race(setup, who);
    assert.ok(code(sqlstate)(result), `${label}: refused with ${sqlstate} (${JSON.stringify(result)}; cause ${JSON.stringify((result as { cause?: unknown })?.cause)})`);
    assert.deepEqual(await billingRows(), before, `${label}: nothing written`);
  };
  // 1. The session revoked while posting waits on it.
  await session("racer", USERS.admin);
  await refused("revoked", "42501", h => h.query("UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [sid.racer]), { ...staff("admin", "admin"), sessionId: sid.racer });
  // 2. The member demoted to accountant while posting waits on the membership row.
  await session("racer2", USERS.manager);
  await refused("demoted", "42501", h => h.query("UPDATE public.org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]), { ...staff("manager", "manager"), sessionId: sid.racer2 });
  await db.query("UPDATE public.org_members SET role='manager' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]);
  // 3. A new revision saved while posting waits (holder also on a room row the gateway locks after the revisions).
  const latest = (await runConfig("admin"))!.revision as number;
  await refused("new revision", "40001", async h => {
    await h.query("UPDATE public.rooms SET label=label WHERE id=$1", [roomC]);
    await h.query(`INSERT INTO app.b109_shared_meter_configs(org_id,property_id,revision,space_ids,split_method,start_reading,effective_from,request_id,created_by)
      VALUES($1,$2,$3,$4,'days_occupied',0,$5,$6,$7)`, [ORG_ID, property, latest + 1, [roomA, roomB], next.start, randomUUID(), USERS.admin]);
  });
  assert.deepEqual([(await runConfig("admin"))!.revision, (await runConfig("admin"))!.method], [latest + 1, "days_occupied"], "positive control: committed first, it is the one applied");
  // 4. The main meter swapped while posting waits on it.
  const newMeter = randomUUID();
  try {
    // The replacement meter has a valid in-period reading, so the locked-set check is the only reason to refuse.
    await refused("main meter swapped", "40001", async h => {
      await h.query("UPDATE public.meters SET archived_at=clock_timestamp() WHERE id=$1", [mainMeter]);
      await h.query(`INSERT INTO public.meters(id,org_id,property_id,unit_id,utility,usage_unit,payer,split_method,rate_source,rate_minor_per_unit)
        VALUES($1,$2,$3,$4,'electricity','kWh','owner','none','fixed_rate',500)`, [newMeter, ORG_ID, property, unitId]);
      await h.query("INSERT INTO public.meter_readings(org_id,meter_id,read_on,value,is_estimate) VALUES($1,$2,$3,600,false)", [ORG_ID, newMeter, next.end]);
    });
  } finally {
    // meter_readings is append-only: the replacement (and its reading) stays, archived; the original comes back.
    await db.query("UPDATE public.meters SET archived_at=clock_timestamp() WHERE id=$1 AND archived_at IS NULL", [newMeter]);
    await db.query("UPDATE public.meters SET archived_at=NULL WHERE id=$1", [mainMeter]);
  }
  // 5. A real change that serialises: the flag turned off while posting waits on the flag row. Posting then runs
  //    OFF (PUBLIC_POWER_RULE) on the committed state: one run, four lines, the legacy amounts.
  const runsBefore = (await db.query("SELECT count(*)::int n FROM public.utility_allocation_runs WHERE unit_id=$1 AND status::text<>'void'", [unitId])).rows[0].n;
  const result = await race(h => h.query(`UPDATE public.platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb) WHERE key='shared_meter'`)) as { runId: string };
  assert.ok(result.runId, JSON.stringify(result));
  const runs = (await db.query("SELECT count(*)::int n FROM public.utility_allocation_runs WHERE unit_id=$1 AND status::text<>'void'", [unitId])).rows[0].n;
  assert.equal(runs, runsBefore + 1, "exactly one new run");
  const inputs = await inputsOf(result.runId);
  assert.deepEqual([("sharedMeter" in inputs), inputs.publicKwhMilli, inputs.publicAmountMinor], [false, SHARED, price(SHARED)]);
  assert.deepEqual(await lineRows(result.runId), expectedLines(0, 0, 50), "four lines, legacy usage and amounts");
  await flag(true);
  // Positive control: the same holder committing no change → the split applies, one run, four lines, split amounts.
  await resetRuns();
  const ok = await race(h => h.query("UPDATE public.platform_settings SET value=value WHERE key='shared_meter'")) as { runId: string };
  const shares = expectShares(SHARED, [days, days - 5]);
  assert.deepEqual(((await inputsOf(ok.runId)).sharedMeter as { sharesMilli: number[] }).sharesMilli, shares);
  assert.deepEqual(await lineRows(ok.runId), expectedLines(shares[0], shares[1], 50));
});
