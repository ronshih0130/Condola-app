import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID } from "./ids";
import { createCaptureAdapter, deliveryStatus, enqueueDelivery, runDeliveryAttempts } from "./notification-delivery";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let admin: Client;
const enqueueSql = "SELECT app.b028_delivery_enqueue($1,'rent_due',$2,$3,$4) AS id";
const claimSql = "SELECT * FROM app.b028_delivery_claim($1,$2,$3,$4)";
const completeSql = "SELECT app.b028_delivery_complete($1,$2,$3,$4,$5)";
type Claim = { attempt_id: string; token: string; attempt: number };
const denied = (e: unknown) => (e as { code?: string }).code === "42501";
async function connect() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("SET statement_timeout='10s'");
  return c;
}
async function begin(c: Client, org = ORG_ID) {
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.active_org_id',$1,true)", [org]);
  await c.query("SET LOCAL ROLE service_role");
}
async function service(c: Client, sql: string, args: unknown[], org = ORG_ID) {
  await begin(c, org);
  try {
    const result = await c.query(sql, args);
    await c.query("COMMIT");
    return result;
  } catch (e) { await c.query("ROLLBACK"); throw e; }
}
async function enable() {
  await admin.query(`INSERT INTO platform_settings(key,value) VALUES('notification_delivery_v2',$1)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] })]);
  await admin.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_delivery_v2":true}'::jsonb WHERE id=ANY($1::uuid[])`, [[ORG_ID, ORG2_ID]]);
}
async function enqueue(c: Client, source = randomUUID(), recipient = `contact:${randomUUID()}`, channel = "email") {
  return (await service(c, enqueueSql, [ORG_ID, source, recipient, channel])).rows[0].id as string;
}
async function claim(c: Client, channel = "email", limit = 10): Promise<Claim[]> {
  return (await service(c, claimSql, [ORG_ID, channel, limit, 120])).rows;
}
async function complete(c: Client, row: Claim, result = "captured", org = ORG_ID) {
  return service(c, completeSql, [row.attempt_id, row.token, result, null, result === "failed" ? "test_failure" : null], org);
}

test.before(async () => {
  clone = await cloneTestDatabase();
  admin = await connect();
});
test.beforeEach(async () => {
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
    await enable();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
});
test.after(async () => { await admin?.end(); await clone?.cleanup(); });

test("two_workers_one_attempt_and_truthful_results", async () => {
  const a = await connect(), b = await connect();
  try {
    const source = randomUUID(), recipient = `contact:${randomUUID()}`;
    const ids = await Promise.all([enqueue(a, source, recipient), enqueue(b, source, recipient)]);
    assert.equal(ids[0], ids[1]);
    assert.equal((await admin.query("SELECT * FROM app.b028_delivery_attempts")).rowCount, 1);
    assert.equal((await admin.query("SELECT * FROM app.b028_delivery_attempt_events")).rowCount, 1);
    // Hold the first claim uncommitted: a second backend must skip the locked row.
    await begin(a);
    const first = (await a.query<Claim>(claimSql, [ORG_ID, "email", 10, 120])).rows[0];
    assert.ok(first);
    assert.deepEqual(await claim(b), []);
    await a.query("COMMIT");
    assert.deepEqual(await claim(b), []);
    const stored = (await admin.query("SELECT claim_token_hash FROM app.b028_delivery_attempts WHERE id=$1", [ids[0]])).rows[0];
    assert.ok(stored.claim_token_hash === createHash("sha256").update(first.token).digest("hex"));
    await complete(a, first);
    assert.deepEqual(await claim(b), []);
    await assert.rejects(complete(a, first), denied);
    assert.deepEqual(await deliveryStatus(ORG_ID, "rent_due", source), { queued: 0, claimed: 0, captured: 1, accepted: 0, failed: 0, unknown: 0 });
    assert.deepEqual((await admin.query("SELECT status FROM app.b028_delivery_attempt_events ORDER BY created_at,id")).rows.map(r => r.status), ["queued", "claimed", "captured"]);
  } finally { await a.query("ROLLBACK"); await a.end(); await b.end(); }
});

test("expired claims get fresh tokens; stale or expired completion cannot mutate a row", async () => {
  const a = await connect(), b = await connect();
  try {
    const id = await enqueue(a);
    const [old] = await claim(a);
    await admin.query("UPDATE app.b028_delivery_attempts SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await assert.rejects(complete(a, old), denied);
    const [fresh] = await claim(b);
    assert.ok(fresh.token !== old.token);
    assert.equal(fresh.attempt, 2);
    await assert.rejects(complete(a, old), denied);
    await complete(b, fresh);
    assert.deepEqual(await claim(a), []);
  } finally { await a.end(); await b.end(); }
});

test("failure requeues, retry captures, fifth failure and fifth expired claim remain failed", async () => {
  const c = await connect();
  try {
    const id = await enqueue(c);
    await complete(c, (await claim(c))[0], "failed");
    assert.equal((await admin.query("SELECT status FROM app.b028_delivery_attempts WHERE id=$1", [id])).rows[0].status, "queued");
    const [retry] = await claim(c);
    assert.equal(retry.attempt, 2);
    await complete(c, retry);
    assert.deepEqual((await admin.query("SELECT status FROM app.b028_delivery_attempt_events WHERE attempt_id=$1 ORDER BY created_at,id", [id])).rows.map(r => r.status), ["queued", "claimed", "failed", "queued", "claimed", "captured"]);
    const exhausted = await enqueue(c);
    for (let n = 1; n <= 5; n++) {
      const [row] = await claim(c);
      assert.equal(row.attempt, n);
      await complete(c, row, "failed");
    }
    assert.deepEqual(await claim(c), []);
    assert.equal((await admin.query("SELECT status FROM app.b028_delivery_attempts WHERE id=$1", [exhausted])).rows[0].status, "failed");
    const expired = await enqueue(c);
    for (let n = 1; n <= 5; n++) {
      assert.equal((await claim(c))[0].attempt, n);
      await admin.query("UPDATE app.b028_delivery_attempts SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired]);
    }
    assert.deepEqual(await claim(c), []);
    assert.equal((await admin.query("SELECT status FROM app.b028_delivery_attempts WHERE id=$1", [expired])).rows[0].status, "failed");
  } finally { await c.end(); }
});

const offCases: [string, unknown, unknown][] = [
  ["absent", undefined, true],
  ["false", { enabled: false, allowed_org_ids: [ORG_ID] }, true],
  ["string enabled", { enabled: "true", allowed_org_ids: [ORG_ID] }, true],
  ["malformed", "invalid", true],
  ["missing enabled", { allowed_org_ids: [ORG_ID] }, true],
  ["missing allowlist", { enabled: true }, true],
  ["malformed allowlist", { enabled: true, allowed_org_ids: ORG_ID }, true],
  ["org excluded", { enabled: true, allowed_org_ids: [ORG2_ID] }, true],
  ["org false", { enabled: true, allowed_org_ids: [ORG_ID] }, false],
  ["org string true", { enabled: true, allowed_org_ids: [ORG_ID] }, "true"],
];
for (const [name, setting, flag] of offCases) {
  test(`OFF ${name}: enqueue denied and both private tables stay empty`, async () => {
    if (setting === undefined) await admin.query("DELETE FROM platform_settings WHERE key='notification_delivery_v2'");
    else await admin.query("UPDATE platform_settings SET value=$1 WHERE key='notification_delivery_v2'", [JSON.stringify(setting)]);
    await admin.query("UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{notification_delivery_v2}',$1) WHERE id=$2", [JSON.stringify(flag), ORG_ID]);
    const c = await connect();
    try {
      await assert.rejects(enqueue(c), (e: unknown) => denied(e) && (e as Error).message === "Delivery unavailable");
      assert.deepEqual(await claim(c), []);
      assert.deepEqual((await service(c, "SELECT * FROM app.b028_delivery_status($1,'rent_due',$2)", [ORG_ID, randomUUID()])).rows, []);
      await assert.rejects(complete(c, { attempt_id: randomUUID(), token: "invalid", attempt: 1 }), denied);
      for (const table of ["b028_delivery_attempts", "b028_delivery_attempt_events"]) {
        assert.equal((await admin.query(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0].n, 0);
      }
    } finally { await c.end(); }
  });
}

test("cross-org status and claims are invisible and completion rejects even another org's valid token", async () => {
  const c = await connect();
  try {
    const source = randomUUID();
    await enqueue(c, source);
    const [row] = await claim(c);
    assert.deepEqual((await service(c, claimSql, [ORG2_ID, "email", 10, 120], ORG2_ID)).rows, []);
    assert.deepEqual((await service(c, "SELECT * FROM app.b028_delivery_status($1,'rent_due',$2)", [ORG2_ID, source], ORG2_ID)).rows, []);
    assert.deepEqual((await service(c, "SELECT * FROM app.b028_delivery_status($1,'rent_due',$2)", [ORG_ID, source], ORG2_ID)).rows, []);
    await assert.rejects(complete(c, row, "captured", ORG2_ID), denied);
    await complete(c, row);
  } finally { await c.end(); }
});

test("service runner captures locally, records adapter exceptions, and returns distinct status counts", async () => {
  const source = randomUUID();
  await enqueueDelivery(ORG_ID, "rent_due", source, "contact:one", "line");
  await enqueueDelivery(ORG_ID, "rent_due", source, "contact:two", "line");
  const adapter = createCaptureAdapter("line");
  assert.equal(await runDeliveryAttempts(ORG_ID, adapter, 1), 1);
  assert.equal(adapter.captures.length, 1);
  assert.deepEqual(Object.keys(adapter.captures[0]).sort(), ["attempt", "attemptId", "recipientKey", "sourceId", "sourceKind"]);
  assert.equal(await runDeliveryAttempts(ORG_ID, { channel: "line", async deliver() { throw new Error("private provider detail"); } }, 1), 1);
  assert.equal((await admin.query("SELECT failure_code FROM app.b028_delivery_attempts WHERE status='queued'")).rows[0].failure_code, "adapter_error");
  await runDeliveryAttempts(ORG_ID, { channel: "line", async deliver() { return { result: "accepted", providerRef: "local-provider-ref" }; } }, 1);
  assert.equal(await runDeliveryAttempts(ORG_ID, adapter, 10), 0);
  await enqueueDelivery(ORG_ID, "rent_due", source, "contact:queued", "email");
  const c = await connect();
  try {
    await enqueue(c, source, "contact:failed", "line");
    for (let i = 0; i < 5; i++) await complete(c, (await claim(c, "line"))[0], "failed");
    await enqueue(c, source, "contact:claimed", "line");
    await claim(c, "line");
    assert.deepEqual(await deliveryStatus(ORG_ID, "rent_due", source), { queued: 1, claimed: 1, captured: 1, accepted: 1, failed: 1, unknown: 0 });
    assert.equal((await admin.query("SELECT provider_ref FROM app.b028_delivery_attempts WHERE status='accepted'")).rows[0].provider_ref, "local-provider-ref");
  } finally { await c.end(); }
});

test("OFF after claim denies completion and preserves every existing attempt and event", async () => {
  const c = await connect();
  try {
    await enqueue(c);
    const [row] = await claim(c);
    const before = await Promise.all(["b028_delivery_attempts", "b028_delivery_attempt_events"].map(async table =>
      (await admin.query(`SELECT * FROM app.${table} ORDER BY id`)).rows));
    await admin.query("UPDATE platform_settings SET value='{}' WHERE key='notification_delivery_v2'");
    await assert.rejects(complete(c, row), denied);
    assert.deepEqual(await claim(c), []);
    const after = await Promise.all(["b028_delivery_attempts", "b028_delivery_attempt_events"].map(async table =>
      (await admin.query(`SELECT * FROM app.${table} ORDER BY id`)).rows));
    assert.deepEqual(after, before);
  } finally { await c.end(); }
});

test("privilege catalog, RLS without policies, immutable audit and input constraints", async () => {
  const functions = (await admin.query(`SELECT p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('service_role',p.oid,'EXECUTE') AS service,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'b028_delivery_%'`)).rows;
  assert.equal(functions.length, 7);
  for (const f of functions) {
    assert.equal(f.prosecdef, true);
    assert.deepEqual(f.proconfig, ["search_path=pg_catalog, public, app", "lock_timeout=2s"]);
    assert.equal(f.anon || f.authenticated || f.public, false);
    assert.equal(f.service, !["b028_delivery_record_event", "b028_delivery_events_immutable"].includes(f.proname));
  }
  const tables = (await admin.query(`SELECT cl.relname,cl.relrowsecurity,
    EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=cl.oid) AS policies,
    EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
      AND has_table_privilege(r.oid,cl.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS granted,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) a WHERE a.grantee=0) AS public
    FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='app'
      AND cl.relname IN ('b028_delivery_attempts','b028_delivery_attempt_events')`)).rows;
  assert.equal(tables.length, 2);
  for (const t of tables) assert.deepEqual([t.relrowsecurity, t.policies, t.granted, t.public], [true, false, false, false]);
  const c = await connect();
  try {
    const id = await enqueue(c);
    for (const sql of ["UPDATE app.b028_delivery_attempt_events SET status='failed'", "DELETE FROM app.b028_delivery_attempt_events", "TRUNCATE app.b028_delivery_attempt_events"]) {
      await assert.rejects(admin.query(sql), denied);
    }
    for (const [column, value] of [["channel", "sms"], ["status", "sent"], ["attempt", -1], ["recipient_key", ""], ["recipient_key", "x".repeat(201)], ["recipient_key", "bad key"]]) {
      await assert.rejects(admin.query(`UPDATE app.b028_delivery_attempts SET ${column}=$1 WHERE id=$2`, [value, id]), (e: unknown) => (e as { code?: string }).code === "23514");
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      await c.query(`SET ROLE ${role}`);
      await assert.rejects(c.query("SELECT * FROM app.b028_delivery_attempts"), denied);
      await assert.rejects(c.query("SELECT * FROM app.b028_delivery_attempt_events"), denied);
      await c.query("RESET ROLE");
    }
  } finally { await c.end(); }
});

test("two delayed runners never dispatch the same attempt (claim-before-dispatch, bounded adapter)", async () => {
  const source = randomUUID();
  for (let i = 0; i < 4; i++) await enqueueDelivery(ORG_ID, "rent_due", source, `contact:delay-${i}`, "line");
  const seen: string[] = [];
  const slow = (name: string) => ({
    channel: "line" as const,
    async deliver(req: { attemptId: string }) {
      seen.push(`${name}:${req.attemptId}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { result: "captured" as const };
    },
  });
  const [a, b] = await Promise.all([runDeliveryAttempts(ORG_ID, slow("A"), 4), runDeliveryAttempts(ORG_ID, slow("B"), 4)]);
  assert.equal(a + b, 4);
  const ids = seen.map((entry) => entry.split(":")[1]);
  assert.equal(new Set(ids).size, ids.length, "each attempt dispatched exactly once across both workers");
  assert.deepEqual(await deliveryStatus(ORG_ID, "rent_due", source), { queued: 0, claimed: 0, captured: 4, accepted: 0, failed: 0, unknown: 0 });
});

test("a timed-out adapter is recorded unknown, never re-dispatched, and a late acceptance changes nothing", async () => {
  const source = randomUUID();
  await enqueueDelivery(ORG_ID, "rent_due", source, "contact:late", "line");
  let calls = 0, release: ((value: { result: "accepted" }) => void) | undefined;
  const late = { channel: "line" as const, deliver: () => { calls++; return new Promise<{ result: "accepted" }>((resolve) => { release = resolve; }); } };
  assert.equal(await runDeliveryAttempts(ORG_ID, late, 1, { adapterTimeoutMs: 50 }), 1);
  const row = (await admin.query("SELECT id,status,failure_code,attempt FROM app.b028_delivery_attempts WHERE recipient_key='contact:late'")).rows[0];
  assert.deepEqual([row.status, row.failure_code, row.attempt], ["unknown", "adapter_timeout", 1]);
  const events = (await admin.query("SELECT count(*)::int n FROM app.b028_delivery_attempt_events WHERE attempt_id=$1", [row.id])).rows[0].n;
  // Other workers find nothing to claim: unknown is terminal for automatic processing.
  assert.equal(await runDeliveryAttempts(ORG_ID, late, 5, { adapterTimeoutMs: 50 }), 0);
  release?.({ result: "accepted" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "exactly one dispatch");
  const after = (await admin.query("SELECT status,attempt FROM app.b028_delivery_attempts WHERE id=$1", [row.id])).rows[0];
  assert.deepEqual([after.status, after.attempt], ["unknown", 1]);
  assert.equal((await admin.query("SELECT count(*)::int n FROM app.b028_delivery_attempt_events WHERE attempt_id=$1", [row.id])).rows[0].n, events);
  assert.equal((await deliveryStatus(ORG_ID, "rent_due", source)).unknown, 1);
});

test("an expired lease is reclaimed by another worker with a new token; the first worker's late completion is rejected", async () => {
  const c = await connect(), d = await connect();
  try {
    await enqueue(c);
    const first = (await service(c, claimSql, [ORG_ID, "email", 1, 1])).rows[0] as Claim;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = (await service(d, claimSql, [ORG_ID, "email", 1, 120])).rows[0] as Claim;
    assert.equal(second.attempt_id, first.attempt_id);
    assert.notEqual(second.token, first.token);
    await assert.rejects(complete(c, first), denied);
    await complete(d, second);
    assert.equal((await admin.query("SELECT status FROM app.b028_delivery_attempts WHERE id=$1", [first.attempt_id])).rows[0].status, "captured");
  } finally { await c.end(); await d.end(); }
});

test("contended completion fails fast with busy and changes no attempt or event", async () => {
  const c = await connect(), holder = await connect();
  try {
    await enqueue(c);
    const [row] = await claim(c);
    const before = (await admin.query("SELECT (SELECT md5(string_agg(t::text,'' ORDER BY t::text)) FROM app.b028_delivery_attempts t) a, (SELECT count(*) FROM app.b028_delivery_attempt_events) e")).rows[0];
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM app.b028_delivery_attempts WHERE id=$1 FOR UPDATE", [row.attempt_id]);
    await assert.rejects(complete(c, row), (e: unknown) => (e as { code?: string }).code === "55P03");
    await holder.query("ROLLBACK");
    const after = (await admin.query("SELECT (SELECT md5(string_agg(t::text,'' ORDER BY t::text)) FROM app.b028_delivery_attempts t) a, (SELECT count(*) FROM app.b028_delivery_attempt_events) e")).rows[0];
    assert.deepEqual(after, before);
    await complete(c, row);
  } finally { await holder.end(); await c.end(); }
});
