import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { submitEstimate as submitEstimateGateway } from "./repair-approval";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-028 package 5 / inherited B-013 gate "parent FK lock time measured on T0
// rehearsal". LOCAL MEASUREMENT ONLY: a disposable local PostgreSQL clone with
// synthetic seed data and a fixed hold time. It records contention, elapsed
// wait and blocking relationships (pg_stat_activity / pg_locks /
// pg_blocking_pids) so the T0 rehearsal knows what to look for. It is NOT the
// T0 rehearsal: hosted roles, data volume, concurrency and timings differ.
// S3 BLK-MAC-24 (20261107151000): the B-013 repair mutators carry a
// function-scoped lock_timeout=3s, which governs every lock wait inside the
// gateway (it overrides the transaction-level lock_timeout this test sets around
// the call; that one still bounds the test's own parent statements). The
// "production-call-path-bounded-wait" scenario shows a blocked production call
// (repair-approval.ts -> svc -> svcOn, no caller timeout) failing with 55P03 at
// the gateway bound instead of waiting as long as the holder.
// Set B028_PARENT_LOCK_JSON=<path> to write the measurements as JSON.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

const HOLD_MS = 400;
const LOCK_TIMEOUT_MS = 3000;
const GATEWAY_LOCK_TIMEOUT_MS = 3000; // proconfig lock_timeout of the B-013 mutators (S3)
const POLL_MS = 20;
const PRODUCTION_DEADLINE_MS = GATEWAY_LOCK_TIMEOUT_MS + 3000; // test-side cancel if the bound regresses

let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let fixture: {
  property: string; ownership: string; ownerContact: string; currency: string; minorUnit: number; session: string;
  tickets: Record<string, string>; versionTicket: string; version: string; job: string;
};

type Lock = { locktype: string; relation: string | null; mode: string };
type Sample = { wait_event_type: string | null; wait_event: string | null; blockers: number[]; waiting: Lock[] | null; tuple_locks: Lock[] | null };
type Measurement = {
  scenario: string; parent: string; first: string; second: string; expectBlocked: boolean;
  holderPid: number; waiterPid: number; holdMs: number; lockTimeoutMs: number;
  elapsedMs: number; observedBlocked: boolean; blockedSamples: number; blockerPids: number[]; blockerCount?: number;
  blockedByHolder: boolean; firstBlockedSample: Sample | null; outcome: string;
};
const measurements: Measurement[] = [];
let measurementsServer = "unknown";
let callerTimeouts: Record<string, unknown> = {};

function digest(value: unknown): Buffer { return createHash("sha256").update(JSON.stringify(value)).digest(); }
async function connect() { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; }

/** Real B-013 gateway (service_role), the actual child-row writer for estimates. */
async function submitEstimate(c: Client, ticket: string) {
  const args = [ticket, null, "500001", fixture.currency, fixture.minorUnit, "Synthetic lock measurement", []];
  // B-028 package 4: environment tuple + request principal (svc() sets the sub from Session.userId).
  await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [USERS.manager]);
  await c.query("SET LOCAL ROLE service_role");
  const result = await c.query(`SELECT app.b013_submit_estimate($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::bigint,$9::text,$10::smallint,$11::text,$12::jsonb,$13::bytea) result`,
    [ORG_ID, ORG_ID, "live", fixture.session, randomUUID(), ...args.slice(0, 6), JSON.stringify(args[6]), digest(args)]);
  await c.query("RESET ROLE");
  await c.query("SELECT set_config('request.jwt.claim.sub','',true)");
  return result.rows[0].result as { status: string; version_id?: string };
}

const statements: Record<string, { label: string; run: (c: Client) => Promise<unknown> }> = {};
function define() {
  const t = fixture.tickets;
  Object.assign(statements, {
    ticketUpdate: { label: "UPDATE maintenance_tickets SET title (non-key)", run: (c: Client) => c.query(`UPDATE public.maintenance_tickets SET title=title||'' WHERE id=$1`, [t.submit]) },
    ticketUpdateFk: { label: "UPDATE maintenance_tickets SET title (non-key)", run: (c: Client) => c.query(`UPDATE public.maintenance_tickets SET title=title||'' WHERE id=$1`, [t.fk]) },
    ticketUpdateTimeout: { label: "UPDATE maintenance_tickets SET title (non-key)", run: (c: Client) => c.query(`UPDATE public.maintenance_tickets SET title=title||'' WHERE id=$1`, [t.timeout]) },
    submit: { label: "app.b013_submit_estimate (ticket FOR UPDATE, property_owners FOR SHARE, heads/versions insert)", run: (c: Client) => submitEstimate(c, t.submit) },
    submitTimeout: { label: "app.b013_submit_estimate", run: (c: Client) => submitEstimate(c, t.timeout) },
    propertyUpdate: { label: "UPDATE properties SET name (non-key)", run: (c: Client) => c.query(`UPDATE public.properties SET name=name WHERE id=$1`, [fixture.property]) },
    contactUpdate: { label: "UPDATE contacts SET display_name (non-key, designated owner contact)", run: (c: Client) => c.query(`UPDATE public.contacts SET display_name=display_name WHERE id=$1`, [fixture.ownerContact]) },
    ticketUpdateUnbounded: { label: "UPDATE maintenance_tickets SET title (non-key)", run: (c: Client) => c.query(`UPDATE public.maintenance_tickets SET title=title||'' WHERE id=$1`, [t.unbounded]) },
    ownerUpdate: { label: "UPDATE property_owners SET repair_approval_threshold_minor (non-key)", run: (c: Client) => c.query(`UPDATE public.property_owners SET repair_approval_threshold_minor=repair_approval_threshold_minor WHERE id=$1`, [fixture.ownership]) },
    headInsert: { label: "INSERT app.b013_estimate_heads (FK key-share on maintenance_tickets only)", run: (c: Client) => c.query(`INSERT INTO app.b013_estimate_heads(org_id,ticket_id,current_version_id) VALUES($1,$2,$3)`, [ORG_ID, t.fk, randomUUID()]) },
    jobUpdate: { label: "UPDATE repair_vendor_jobs SET contact_window (non-key)", run: (c: Client) => c.query(`UPDATE public.repair_vendor_jobs SET contact_window=contact_window WHERE id=$1`, [fixture.job]) },
    appointmentInsert: { label: "INSERT app.b013_repair_appointments (job guard FOR SHARE + FK)", run: (c: Client) => c.query(`INSERT INTO app.b013_repair_appointments(org_id,ticket_id,version_id,repair_vendor_job_id,event_kind,proposed_start,proposed_end,actor_id)
      VALUES($1,$2,$3,$4,'vendor_proposed',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day 1 hour',$5)`, [ORG_ID, fixture.versionTicket, fixture.version, fixture.job, USERS.manager]) },
  });
}

/** Holder runs `first` and keeps its transaction open for HOLD_MS; the waiter
 * then runs `second` with a bounded lock_timeout while an observer samples the
 * waiter's backend. Both transactions roll back so each scenario is isolated. */
async function measure(scenario: string, parent: string, first: string, second: string, expectBlocked: boolean, lockTimeoutMs = LOCK_TIMEOUT_MS, holdMs = HOLD_MS) {
  const holder = await connect(), waiter = await connect(), observer = await connect();
  try {
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0].pid;
    const waiterPid = (await waiter.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("BEGIN");
    await holder.query(`SET LOCAL statement_timeout='10s'`);
    await statements[first].run(holder);
    await waiter.query("BEGIN");
    await waiter.query(`SET LOCAL lock_timeout='${lockTimeoutMs}ms'`);
    await waiter.query(`SET LOCAL statement_timeout='10s'`);
    let done = false;
    const started = performance.now();
    const pending = statements[second].run(waiter).then(() => "ok", (error: { code?: string }) => `error:${error.code ?? "unknown"}`).finally(() => { done = true; });
    const release = new Promise<void>(resolve => setTimeout(() => { holder.query("ROLLBACK").then(() => resolve(), () => resolve()); }, holdMs));
    const samples: Sample[] = [];
    while (!done) {
      const sample = (await observer.query<Sample>(`SELECT a.wait_event_type,a.wait_event,pg_blocking_pids($1) blockers,
        (SELECT json_agg(json_build_object('locktype',l.locktype,'relation',l.relation::regclass::text,'mode',l.mode) ORDER BY l.locktype)
           FROM pg_locks l WHERE l.pid=$1 AND NOT l.granted) waiting,
        (SELECT json_agg(json_build_object('locktype',l.locktype,'relation',l.relation::regclass::text,'mode',l.mode) ORDER BY l.relation::regclass::text)
           FROM pg_locks l WHERE l.pid=$1 AND l.granted AND l.locktype='tuple') tuple_locks
        FROM pg_stat_activity a WHERE a.pid=$1`, [waiterPid])).rows[0];
      if (!done && sample && sample.blockers.length) samples.push(sample);
      if (performance.now() - started > lockTimeoutMs + 5000) throw new Error(`${scenario}: waiter exceeded the bound`);
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    const outcome = await pending;
    const elapsedMs = Math.round(performance.now() - started);
    await release;
    await waiter.query("ROLLBACK");
    const blockerPids = [...new Set(samples.flatMap(s => s.blockers))];
    const m: Measurement = {
      scenario, parent, first: statements[first].label, second: statements[second].label, expectBlocked,
      holderPid, waiterPid, holdMs, lockTimeoutMs, elapsedMs, observedBlocked: samples.length > 0,
      blockedSamples: samples.length, blockerPids, blockedByHolder: blockerPids.length === 1 && blockerPids[0] === holderPid,
      firstBlockedSample: samples[0] ?? null, outcome,
    };
    measurements.push(m);
    return m;
  } finally {
    await Promise.allSettled([holder.end(), waiter.end(), observer.end()]);
  }
}

test.before(async () => {
  clone = await cloneTestDatabase();
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
  const c = await connect();
  try {
    assert.equal((await c.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, true);
    const row = (await c.query(`SELECT po.id,po.property_id,po.owner_contact_id::text owner_contact,p.currency::text currency,r.minor_unit
      FROM public.property_owners po
      JOIN public.contacts ct ON ct.org_id=po.org_id AND ct.id=po.owner_contact_id
      JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id
      JOIN public.organizations o ON o.id=po.org_id
      JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
      WHERE po.org_id=$1 AND ct.user_id=$2 AND ct.is_owner AND ct.archived_at IS NULL AND p.archived_at IS NULL
      ORDER BY po.id LIMIT 1`, [ORG_ID, USERS.owner])).rows[0];
    assert.ok(row, "seed must contain an owner property with a regional currency scale");
    // Synthetic clone-only setup, committed so separate backends can contend.
    await c.query(`UPDATE public.property_owners SET effective_from=least(effective_from,CURRENT_DATE-1),effective_to=CURRENT_DATE
      WHERE org_id=$1 AND property_id=$2 AND id<>$3`, [ORG_ID, row.property_id, row.id]);
    await c.query(`UPDATE public.property_owners SET repair_approval_threshold_minor=500000,effective_from=CURRENT_DATE-1,effective_to=NULL WHERE id=$1`, [row.id]);
    assert.equal((await c.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'`, [ORG_ID])).rowCount, 1);
    await c.query(`UPDATE public.organizations SET feature_flags=feature_flags||'{"repair_approvals":true}'::jsonb WHERE id=$1`, [ORG_ID]);
    const session = randomUUID();
    await c.query(`INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')`, [session, USERS.manager, randomBytes(32).toString("hex")]);
    const tickets: Record<string, string> = {};
    for (const name of ["submit", "fk", "timeout", "version", "unbounded"]) {
      tickets[name] = (await c.query<{ id: string }>(`INSERT INTO public.maintenance_tickets
        (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
        SELECT gen_random_uuid(),$1,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$1),
          $2,category,priority,status,'B-028 lock measurement',cost_bearer,owner_approval
        FROM public.maintenance_tickets WHERE org_id=$1 ORDER BY id LIMIT 1 RETURNING id::text`, [ORG_ID, row.property_id])).rows[0].id;
    }
    fixture = { property: row.property_id, ownership: row.id, ownerContact: row.owner_contact, currency: row.currency.trim(), minorUnit: row.minor_unit, session,
      tickets, versionTicket: tickets.version, version: "", job: "" };
    await c.query("BEGIN");
    const recorded = await submitEstimate(c, tickets.version);
    await c.query("COMMIT");
    assert.equal(recorded.status, "recorded");
    fixture.version = recorded.version_id!;
    fixture.job = (await c.query<{ id: string }>(`INSERT INTO public.repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at)
      VALUES($1,$2,'Synthetic lock vendor','+886900111224','day',$3,clock_timestamp()+interval '2 hours') RETURNING id::text`,
    [ORG_ID, tickets.version, randomBytes(32).toString("hex")])).rows[0].id;
  } finally { await c.end(); }
  define();
});
test.after(async () => {
  try {
    if (process.env.B028_PARENT_LOCK_JSON) {
      writeFileSync(process.env.B028_PARENT_LOCK_JSON, JSON.stringify({
        label: "LOCAL MEASUREMENT ONLY — disposable local PostgreSQL clone, synthetic seed; not the T0 rehearsal (T0 reserve pending)",
        postgres: measurementsServer, holdMs: HOLD_MS, lockTimeoutMs: LOCK_TIMEOUT_MS, pollMs: POLL_MS,
        callerTimeouts,
        measurements: measurements.map(m => ({ ...m, holderPid: undefined, waiterPid: undefined, blockerPids: undefined, blockerCount: m.blockerPids.length, firstBlockedSample: m.firstBlockedSample && { ...m.firstBlockedSample, blockers: m.firstBlockedSample.blockers.length } })),
      }, null, 1) + "\n");
    }
  } finally { await clone?.cleanup(); }
});
test("server version recorded", async () => {
  const c = await connect();
  try { measurementsServer = (await c.query<{ v: string }>("SELECT current_setting('server_version') v")).rows[0].v; } finally { await c.end(); }
  assert.match(measurementsServer, /^\d+/);
});

function assertBlocked(m: Measurement) {
  assert.equal(m.outcome, "ok", `${m.scenario}: ${m.outcome}`);
  assert.ok(m.observedBlocked, `${m.scenario}: waiter never observed blocked`);
  assert.ok(m.blockedByHolder, `${m.scenario}: blockers ${JSON.stringify(m.blockerPids)} ≠ holder`);
  assert.equal(m.firstBlockedSample?.wait_event_type, "Lock");
  assert.ok(m.elapsedMs >= m.holdMs * 0.75, `${m.scenario}: ${m.elapsedMs}ms < hold`);
  assert.ok(m.elapsedMs < m.lockTimeoutMs, `${m.scenario}: ${m.elapsedMs}ms reached lock_timeout`);
}

test("maintenance_tickets: parent update blocks the estimate gateway; gateway blocks parent update", async () => {
  assertBlocked(await measure("ticket-update-then-estimate-submit", "public.maintenance_tickets", "ticketUpdate", "submit", true));
  assertBlocked(await measure("estimate-submit-then-ticket-update", "public.maintenance_tickets", "submit", "ticketUpdate", true));
});

test("maintenance_tickets: a non-key parent update does not block the bare FK child insert", async () => {
  const m = await measure("ticket-update-then-head-fk-insert", "public.maintenance_tickets", "ticketUpdateFk", "headInsert", false);
  assert.equal(m.outcome, "ok");
  assert.equal(m.observedBlocked, false); // elapsedMs is recorded as data only (load-sensitive)
});

test("property_owners: parent update blocks the estimate gateway's FOR SHARE; gateway blocks parent update", async () => {
  assertBlocked(await measure("owner-update-then-estimate-submit", "public.property_owners", "ownerUpdate", "submit", true));
  assertBlocked(await measure("estimate-submit-then-owner-update", "public.property_owners", "submit", "ownerUpdate", true));
});

test("repair_vendor_jobs: parent update blocks the appointment insert guard; child insert blocks parent update", async () => {
  assertBlocked(await measure("job-update-then-appointment-insert", "public.repair_vendor_jobs", "jobUpdate", "appointmentInsert", true));
  assertBlocked(await measure("appointment-insert-then-job-update", "public.repair_vendor_jobs", "appointmentInsert", "jobUpdate", true));
});

test("bounded: a parent held past the gateway's own lock_timeout fails the gateway with 55P03, not an unbounded wait", async () => {
  // S3: the gateway's function-scoped 3s bound governs (a shorter caller bound no longer applies inside it).
  const hold = GATEWAY_LOCK_TIMEOUT_MS + 1500;
  const m = await measure("ticket-held-past-gateway-lock-timeout", "public.maintenance_tickets", "ticketUpdateTimeout", "submitTimeout", true, GATEWAY_LOCK_TIMEOUT_MS, hold);
  assert.equal(m.outcome, "error:55P03");
  assert.ok(m.blockedByHolder);
  assert.ok(m.elapsedMs >= GATEWAY_LOCK_TIMEOUT_MS * 0.95 && m.elapsedMs < hold, `${m.elapsedMs}ms`);
});

test("properties and contacts: parent update blocks the estimate gateway's FOR SHARE (properties, then OF po, c)", async () => {
  assertBlocked(await measure("property-update-then-estimate-submit", "public.properties", "propertyUpdate", "submit", true));
  assertBlocked(await measure("owner-contact-update-then-estimate-submit", "public.contacts", "contactUpdate", "submit", true));
});

test("bounded: the production estimate call path is bounded by the gateway lock_timeout and fails 55P03 behind a held parent", async () => {
  const c = await connect(), holder = await connect();
  try {
    // Defaults a fresh service connection inherits (no role/database override): the
    // bound comes from the gateway itself, not from the caller or the database.
    const defaults = (await c.query<{ name: string; setting: string }>(`SELECT name,setting FROM pg_settings WHERE name IN ('lock_timeout','statement_timeout','idle_in_transaction_session_timeout') ORDER BY name`)).rows;
    const overrides = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM pg_db_role_setting s
      LEFT JOIN pg_roles r ON r.oid=s.setrole WHERE (s.setdatabase=0 OR s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()))
      AND (s.setrole=0 OR r.rolname IN ('service_role',current_user)) AND array_to_string(s.setconfig,',') ~ '(lock|statement)_timeout'`)).rows[0].n;
    const proconfig = (await c.query<{ cfg: string[] | null }>(`SELECT proconfig cfg FROM pg_proc WHERE oid='app.b013_submit_estimate(uuid,uuid,text,uuid,uuid,uuid,uuid,bigint,text,smallint,text,jsonb,bytea)'::regprocedure`)).rows[0].cfg ?? [];
    callerTimeouts = { connectionDefaults: Object.fromEntries(defaults.map(d => [d.name, d.setting])), roleOrDatabaseTimeoutOverrides: overrides,
      gatewayProconfig: proconfig, callPath: "repair-approval.ts submitEstimate -> run -> svc -> svcOn (no caller timeout; gateway lock_timeout=3s)" };
    assert.equal(defaults.find(d => d.name === "lock_timeout")?.setting, "0");
    assert.equal(defaults.find(d => d.name === "statement_timeout")?.setting, "0");
    assert.equal(overrides, 0);
    assert.ok(proconfig.includes(`lock_timeout=${GATEWAY_LOCK_TIMEOUT_MS / 1000}s`), JSON.stringify(proconfig));

    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("BEGIN");
    await statements.ticketUpdateUnbounded.run(holder);
    const session: Session = { userId: USERS.manager, sessionId: fixture.session, kind: "staff", role: "manager", orgId: ORG_ID, liveOrgId: ORG_ID,
      environment: "live", locale: "en", calendar: "gregorian", leaseId: null, email: "synthetic@example.test", name: "Synthetic" };
    const started = performance.now();
    let settled = false, settledMs = 0;
    const call = submitEstimateGateway(session, { requestId: randomUUID(), ticketId: fixture.tickets.unbounded, expectedHeadId: null,
      amountMinor: BigInt(500001), currency: fixture.currency, minorUnit: fixture.minorUnit, workScope: "Synthetic bounded probe", evidence: [] })
      .then(() => "ok", (error: { code?: string; cause?: { code?: string }; message?: string }) => `error:${error.code ?? error.cause?.code ?? error.message ?? "unknown"}`)
      .finally(() => { settled = true; settledMs = Math.round(performance.now() - started); });
    let waiterPid: number | null = null, samples = 0, last: Sample | null = null, first: Sample | null = null;
    while (!settled && performance.now() - started < PRODUCTION_DEADLINE_MS) {
      const found = (await c.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%b013_submit_estimate%'`, [holderPid])).rows[0];
      if (found) {
        waiterPid = found.pid;
        const sample = (await c.query<Sample>(`SELECT a.wait_event_type,a.wait_event,pg_blocking_pids($1) blockers,NULL::json waiting,NULL::json tuple_locks FROM pg_stat_activity a WHERE a.pid=$1`, [waiterPid])).rows[0] ?? null;
        if (sample?.blockers.length) { samples++; first ??= sample; last = sample; }
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    // Test-side cancellation only if the gateway bound regressed.
    if (!settled && waiterPid !== null) await c.query("SELECT pg_cancel_backend($1)", [waiterPid]);
    const stillWaiting = !settled;
    const outcome = await Promise.race([call, new Promise<string>(resolve => setTimeout(() => resolve("not-settled-after-cancel"), 5000))]);
    await holder.query("ROLLBACK");
    measurements.push({ scenario: "production-call-path-bounded-wait", parent: "public.maintenance_tickets",
      first: statements.ticketUpdateUnbounded.label, second: "submitEstimate() TS wrapper via svc (gateway lock_timeout=3s)", expectBlocked: true,
      holderPid, waiterPid: waiterPid ?? 0, holdMs: PRODUCTION_DEADLINE_MS, lockTimeoutMs: GATEWAY_LOCK_TIMEOUT_MS, elapsedMs: stillWaiting ? PRODUCTION_DEADLINE_MS : settledMs, observedBlocked: samples > 0,
      blockedSamples: samples, blockerPids: [...new Set([...(first?.blockers ?? []), ...(last?.blockers ?? [])])], blockedByHolder: Boolean(last?.blockers.length === 1 && last.blockers[0] === holderPid),
      firstBlockedSample: first, outcome: stillWaiting ? `still_waiting_at_${PRODUCTION_DEADLINE_MS}ms; test cancelled -> ${outcome}` : outcome });
    assert.ok(waiterPid, "production call never reached the gateway");
    assert.ok(samples > 0 && first?.wait_event_type === "Lock", "production call never queued behind the held parent");
    assert.ok(!stillWaiting, `production call still waiting after ${PRODUCTION_DEADLINE_MS}ms (gateway bound missing)`);
    assert.equal(outcome, "error:55P03");
    assert.ok(settledMs >= GATEWAY_LOCK_TIMEOUT_MS * 0.95 && settledMs < GATEWAY_LOCK_TIMEOUT_MS + 1500, `${settledMs}ms`);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([c.end(), holder.end()]);
  }
});
