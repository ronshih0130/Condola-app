import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { Client } from "pg";
import { POST as ownerDecisionPost } from "@/app/api/owner-repair-decision/route";
import { POST as vendorResponsePost } from "@/app/api/vendor-job-response/route";
import { SESSION_COOKIE } from "./auth";
import { FlowError, isDbTimeout } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { submitEstimate } from "./repair-approval";
import { ownerRepairPolicyView } from "./repair-owner-policy";
import { resetAndSeed } from "./seed";
import { sessionTokenHash } from "./session";
import { hashVendorToken } from "./vendor-repair-rules";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// S3 lock bounds (BLK-MAC-17, BLK-MAC-24), local disposable clone only.
// BLK-MAC-17: a single-shot `LOCK TABLE ... NOWAIT` never queues, so PostgreSQL's
// autovacuum auto-cancel (run by a *waiter* after deadlock_timeout) cannot fire and
// any concurrent (auto)vacuum/analyze made the gateway fail with 55P03 at once.
// A holder session taking SHARE UPDATE EXCLUSIVE (the autovacuum/auto-analyze mode)
// or a brief ACCESS EXCLUSIVE (vacuum's heap-truncation phase) stands in for it.
// BLK-MAC-24: the B-013 repair mutators had no lock_timeout anywhere on the
// production call path, so a held parent row made them wait as long as the holder.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

const BOUND_MS = 2000; // app.lock_tables_bounded at deadlock_timeout=1s
const MUTATOR_MS = 3000; // B-013 repair mutator lock_timeout
const SHORT_HOLD_MS = 300;
const SLACK_MS = 1500; // scheduling/connection margin above a bound
const PROBE_DEADLINE_MS = MUTATOR_MS + 3000; // test-side cancel of an unbounded waiter

// (C) intentionally unchanged B-010 r3 / BLK-MAC-11 polling functions.
const POLLING_EXEMPT = [
  "app.b010_fence_legacy_reminders()",
  "app.b010_guard_payment_transition()",
  "app.b010_lock_payment_context(uuid,uuid,text,uuid,uuid,text)",
];
// (B) bounded NOWAIT retry: sites that must never queue (no waiting edge).
const NOWAIT_RETRY = [
  "app.b017_occurrence_valid()",
  "app.b017_old_source_insert()",
  "app.b017_resolution_admit(uuid)",
  "app.b028_center_recipient_valid()",
];
const RETRY_HELPER = "app.lock_tables_nowait_retry(regclass[],text)";
// (A) bounded blocking wait.
const BOUNDED = [
  "app.b010_manual_reminder(uuid,uuid,text,uuid,uuid,uuid,uuid)",
  "app.b010_schedule_rent(uuid,uuid,timestamp with time zone)",
  "app.b010_tenant_due_preference(uuid,uuid,text,uuid,uuid,boolean)",
  "app.b013_change_default(uuid,uuid,text,uuid,uuid,uuid,text,text,text)",
  "app.b013_change_override(uuid,uuid,text,uuid,uuid,uuid,text,text,text)",
  "app.b013_close_default(uuid,uuid,text,uuid,uuid,uuid)",
  "app.b013_close_override(uuid,uuid,text,uuid,uuid,uuid)",
  "app.b013_default_result(uuid,uuid,text,uuid,uuid)",
  "app.b013_default_status(uuid,uuid,text,uuid,uuid,uuid)",
  "app.b013_finish_default(uuid,uuid,text,uuid,uuid,uuid,text)",
  "app.b013_finish_override(uuid,uuid,text,uuid,uuid,uuid,text)",
  "app.b013_override_result(uuid,uuid,text,uuid,uuid)",
  "app.b013_override_status(uuid,uuid,text,uuid,uuid,uuid)",
  "app.b013_owner_context(uuid,uuid,text,uuid,uuid)",
  "app.b013_owner_view(uuid,uuid,text,uuid,uuid)",
  "app.b015_edit_context(uuid,uuid,text,uuid)",
  "app.b028_center_context(uuid,uuid,text,uuid,text,text)",
  "app.b028_center_session(uuid,uuid,text,uuid,text,text,uuid,uuid)",
  "app.b028_center_vendor_context(text)",
  "app.b028_claim_manual(uuid,uuid,text,uuid,uuid,uuid,uuid[])",
  "app.b028_claim_scheduled(uuid,uuid,uuid[],timestamp with time zone)",
  "app.b028_delivery_enabled(uuid)",
  "app.b028_finish_manual(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text)",
];
const MUTATORS = [
  "app.b013_authorize_emergency(uuid,uuid,text,uuid,uuid,uuid,text,text,jsonb,bytea)",
  "app.b013_decide_estimate(uuid,uuid,text,uuid,uuid,uuid,text,text,bytea)",
  "app.b013_emit_reminder(uuid,uuid,timestamp with time zone)",
  "app.b013_record_appointment(uuid,uuid,text,uuid,uuid,uuid,uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,bytea,text)",
  "app.b013_record_vendor_appointment(uuid,uuid,text,uuid,uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,bytea)",
  "app.b013_submit_estimate(uuid,uuid,text,uuid,uuid,uuid,uuid,bigint,text,smallint,text,jsonb,bytea)",
];
const RETRY_BUDGET_MS = 2000;
const NOWAIT_TABLE_LOCK = String.raw`LOCK\s+TABLE[^;]*NOWAIT`;

let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let db: Client;
let owner: Session, manager: Session, property: string, ticket: string, currency: string, minorUnit: number;
let cookieToken: string | null = null;

// Route tests resolve a real owner session from the cookie jar; nothing else is mocked.
mock.method(nextHeaders, "cookies", async () => ({
  get(name: string) {
    if (name === SESSION_COOKIE && cookieToken) return { value: cookieToken };
    if (name === "condola_portal_role") return { value: "owner" };
    return undefined;
  },
}));
mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/o/approvals" }));

async function connect() { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Holder transaction keeps `LOCK TABLE <table> IN <mode>` for `ms`, then rolls back. */
async function hold(table: string, mode: string, ms: number) {
  const h = await connect();
  await h.query("BEGIN");
  await h.query(`LOCK TABLE ${table} IN ${mode} MODE`);
  return new Promise<void>(resolve => setTimeout(() => {
    h.query("ROLLBACK").catch(() => {}).finally(() => { h.end().catch(() => {}).finally(resolve); });
  }, ms));
}
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const started = performance.now();
  try { const value = await fn(); return { ms: Math.round(performance.now() - started), value }; }
  catch (error) { return { ms: Math.round(performance.now() - started), error }; }
}
const codeOf = (error: unknown) => (error as { code?: string } | undefined)?.code;

/** b028_delivery_enabled: smallest production gateway with the platform_settings SHARE admission. */
async function deliveryEnabled() {
  const c = await connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE service_role");
    const value = (await c.query<{ v: boolean }>("SELECT app.b028_delivery_enabled($1) v", [ORG_ID])).rows[0].v;
    await c.query("COMMIT");
    return value;
  } finally { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
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
  db = await connect();
  const row = (await db.query(`SELECT po.property_id::text property,p.currency::text currency,r.minor_unit
    FROM public.property_owners po
    JOIN public.contacts ct ON ct.org_id=po.org_id AND ct.id=po.owner_contact_id
    JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id
    JOIN public.organizations o ON o.id=po.org_id
    JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
    WHERE po.org_id=$1 AND ct.user_id=$2 AND ct.is_owner AND ct.archived_at IS NULL AND p.archived_at IS NULL
    ORDER BY po.property_id LIMIT 1`, [ORG_ID, USERS.owner])).rows[0];
  assert.ok(row, "seed must contain an owner property with a regional currency scale");
  property = row.property; currency = row.currency.trim(); minorUnit = row.minor_unit;
  await db.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'`, [ORG_ID]);
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||'{"repair_approvals":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  const sessions: Record<string, string> = {};
  for (const user of [USERS.owner, USERS.manager]) {
    sessions[user] = randomUUID();
    await db.query(`INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')`, [sessions[user], user, randomBytes(32).toString("hex")]);
  }
  const base = { orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live" as const, locale: "en" as const, calendar: "gregorian" as const, leaseId: null, email: "synthetic@example.test" };
  owner = { ...base, kind: "owner", role: null, userId: USERS.owner, sessionId: sessions[USERS.owner], name: "Synthetic Owner" };
  manager = { ...base, kind: "staff", role: "manager", userId: USERS.manager, sessionId: sessions[USERS.manager], name: "Synthetic Manager" };
  ticket = (await db.query<{ id: string }>(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
    SELECT gen_random_uuid(),$1,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$1),
      $2,category,priority,status,'S3 lock bound probe',cost_bearer,owner_approval
    FROM public.maintenance_tickets WHERE org_id=$1 ORDER BY id LIMIT 1 RETURNING id::text`, [ORG_ID, property])).rows[0].id;
  assert.equal((await ownerRepairPolicyView(owner, property)).state, "enabled");
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });

test("catalog: no single-shot table-level NOWAIT remains; helper is private and bounded; B-013 mutators carry lock_timeout", async () => {
  const offenders = (await db.query<{ sig: string }>(`SELECT p.oid::regprocedure::text sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('app','public') AND p.prosrc ~* $1 ORDER BY 1`, [NOWAIT_TABLE_LOCK])).rows.map(r => r.sig);
  // Only (C) the B-010 polling loops and the (B) retry helper itself keep NOWAIT.
  assert.deepEqual(offenders, [...POLLING_EXEMPT, RETRY_HELPER]);
  for (const sig of POLLING_EXEMPT) {
    const src = (await db.query<{ src: string }>("SELECT prosrc src FROM pg_proc WHERE oid=$1::regprocedure", [sig])).rows[0].src;
    assert.match(src, /EXCEPTION WHEN lock_not_available THEN/, sig);
    assert.match(src, /pg_sleep\(/, sig);
  }
  for (const sig of BOUNDED) {
    const src = (await db.query<{ src: string }>("SELECT prosrc src FROM pg_proc WHERE oid=$1::regprocedure", [sig])).rows[0].src;
    assert.match(src, /PERFORM app\.lock_tables_bounded\(ARRAY\[/, sig);
    assert.doesNotMatch(src, /lock_tables_nowait_retry/, sig);
  }
  for (const sig of NOWAIT_RETRY) {
    const src = (await db.query<{ src: string }>("SELECT prosrc src FROM pg_proc WHERE oid=$1::regprocedure", [sig])).rows[0].src;
    assert.match(src, /PERFORM app\.lock_tables_nowait_retry\(ARRAY\[/, sig);
    assert.doesNotMatch(src, /lock_tables_bounded/, sig);
  }
  assert.equal(BOUNDED.length + NOWAIT_RETRY.length, 27);
  const helper = (await db.query(`SELECT p.prosecdef,p.proconfig,p.provolatile,
      has_function_privilege('service_role',p.oid,'EXECUTE') service,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_proc p WHERE p.oid='app.lock_tables_bounded(regclass[],text)'::regprocedure`)).rows[0];
  assert.deepEqual(helper, { prosecdef: false, proconfig: ["search_path=pg_catalog", "lock_timeout=2s"], provolatile: "v",
    service: false, authenticated: false, anon: false, public: false });
  const retry = (await db.query(`SELECT p.prosecdef,p.proconfig,p.provolatile,
      has_function_privilege('service_role',p.oid,'EXECUTE') service,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public,
      p.prosrc ~ 'IN %s MODE NOWAIT' AND p.prosrc ~ 'lock_not_available' AND p.prosrc ~ 'pg_sleep' AS polls
    FROM pg_proc p WHERE p.oid=$1::regprocedure`, [RETRY_HELPER])).rows[0];
  assert.deepEqual(retry, { prosecdef: false, proconfig: ["search_path=pg_catalog"], provolatile: "v",
    service: false, authenticated: false, anon: false, public: false, polls: true });
  for (const sig of MUTATORS) {
    const cfg = (await db.query<{ cfg: string[] }>("SELECT proconfig cfg FROM pg_proc WHERE oid=$1::regprocedure", [sig])).rows[0].cfg;
    assert.ok(cfg.includes(`lock_timeout=${MUTATOR_MS / 1000}s`), `${sig}: ${JSON.stringify(cfg)}`);
    assert.ok(cfg.some(v => v.startsWith("search_path=")), sig);
  }
  assert.equal((await db.query("SELECT setting FROM pg_settings WHERE name='deadlock_timeout'")).rows[0].setting, "1000");
});

test("BLK-MAC-17 platform_settings: an autovacuum-mode (SHARE UPDATE EXCLUSIVE) holder is waited out, a long one is a bounded 55P03", async (t) => {
  const released = hold("public.platform_settings", "SHARE UPDATE EXCLUSIVE", SHORT_HOLD_MS);
  await pause(50);
  const short = await timed(deliveryEnabled);
  await released;
  t.diagnostic(`delivery_enabled short-hold: ${short.ms}ms ${short.error ? codeOf(short.error) : "ok"}`);
  assert.equal(short.error, undefined, `expected wait-then-success, got ${codeOf(short.error)} after ${short.ms}ms`);
  assert.equal(short.value, false);
  assert.ok(short.ms >= SHORT_HOLD_MS - 150, `${short.ms}ms: did not wait for the holder`);

  const view = hold("public.platform_settings", "SHARE UPDATE EXCLUSIVE", SHORT_HOLD_MS);
  await pause(50);
  const owned = await timed(() => ownerRepairPolicyView(owner, property));
  await view;
  t.diagnostic(`owner policy view short-hold: ${owned.ms}ms ${(owned.value as { state?: string })?.state}`);
  assert.equal((owned.value as { state?: string })?.state, "enabled");

  const long = hold("public.platform_settings", "SHARE UPDATE EXCLUSIVE", BOUND_MS + SLACK_MS + 1000);
  await pause(50);
  const [bounded, busy] = await Promise.all([timed(deliveryEnabled), timed(() => ownerRepairPolicyView(owner, property))]);
  await long;
  t.diagnostic(`delivery_enabled long-hold: ${bounded.ms}ms ${codeOf(bounded.error)}; owner view long-hold: ${busy.ms}ms ${(busy.value as { state?: string })?.state}`);
  assert.equal(codeOf(bounded.error), "55P03");
  assert.ok(bounded.ms >= BOUND_MS - 100 && bounded.ms < BOUND_MS + SLACK_MS, `${bounded.ms}ms`);
  assert.equal((busy.value as { state?: string })?.state, "busy");
  assert.ok(busy.ms < BOUND_MS + SLACK_MS, `${busy.ms}ms`);
});

test("BLK-MAC-17 audit_log / B-013 private tables: vacuum truncation (brief ACCESS EXCLUSIVE) and analyze are waited out", async (t) => {
  // ACCESS SHARE does not conflict with SHARE UPDATE EXCLUSIVE: (auto)vacuum's
  // scan phase never blocked the owner view; its truncation phase (ACCESS
  // EXCLUSIVE, released within ~20ms once a waiter queues) did, under NOWAIT.
  for (const [table, mode] of [["public.audit_log", "SHARE UPDATE EXCLUSIVE"], ["public.audit_log", "ACCESS EXCLUSIVE"],
    ["app.b013_regional_defaults", "SHARE UPDATE EXCLUSIVE"], ["public.property_owners", "ACCESS EXCLUSIVE"]] as const) {
    const released = hold(table, mode, SHORT_HOLD_MS);
    await pause(50);
    const view = await timed(() => ownerRepairPolicyView(owner, property));
    await released;
    t.diagnostic(`owner policy view vs ${table} ${mode} ${SHORT_HOLD_MS}ms: ${view.ms}ms ${(view.value as { state?: string })?.state}`);
    assert.equal((view.value as { state?: string })?.state, "enabled", `${table} ${mode}`);
  }
});

test("helper: a deadlock resolved against the bounded waiter surfaces as 55P03, not 40P01", async (t) => {
  const a = await connect(), b = await connect();
  try {
    await a.query("BEGIN");
    await a.query("LOCK TABLE public.platform_settings IN ROW EXCLUSIVE MODE");
    await b.query("BEGIN");
    await b.query("LOCK TABLE public.partner_codes IN SHARE MODE");
    const waiter = timed(() => b.query("SELECT app.lock_tables_bounded(ARRAY['public.platform_settings']::regclass[],'SHARE')"));
    await pause(250); // b queues first, so b's deadlock_timeout fires first and b is the victim
    const other = a.query("LOCK TABLE public.partner_codes IN ROW EXCLUSIVE MODE");
    const result = await waiter;
    t.diagnostic(`deadlock victim: ${result.ms}ms ${codeOf(result.error)} ${(result.error as Error | undefined)?.message}`);
    assert.equal(codeOf(result.error), "55P03");
    assert.ok(result.ms < BOUND_MS, `${result.ms}ms`);
    await b.query("ROLLBACK");
    await other; // the surviving transaction proceeds
  } finally {
    await a.query("ROLLBACK").catch(() => {}); await b.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([a.end(), b.end()]);
  }
});

test("BLK-MAC-24: the production submitEstimate path behind a held ticket row fails bounded (55P03), never waits as long as the holder", async (t) => {
  const holder = await connect(), observer = await connect();
  try {
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("BEGIN");
    await holder.query("UPDATE public.maintenance_tickets SET title=title||'' WHERE id=$1", [ticket]);
    let settled = false;
    const call = timed(() => submitEstimate(manager, { requestId: randomUUID(), ticketId: ticket, expectedHeadId: null,
      amountMinor: BigInt(500001), currency, minorUnit, workScope: "S3 bounded probe", evidence: [] })).finally(() => { settled = true; });
    let blocked = false;
    const started = performance.now();
    while (!settled && performance.now() - started < PROBE_DEADLINE_MS) {
      const row = (await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%b013_submit_estimate%'`, [holderPid])).rows[0];
      if (row) blocked = true;
      await pause(25);
    }
    if (!settled) {
      // Pre-fix behaviour: still waiting. Cancel test-side so the suite does not hang.
      await observer.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%b013_submit_estimate%'`, [holderPid]);
      await call;
      assert.fail(`submitEstimate still waiting behind the held ticket after ${PROBE_DEADLINE_MS}ms (unbounded)`);
    }
    const result = await call;
    const cause = (result.error as { cause?: { code?: string } } | undefined)?.cause;
    t.diagnostic(`submitEstimate behind held ticket: ${result.ms}ms blocked=${blocked} key=${(result.error as FlowError | undefined)?.key} cause=${cause?.code}`);
    assert.ok(blocked, "the gateway never queued behind the held ticket row");
    assert.ok(result.error instanceof FlowError, String(result.error));
    assert.equal(cause?.code, "55P03");
    assert.ok(isDbTimeout(cause));
    assert.ok(result.ms >= MUTATOR_MS - 150 && result.ms < MUTATOR_MS + SLACK_MS, `${result.ms}ms`);
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b013_estimate_versions WHERE ticket_id=$1", [ticket])).rows[0].n, 0);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([holder.end(), observer.end()]);
  }
  // Short holder: the mutator waits it out and records normally.
  const h2 = await connect();
  try {
    await h2.query("BEGIN");
    await h2.query("UPDATE public.maintenance_tickets SET title=title||'' WHERE id=$1", [ticket]);
    const release = pause(SHORT_HOLD_MS).then(() => h2.query("ROLLBACK"));
    const ok = await timed(() => submitEstimate(manager, { requestId: randomUUID(), ticketId: ticket, expectedHeadId: null,
      amountMinor: BigInt(500001), currency, minorUnit, workScope: "S3 bounded probe", evidence: [] }));
    await release;
    t.diagnostic(`submitEstimate short-hold: ${ok.ms}ms ${(ok.value as { status?: string })?.status ?? codeOf(ok.error)}`);
    assert.equal((ok.value as { status?: string })?.status, "recorded");
    assert.ok(ok.ms >= SHORT_HOLD_MS - 150 && ok.ms < MUTATOR_MS, `${ok.ms}ms`);
  } finally { await h2.end(); }
});

async function newTicket(title: string) {
  return (await db.query<{ id: string }>(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
    SELECT gen_random_uuid(),$1,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$1),
      $2,category,priority,status,$3,cost_bearer,owner_approval
    FROM public.maintenance_tickets WHERE org_id=$1 ORDER BY id LIMIT 1 RETURNING id::text`, [ORG_ID, property, title])).rows[0].id;
}
async function recordedVersion(ticketId: string, amount: number) {
  const result = await submitEstimate(manager, { requestId: randomUUID(), ticketId, expectedHeadId: null,
    amountMinor: BigInt(amount), currency, minorUnit, workScope: "S3 route probe", evidence: [] });
  assert.equal(result.status, "recorded");
  return result.version_id as string;
}
/** Holder keeps the ticket row updated while `send` runs; returns the response, elapsed ms and whether `gateway` queued behind it. */
async function behindHeldTicket(ticketId: string, gateway: string, send: () => Promise<Response>) {
  const holder = await connect(), observer = await connect();
  try {
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("BEGIN");
    await holder.query("UPDATE public.maintenance_tickets SET title=title||'' WHERE id=$1", [ticketId]);
    let settled = false, blocked = false;
    const call = timed(send).finally(() => { settled = true; });
    const started = performance.now();
    while (!settled && performance.now() - started < PROBE_DEADLINE_MS) {
      if ((await observer.query(`SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%' || $2 || '%'`, [holderPid, gateway])).rowCount) blocked = true;
      await pause(25);
    }
    if (!settled) {
      await observer.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`, [holderPid]);
      await call;
      assert.fail(`${gateway} still waiting after ${PROBE_DEADLINE_MS}ms`);
    }
    const result = await call;
    return { ...result, blocked };
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([holder.end(), observer.end()]);
  }
}
function jsonPost(path: string, body: unknown) {
  return new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("BLK-MAC-17 never-wait site (b017_resolution_admit): bounded NOWAIT retry rides out a short holder without queueing, fails 55P03 within budget", async (t) => {
  const attempt = async (sampler?: Client) => {
    const c = await connect();
    try {
      const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0].pid;
      let done = false, queued = 0;
      const sampling = (async () => {
        while (sampler && !done) {
          queued += (await sampler.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [pid])).rowCount ?? 0;
          await pause(10);
        }
      })();
      await c.query("BEGIN");
      const result = await timed(() => c.query("SELECT app.b017_resolution_admit($1)", [ORG_ID])).finally(() => { done = true; });
      await sampling;
      return { ...result, queued };
    } finally { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
  };
  const sampler = await connect();
  try {
    const released = hold("public.platform_settings", "SHARE UPDATE EXCLUSIVE", SHORT_HOLD_MS);
    await pause(50);
    const short = await attempt(sampler);
    await released;
    t.diagnostic(`resolution_admit short-hold: ${short.ms}ms ${short.error ? codeOf(short.error) : "ok"} queuedSamples=${short.queued}`);
    assert.equal(short.error, undefined, `expected retry-then-success, got ${codeOf(short.error)} after ${short.ms}ms`);
    assert.ok(short.ms >= SHORT_HOLD_MS - 150, `${short.ms}ms: did not retry past the holder`);
    assert.equal(short.queued, 0, "the never-wait site queued on a lock (waiting edge)");

    const long = hold("public.platform_settings", "SHARE UPDATE EXCLUSIVE", RETRY_BUDGET_MS + SLACK_MS + 1000);
    await pause(50);
    const failed = await attempt(sampler);
    await long;
    t.diagnostic(`resolution_admit long-hold: ${failed.ms}ms ${codeOf(failed.error)} ${(failed.error as Error | undefined)?.message} queuedSamples=${failed.queued}`);
    assert.equal(codeOf(failed.error), "55P03");
    assert.match((failed.error as Error).message, /could not obtain lock on relation/);
    assert.ok(failed.ms >= RETRY_BUDGET_MS - 100 && failed.ms < RETRY_BUDGET_MS + SLACK_MS, `${failed.ms}ms`);
    assert.equal(failed.queued, 0, "the never-wait site queued on a lock (waiting edge)");
  } finally { await sampler.end(); }
});

test("BLK-MAC-24 owner-repair-decision route: held ticket -> bounded wait -> retryable {status:'busy'}; same requestId then records", async (t) => {
  const raw = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')`,
    [randomUUID(), USERS.owner, sessionTokenHash(raw)]);
  cookieToken = raw;
  try {
    const decisionTicket = await newTicket("S3 owner route probe");
    const versionId = await recordedVersion(decisionTicket, 500001);
    const body = { requestId: randomUUID(), versionId, decision: "approved", reason: null };
    const held = await behindHeldTicket(decisionTicket, "b013_decide_estimate", () => ownerDecisionPost(jsonPost("/api/owner-repair-decision", body)));
    const response = held.value as Response | undefined;
    const json = response ? await response.json() : undefined;
    t.diagnostic(`owner-repair-decision behind held ticket: ${held.ms}ms http=${response?.status} body=${JSON.stringify(json)} blocked=${held.blocked} error=${held.error ? String(held.error) : ""}`);
    assert.equal(held.error, undefined, String(held.error));
    assert.equal(response?.status, 200);
    assert.deepEqual(json, { status: "busy" });
    assert.ok(held.blocked, "decision never queued behind the held ticket");
    assert.ok(held.ms >= MUTATOR_MS - 150 && held.ms < MUTATOR_MS + SLACK_MS, `${held.ms}ms`);
    const retry = await ownerDecisionPost(jsonPost("/api/owner-repair-decision", body));
    const again = await retry.json();
    t.diagnostic(`owner-repair-decision retry: http=${retry.status} status=${again.status}`);
    assert.equal(retry.status, 200);
    assert.equal(again.status, "recorded");
  } finally { cookieToken = null; }
});

test("BLK-MAC-24 vendor-job-response route: held ticket -> bounded wait -> retryable {status:'busy'} (was 403); same requestId then records", async (t) => {
  await db.query(`UPDATE public.organizations SET plan_tier='beta',feature_flags=feature_flags||'{"vendor_dispatch":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  const vendorTicket = await newTicket("S3 vendor route probe");
  const versionId = await recordedVersion(vendorTicket, 1000);
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO public.repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at)
    VALUES($1,$2,'S3 lock vendor','+886900111225','day',$3,clock_timestamp()+interval '2 hours')`, [ORG_ID, vendorTicket, hashVendorToken(token)]);
  const body = { token, requestId: randomUUID(), versionId, action: "reject", reason: "Not available this week" };
  // CLONE-ONLY BRIDGE for a pre-existing gap (not part of the S3 fix): vendor-job.ts
  // mutationScope reads app.b013_estimate_heads as service_role, but 20261105170000
  // revokes every B-013 table from service_role, so with flags ON the route fails with
  // 42501 before reaching the gateway. Granted in this disposable clone only, revoked below.
  await db.query("GRANT SELECT ON app.b013_estimate_heads TO service_role");
  try {
  const held = await behindHeldTicket(vendorTicket, "b013_record_vendor_appointment", () => vendorResponsePost(jsonPost("/api/vendor-job-response", body)));
  const response = held.value as Response | undefined;
  const json = response ? await response.json() : undefined;
  t.diagnostic(`vendor-job-response behind held ticket: ${held.ms}ms http=${response?.status} body=${JSON.stringify(json)} blocked=${held.blocked} error=${held.error ? String(held.error) : ""}`);
  assert.equal(held.error, undefined, String(held.error));
  assert.equal(response?.status, 200);
  assert.deepEqual(json, { status: "busy" });
  assert.ok(held.blocked, "vendor appointment never queued behind the held ticket");
  assert.ok(held.ms >= MUTATOR_MS - 150 && held.ms < MUTATOR_MS + SLACK_MS, `${held.ms}ms`);
  const retry = await vendorResponsePost(jsonPost("/api/vendor-job-response", body));
  const again = await retry.json();
  t.diagnostic(`vendor-job-response retry: http=${retry.status} status=${again.status}`);
  assert.equal(retry.status, 200);
  assert.equal(again.status, "recorded");
  } finally { await db.query("REVOKE SELECT ON app.b013_estimate_heads FROM service_role"); }
});
