import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { svc, tx } from "./db";
import { createCaptureAdapter, enqueueDelivery, runDeliveryAttempts } from "./notification-delivery";
import type { PushOutcome } from "./line/transport";
import { createWebhookPost, providerUserHash } from "./line/webhook";
import { createCapturedLineTransport } from "./line/transport";
import { dispatchLinePush, expireLinePushes, type LinePush } from "./line/quota";
import { POST } from "../app/api/line/webhook/route";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client, channel: string;
const secret = "local-test-secret", pepper = "local-test-pepper", destination = "local-bot";
const to = "U" + "c".repeat(32);
const env = { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" };
const newTables = ["app.b033_push_fallbacks", "app.b033_line_identities", "app.b033_line_flows", "app.b033_webhook_events", "public.line_push_usage", "app.b033_push_reservations", "app.b033_quota_alerts", "app.b033_org_push_budgets"];
const reserveSql = "SELECT period_month::text,status,pushed_count,reserved_count FROM app.b033_push_reserve($1,$2,$3,$4,$5)";
async function connect() { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; }
async function enable() {
  for (const key of ["line_platform", "line_push", "notification_delivery_v2"]) {
    await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
  }
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"line_platform":true,"line_push":true,"notification_delivery_v2":true}'::jsonb WHERE id=$1`, [ORG_ID]);
}
async function fixture(): Promise<LinePush> {
  await db.query("UPDATE line_channels SET liff_id_tenant='local-tenant' WHERE id=$1", [channel]);
  await svc(null, c => c.query("SELECT app.b033_channel_verify($1)", [channel]));
  await budget(180);
  const user = randomUUID();
  await db.query("INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')", [user, `${user}@example.invalid`]);
  const contact = (await db.query(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name,email)
    VALUES($1,$2,true,'B033 local','b033@example.invalid') RETURNING id`, [ORG_ID, user])).rows[0].id;
  const identity = (await db.query(`INSERT INTO app.b033_line_identities(line_channel_id,provider_user_hash,user_id,persona,friend_state)
    VALUES($1,$2,$3,'tenant',true) ON CONFLICT(line_channel_id,provider_user_hash) DO UPDATE SET friend_state=true RETURNING id`,
    [channel, providerUserHash("provider-demo", to, pepper), user])).rows[0].id;
  await db.query(`INSERT INTO line_account_links(org_id,contact_id,line_channel_id,status,linked_at,is_friend,line_user_id,
    login_identity_id,identity_verified_at,notification_opt_in,consented_at,consent_text_key)
    VALUES($1,$2,$3,'linked',now(),true,$4,$5,now(),true,now(),'local-test')`, [ORG_ID, contact, channel, to, identity]);
  const notification = (await db.query(`INSERT INTO notifications(org_id,recipient_contact_id,event_type,template_key,locale)
    VALUES($1,$2,'b033_test','local-test','en') RETURNING id`, [ORG_ID, contact])).rows[0].id;
  return { orgId: ORG_ID, notificationId: notification, claimId: randomUUID(), channelId: channel,
    persona: "tenant", to, identityPepper: pepper, messages: [{ type: "text", text: "local test" }] };
}
function event(id: string, type: string, timestamp = 1000, token = "local-reply-token") {
  return { webhookEventId: id, type, timestamp, source: { userId: to }, replyToken: token };
}
function request(events: ReturnType<typeof event>[], options: { signature?: string; raw?: string; destination?: string } = {}) {
  const raw = options.raw ?? JSON.stringify({ destination: options.destination ?? destination, events });
  const signature = options.signature ?? createHmac("sha256", secret).update(raw).digest("base64");
  return new Request(`http://localhost/api/line/webhook?org=${ORG_ID}&channel=${channel}`,
    { method: "POST", headers: { "x-line-signature": signature }, body: raw });
}
function handler(mode: "accepted" | "failed" | "timeout" = "accepted") {
  const transport = createCapturedLineTransport({ mode });
  const post = createWebhookPost({ env, transport, resolveSecret: async ref => {
    assert.equal(ref, "vault://demo/line/secret"); return { secret, identityPepper: pepper, destination };
  }, replyMessages: () => [{ type: "text", text: "local test" }] });
  return { post, transport };
}
async function usage(pushed = 0) {
  await db.query(`INSERT INTO line_push_usage(line_channel_id,period_month,pushed_count)
    VALUES($1,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,$2)
    ON CONFLICT(line_channel_id,period_month) DO UPDATE SET pushed_count=$2`, [channel, pushed]);
}
async function counts() { return (await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0]; }
async function budget(limit: number) {
  await svc(null, c => c.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,$3)", [channel, ORG_ID, limit]));
}
async function reserve(req: LinePush) { return svc(null, c => c.query(reserveSql, [channel, req.claimId, req.orgId, req.notificationId, 180])); }
async function assertFallback(req: LinePush, why: string) {
  const rows = (await db.query("SELECT channel,status,error,counts_toward_quota FROM deliveries WHERE notification_id=$1 AND b033_claim_id IS NOT NULL ORDER BY channel", [req.notificationId])).rows;
  assert.deepEqual(rows, [{ channel: "email", status: "queued", error: why, counts_toward_quota: false },
    { channel: "line", status: "skipped", error: why, counts_toward_quota: false }]);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'", [req.notificationId])).rows[0].n, 1);
}
test.before(async () => { clone = await cloneTestDatabase(); db = await connect(); });
test.beforeEach(async () => {
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true"; process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed(); await enable();
    channel = (await db.query("SELECT id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0].id;
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });

test("signed webhook dedupes, orders friendship, preserves consent and never creates identities", async () => {
  const req = await fixture(), { post } = handler();
  assert.equal((await post(request([event("new", "unfollow", 3000)]))).status, 200);
  assert.equal((await post(request([event("new", "unfollow", 3000), event("old", "follow", 2000)]))).status, 200);
  assert.equal((await db.query("SELECT friend_state FROM app.b033_line_identities")).rows[0].friend_state, false);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_webhook_events")).rows[0].n, 2);
  await post(request([event("same", "follow", 3000)]));
  assert.equal((await db.query("SELECT friend_state FROM app.b033_line_identities")).rows[0].friend_state, false);
  await post(request([event("newer", "follow", 4000)]));
  await post(request([event("tie-unfollow", "unfollow", 4000)]));
  const link = (await db.query("SELECT is_friend,notification_opt_in,status,friend_event_at FROM line_account_links WHERE login_identity_id IS NOT NULL")).rows[0];
  assert.equal(link.is_friend, false); assert.equal(link.notification_opt_in, true); assert.equal(link.status, "linked");
  assert.equal(link.friend_event_at.toISOString(), "1970-01-01T00:00:04.000Z");
  await db.query("UPDATE line_account_links SET status='unlinked',unlinked_at=now(),notification_opt_in=false WHERE login_identity_id IS NOT NULL");
  await post(request([event("after-unlink", "follow", 5000)]));
  assert.equal((await db.query("SELECT is_friend FROM line_account_links WHERE login_identity_id IS NOT NULL")).rows[0].is_friend, false);
  const other = event("unknown-user", "follow", 6000); other.source.userId = "U" + "d".repeat(32);
  await post(request([other]));
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_line_identities")).rows[0].n, 1);
  assert.equal(req.channelId, channel);
});

test("reply-only for message/postback at full quota; duplicate/expired/used token never pushes", async () => {
  await usage(180);
  for (const mode of ["accepted", "failed", "timeout"] as const) {
    const { post, transport } = handler(mode);
    const events = [event(`${mode}-message`, "message"), event(`${mode}-postback`, "postback")];
    assert.equal((await post(request(events))).status, 200);
    assert.equal((await post(request(events))).status, 200);
    assert.deepEqual(transport.calls.map(c => c.method), ["reply", "reply"]);
  }
  assert.deepEqual(await counts(), { pushed_count: 180, reserved_count: 0 });
});

test("invalid signatures reject before JSON parse, destination/body invalid never persist", async () => {
  const { post, transport } = handler();
  assert.equal((await post(request([], { raw: "not JSON", signature: "wrong" }))).status, 401);
  assert.equal((await post(request([], { raw: "not JSON" }))).status, 400);
  assert.equal((await post(request([], { destination: "wrong-bot" }))).status, 400);
  assert.equal((await post(request([]))).status, 200);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_webhook_events")).rows[0].n, 0);
  assert.equal(transport.calls.length, 0);
});

test("179 + five simultaneous reserves on separate connections grants exactly one", async () => {
  const req = await fixture(); await usage(179);
  const clients = await Promise.all(Array.from({ length: 5 }, connect));
  try {
    const results = await Promise.all(clients.map(async c => {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
      const r = await c.query(reserveSql, [channel, randomUUID(), ORG_ID, req.notificationId, 180]); await c.query("COMMIT"); return r.rowCount;
    }));
    assert.equal(results.reduce((a, b) => a! + b!, 0), 1);
    assert.deepEqual(await counts(), { pushed_count: 179, reserved_count: 1 });
  } finally { await Promise.all(clients.map(c => c.end())); }
});
for (const used of [180, 181]) test(`${used} blocks dispatch; skipped line_quota and one Email claim per notification`, async () => {
  const req = await fixture(); await usage(used);
  const transport = createCapturedLineTransport({ mode: "accepted" });
  await dispatchLinePush(req, transport, env); await dispatchLinePush(req, transport, env);
  assert.equal(transport.calls.length, 0); await assertFallback(req, "line_quota");
  const second = (await db.query(`INSERT INTO notifications(org_id,recipient_contact_id,event_type,template_key,locale)
    SELECT org_id,recipient_contact_id,'b033_test','local-test','en' FROM notifications WHERE id=$1 RETURNING id`, [req.notificationId])).rows[0].id;
  await dispatchLinePush({ ...req, notificationId: second, claimId: randomUUID() }, transport, env);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE channel='email'")).rows[0].n, 2);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_quota_alerts")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE event_type='line_quota'")).rows[0].n, 1);
});
for (const guard of [undefined, "false", "bad"]) test(`guard ${guard} fails closed with deduped Email`, async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  await dispatchLinePush(req, t, { ...env, LINE_PUSH_QUOTA_GUARD: guard });
  await dispatchLinePush(req, t, { ...env, LINE_PUSH_QUOTA_GUARD: guard });
  assert.equal(t.calls.length, 0); await assertFallback(req, "line_guard");
  assert.equal((await db.query("SELECT count(*)::int n FROM line_push_usage")).rows[0].n, 0);
});
test("locked counter fails closed, rolls back reservation and claims Email", async () => {
  const req = await fixture(); await usage(0); const holder = await connect();
  try {
    await holder.query("BEGIN"); await holder.query("SELECT 1 FROM line_push_usage FOR UPDATE");
    const t = createCapturedLineTransport({ mode: "accepted" });
    await dispatchLinePush(req, t, env); assert.equal(t.calls.length, 0); await assertFallback(req, "line_guard");
  } finally { await holder.query("ROLLBACK"); await holder.end(); }
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 0 });
});
test("revoked counter gateway cannot dispatch", async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  await db.query("REVOKE EXECUTE ON FUNCTION app.b033_push_reserve(uuid,uuid,uuid,uuid,int) FROM service_role");
  try { await dispatchLinePush(req, t, env); assert.equal(t.calls.length, 0); await assertFallback(req, "line_guard"); }
  finally { await db.query("GRANT EXECUTE ON FUNCTION app.b033_push_reserve(uuid,uuid,uuid,uuid,int) TO service_role"); }
});

test("same claim reserves once; timeout retains, duplicate acceptance settles once and retries preserve key", async () => {
  const req = await fixture(); await usage(179);
  const timeout = createCapturedLineTransport({ mode: "timeout" });
  assert.equal((await dispatchLinePush(req, timeout, env)).status, "unknown");
  assert.deepEqual(await counts(), { pushed_count: 179, reserved_count: 1 });
  assert.equal((await reserve(req)).rows[0].status, "unknown");
  const duplicate = createCapturedLineTransport({ mode: "duplicateAccepted" });
  assert.equal((await dispatchLinePush(req, duplicate, env)).status, "accepted");
  assert.equal((await dispatchLinePush(req, duplicate, env)).status, "accepted");
  assert.equal(duplicate.calls.length, 1);
  for (const t of [timeout, duplicate]) {
    const call = t.calls[0]; assert.equal(call.method, "push");
    if (call.method === "push") assert.equal(call.request.headers["X-Line-Retry-Key"], req.claimId);
  }
  assert.deepEqual(await counts(), { pushed_count: 180, reserved_count: 0 });
  assert.equal((await svc(null, c => c.query("SELECT app.b033_push_settle($1,$2) AS done", [req.claimId, randomUUID()]))).rows[0].done, false);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_quota_alerts")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts")).rows[0].n, 0);
});
test("explicit unaccepted failure releases; failures after unknown do not release", async () => {
  const req = await fixture();
  await dispatchLinePush(req, createCapturedLineTransport({ mode: "failed" }), env);
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 0 });
  assert.equal((await db.query("SELECT status FROM app.b033_push_reservations")).rows[0].status, "released");
  const retry = { ...req, claimId: randomUUID() };
  await dispatchLinePush(retry, createCapturedLineTransport({ mode: "timeout" }), env);
  assert.equal((await dispatchLinePush(retry, createCapturedLineTransport({ mode: "failed" }), env)).status, "unknown");
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
});

test("Taipei boundary and settlement/release use original November row; December untouched", async () => {
  const req = await fixture();
  const periods = (await db.query(`SELECT date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Taipei')::date::text AS before,
    date_trunc('month',$2::timestamptz AT TIME ZONE 'Asia/Taipei')::date::text AS after`,
    ["2026-11-30T15:59:59Z", "2026-11-30T16:00:00Z"])).rows[0];
  assert.deepEqual(periods, { before: "2026-11-01", after: "2026-12-01" });
  await db.query(`INSERT INTO line_push_usage(line_channel_id,period_month,reserved_count) VALUES($1,'2026-11-01',2),($1,'2026-12-01',0)`, [channel]);
  const settled = randomUUID(), released = randomUUID(), owner = randomUUID();
  await db.query(`INSERT INTO app.b033_org_push_budgets(line_channel_id,org_id,period_month,budget,reserved)
    VALUES($1,$2,'2026-11-01',180,2) ON CONFLICT(line_channel_id,org_id,period_month) DO UPDATE SET reserved=2`, [channel, ORG_ID]);
  await db.query(`INSERT INTO app.b033_push_reservations(claim_id,line_channel_id,period_month,org_id,notification_id,notification_deadline,status,owner_token,started_at)
    VALUES($1,$3,'2026-11-01',$4,$5,now()+interval '5 minutes','dispatching',$6,now()),
      ($2,$3,'2026-11-01',$4,$5,now()+interval '5 minutes','dispatching',$6,now())`, [settled, released, channel, ORG_ID, req.notificationId, owner]);
  const december = (await db.query("SELECT * FROM line_push_usage WHERE period_month='2026-12-01'")).rows;
  await svc(null, c => c.query("SELECT app.b033_push_settle($1,$3),app.b033_push_release($2,$3)", [settled, released, owner]));
  await svc(null, c => c.query("SELECT app.b033_push_settle($1,$3),app.b033_push_release($2,$3)", [settled, released, owner]));
  assert.deepEqual((await db.query("SELECT * FROM line_push_usage WHERE period_month='2026-12-01'")).rows, december);
  assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE period_month='2026-11-01'")).rows[0], { pushed_count: 1, reserved_count: 0 });
});
const offCases: [string, unknown, unknown][] = [
  ["absent", undefined, true], ["false", { enabled: false, allowed_org_ids: [ORG_ID] }, true],
  ["malformed", "invalid", true], ["string enabled", { enabled: "true", allowed_org_ids: [ORG_ID] }, true],
  ["bad allowlist", { enabled: true, allowed_org_ids: ORG_ID }, true],
  ["org not allowlisted", { enabled: true, allowed_org_ids: [ORG2_ID] }, true],
  ["org false", { enabled: true, allowed_org_ids: [ORG_ID] }, false],
  ["org string true", { enabled: true, allowed_org_ids: [ORG_ID] }, "true"],
];
for (const [name, setting, flag] of offCases) test(`OFF ${name}: route 404, zero rows in every new table`, async () => {
  if (setting === undefined) await db.query("DELETE FROM platform_settings WHERE key='line_platform'");
  else await db.query("UPDATE platform_settings SET value=$1 WHERE key='line_platform'", [JSON.stringify(setting)]);
  await db.query("UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{line_platform}',$1) WHERE id=$2", [JSON.stringify(flag), ORG_ID]);
  const post = createWebhookPost({ env, resolveSecret: async () => { throw new Error("OFF must not resolve secrets"); },
    transport: createCapturedLineTransport({ mode: "accepted" }) });
  assert.equal((await post(request([event("off", "follow")]))).status, 404);
  for (const table of newTables) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, table);
});
test("actual POST env OFF makes no DB connection; unselected/inactive channel stays OFF", async () => {
  const old = process.env.LINE_PLATFORM_ENABLED, url = process.env.DATABASE_URL;
  try {
    process.env.LINE_PLATFORM_ENABLED = "false";
    process.env.DATABASE_URL = "postgres://invalid@127.0.0.1:1/unreachable";
    assert.equal((await POST(request([event("env-off", "follow")]))).status, 404);
  } finally {
    if (old === undefined) delete process.env.LINE_PLATFORM_ENABLED; else process.env.LINE_PLATFORM_ENABLED = old;
    process.env.DATABASE_URL = url;
  }
  await db.query("UPDATE line_channels SET is_active=false WHERE id=$1", [channel]);
  assert.equal((await handler().post(request([event("inactive", "follow")]))).status, 404);
  for (const table of newTables) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
});

test("legacy links never qualify; selected OA and verified identity hash are rechecked", async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  const wrongHash = { ...req, to: "U" + "f".repeat(32) };
  await dispatchLinePush(wrongHash, t, env);
  assert.equal(t.calls.length, 0);
  await db.query("UPDATE line_account_links SET notification_opt_in=false,login_identity_id=NULL,identity_verified_at=NULL WHERE login_identity_id IS NOT NULL");
  await dispatchLinePush(req, t, env);
  assert.equal(t.calls.length, 0); await assertFallback(req, "line_guard");
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_push_reservations")).rows[0].n, 0);
});

test("flag lock order fails fast; flag contention cannot make webhook writes", async () => {
  const holder = await connect();
  try {
    await holder.query("BEGIN"); await holder.query("LOCK TABLE platform_settings IN ROW EXCLUSIVE MODE");
    assert.equal((await handler().post(request([event("busy", "follow")]))).status, 503);
    for (const table of newTables) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  } finally { await holder.query("ROLLBACK"); await holder.end(); }
});

test("privilege catalog: RLS, no client grants, service-only pinned gateways; quota CHECKs", async () => {
  for (const table of newTables) {
    const row = (await db.query(`SELECT c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') a,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') u,
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') s,
      EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid) policies
      FROM pg_class c WHERE c.oid=$1::regclass`, [table])).rows[0];
    assert.deepEqual(row, { relrowsecurity: true, a: false, u: false, s: true, policies: false });
  }
  const functions = (await db.query(`SELECT p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('service_role',p.oid,'EXECUTE') s,
    has_function_privilege('anon',p.oid,'EXECUTE') a,has_function_privilege('authenticated',p.oid,'EXECUTE') u,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'b033_%'`)).rows;
  assert.equal(functions.length, 22);
  for (const f of functions) {
    assert.equal(f.prosecdef, !["b033_channel_verified_guard", "b033_liff_config_guard"].includes(f.proname)); assert.ok(f.proconfig.includes("search_path=pg_catalog, public, app"));
    assert.equal(f.a || f.u || f.public, false); assert.equal(f.s, !["b033_link_verified_guard", "b033_line_audit", "b033_channel_verified_guard", "b033_liff_config_guard"].includes(f.proname));
  }
  const definition = (await db.query("SELECT pg_get_functiondef('app.b033_line_enabled(uuid)'::regprocedure) AS def")).rows[0].def as string;
  assert.ok(definition.indexOf("LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT") < definition.indexOf("FOR SHARE NOWAIT"));
  const c = await connect();
  try {
    for (const role of ["anon", "authenticated"]) {
      await c.query(`SET ROLE ${role}`);
      await assert.rejects(c.query("SELECT * FROM public.line_push_usage"), (e: unknown) => (e as { code?: string }).code === "42501");
      await assert.rejects(c.query("SELECT app.b033_line_enabled($1)", [ORG_ID]), (e: unknown) => (e as { code?: string }).code === "42501");
      await c.query("RESET ROLE");
    }
  } finally { await c.end(); }
  for (const [period, pushed, reserved] of [["2026-11-02", 0, 0], ["2026-11-01", -1, 0], ["2026-11-01", 0, -1]])
    await assert.rejects(db.query("INSERT INTO line_push_usage(line_channel_id,period_month,pushed_count,reserved_count) VALUES($1,$2,$3,$4)",
      [channel, period, pushed, reserved]), (e: unknown) => (e as { code?: string }).code === "23514");
});

test("an active but unselected OA cannot receive webhooks or dispatch; legacy identity columns untouched", async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  const before = (await db.query("SELECT id,line_user_id FROM contacts ORDER BY id")).rows;
  const selected = (await db.query(`INSERT INTO line_channels(org_id,mode,display_name,line_provider_id,messaging_channel_id,
    messaging_channel_secret_ref,messaging_access_token_ref) VALUES($1,'org_owned','local','local-provider',$2,'local-secret-ref','local-token-ref') RETURNING id`,
    [ORG_ID, randomUUID()])).rows[0].id;
  await db.query("UPDATE organizations SET line_channel_id=$1 WHERE id=$2", [selected, ORG_ID]);
  assert.equal((await handler().post(request([event("unselected", "follow")]))).status, 404);
  await dispatchLinePush(req, t, env);
  assert.equal(t.calls.length, 0); await assertFallback(req, "line_guard");
  assert.deepEqual((await db.query("SELECT id,line_user_id FROM contacts ORDER BY id")).rows, before);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_webhook_events")).rows[0].n, 0);
});
async function writeSnapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [...newTables, "public.deliveries", "public.audit_log", "app.b028_delivery_attempts", "app.b028_delivery_attempt_events"])
    result[table] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t`)).rows[0].rows;
  return result;
}
for (const key of ["line_platform", "line_push"]) for (const [name, setting, flag] of offCases)
  test(`${key} ${name} OFF: zero writes including audits, budgets, Email and expiry`, async () => {
    const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
    await reserve(req);
    await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second'");
    if (setting === undefined) await db.query("DELETE FROM platform_settings WHERE key=$1", [key]);
    else await db.query("UPDATE platform_settings SET value=$2 WHERE key=$1", [key, JSON.stringify(setting)]);
    await db.query("UPDATE organizations SET feature_flags=jsonb_set(feature_flags,ARRAY[$1],$2) WHERE id=$3", [key, JSON.stringify(flag), ORG_ID]);
    const before = await writeSnapshot();
    for (let i = 0; i < 2; i++) assert.deepEqual(await dispatchLinePush(req, t, env), { status: "skipped", reason: "line_guard" });
    assert.equal(await expireLinePushes(ORG_ID, env), 0);
    assert.equal(t.calls.length, 0); assert.deepEqual(await writeSnapshot(), before);
  });
for (const value of [undefined, "false", "TRUE", "", "invalid"]) test(`env OFF ${String(value)}: zero writes`, async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  await reserve(req); await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second'");
  const before = await writeSnapshot(), off = { ...env, LINE_PLATFORM_ENABLED: value };
  assert.deepEqual(await dispatchLinePush(req, t, off), { status: "skipped", reason: "line_guard" });
  assert.equal(await expireLinePushes(ORG_ID, off), 0);
  assert.equal(t.calls.length, 0); assert.deepEqual(await writeSnapshot(), before);
});
test("same-claim concurrent reservation does not double charge, including scope mismatch", async () => {
  const req = await fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () => reserve(req)));
  assert.ok(results.every(r => r.rowCount === 1));
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
  await assert.rejects(svc(null, c => c.query(reserveSql, [channel, req.claimId, ORG_ID, randomUUID(), 180])));
  assert.equal((await svc(null, c => c.query(reserveSql, [randomUUID(), req.claimId, ORG_ID, req.notificationId, 180]))).rowCount, 0);
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
});

// r2 regressions: use real transactions and independent connections, with local transports only.
for (const first of ["accepted", "failed", "timeout"] as const) test(`exclusive dispatch: ${first} owner versus competing mixed outcome`, async () => {
  const req = await fixture();
  let finish!: (outcome: PushOutcome) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const inFlight = dispatchLinePush(req, { push: () => { entered(); return new Promise(resolve => { finish = resolve; }); } }, env);
  await started;
  const other = createCapturedLineTransport({ mode: first === "failed" ? "accepted" : "failed" });
  assert.equal((await dispatchLinePush(req, other, env)).status, "busy");
  assert.equal(other.calls.length, 0);
  for (const fn of ["settle", "release", "unknown"]) assert.equal((await svc(null, c => c.query(
    `SELECT app.b033_push_${fn}($1,$2) AS done`, [req.claimId, randomUUID()]))).rows[0].done, false);
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
  finish({ status: first });
  assert.equal((await inFlight).status, first === "accepted" ? "accepted" : first === "failed" ? "skipped" : "unknown");
  assert.deepEqual(await counts(), { pushed_count: first === "accepted" ? 1 : 0, reserved_count: first === "timeout" ? 1 : 0 });
  const org = (await db.query("SELECT used,reserved FROM app.b033_org_push_budgets")).rows[0];
  assert.deepEqual(org, { used: first === "accepted" ? 1 : 0, reserved: first === "timeout" ? 1 : 0 });
});
test("accepted transport with rejected settlement cannot report accepted or write sent", async () => {
  const req = await fixture();
  const result = await dispatchLinePush(req, { async push() {
    await db.query("UPDATE app.b033_push_reservations SET owner_token=$2 WHERE claim_id=$1", [req.claimId, randomUUID()]);
    return { status: "accepted" };
  } }, env);
  assert.equal(result.status, "unknown");
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
  assert.equal((await db.query("SELECT count(*)::int n FROM deliveries WHERE notification_id=$1 AND status='sent'", [req.notificationId])).rows[0].n, 0);
});
test("start uses NOWAIT and cannot steal an independently locked reservation", async () => {
  const req = await fixture(); await reserve(req);
  const holder = await connect();
  try {
    await holder.query("BEGIN"); await holder.query("SELECT 1 FROM app.b033_push_reservations WHERE claim_id=$1 FOR UPDATE", [req.claimId]);
    assert.equal((await svc(null, c => c.query("SELECT app.b033_push_start($1,$2) state", [req.claimId, randomUUID()]))).rows[0].state, "busy");
  } finally { await holder.query("ROLLBACK"); await holder.end(); }
});
test("follow/unfollow audits persist whitelisted changes without LINE identifiers, refs or tokens", async () => {
  await fixture(); const { post } = handler();
  const before = (await db.query("SELECT coalesce(max(id),0) AS id FROM audit_log")).rows[0].id;
  await post(request([event("audit-unfollow", "unfollow", 1000)]));
  await post(request([event("audit-follow", "follow", 2000)]));
  const rows = (await db.query("SELECT old_row,new_row,changed_cols FROM audit_log WHERE table_name='line_account_links' AND id>$1 ORDER BY id", [before])).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.new_row.is_friend).sort(), [false, true]);
  assert.ok(rows.every(r => r.changed_cols.includes("is_friend")));
  await db.query("UPDATE line_channels SET messaging_channel_secret_ref='private-test-ref',line_provider_id='private-provider' WHERE id=$1", [channel]);
  const audit = JSON.stringify((await db.query("SELECT * FROM audit_log WHERE table_name IN ('line_account_links','line_channels')")).rows);
  for (const privateValue of [to, "line_user_id", "provider_user_hash", "line_provider_id", "messaging_channel_secret_ref", "private-test-ref", "private-provider", "local-reply-token", "audit-unfollow"])
    assert.ok(!audit.includes(privateValue), privateValue);
  assert.equal((await db.query(`SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relname LIKE 'b033_%' AND t.tgfoid='public.fn_audit()'::regprocedure`)).rows[0].n, 0);
});
for (const raw of ["", "0", "bad", "181", "200", "-1", "1.5"]) test(`invalid limit ${JSON.stringify(raw)}: zero transport, durable deduped fallback`, async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  for (let n = 0; n < 2; n++) await dispatchLinePush(req, t, { ...env, LINE_PUSH_MONTHLY_LIMIT: raw });
  assert.equal(t.calls.length, 0); await assertFallback(req, "line_guard");
  assert.equal((await db.query("SELECT count(*)::int n FROM line_push_usage")).rows[0].n, 0);
});
test("SQL rejects NULL, zero and above-ceiling limits without reserving either budget", async () => {
  const req = await fixture();
  for (const limit of [null, 0, 181, 200]) await assert.rejects(svc(null, c => c.query(reserveSql, [channel, req.claimId, ORG_ID, req.notificationId, limit])));
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_push_reservations")).rows[0].n, 0);
  assert.equal((await db.query("SELECT reserved FROM app.b033_org_push_budgets")).rows[0].reserved, 0);
});
for (const change of ["tenant_config_verified_at=NULL", "liff_id_tenant=NULL"]) test(`unverified configuration ${change} fails closed`, async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  await db.query(`UPDATE line_channels SET ${change} WHERE id=$1`, [channel]);
  await dispatchLinePush(req, t, env); assert.equal(t.calls.length, 0); await assertFallback(req, "line_guard");
});
for (const state of ["missing", "zero", "used", "reserved"]) test(`org budget ${state}: line_budget and one Email fallback`, async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  if (state === "missing") await db.query("DELETE FROM app.b033_org_push_budgets");
  else if (state === "zero") await budget(0);
  else await db.query(`UPDATE app.b033_org_push_budgets SET ${state}=budget`);
  await dispatchLinePush(req, t, env); await dispatchLinePush(req, t, env);
  assert.equal(t.calls.length, 0); await assertFallback(req, "line_budget");
  assert.equal((await db.query("SELECT count(*)::int n FROM line_push_usage")).rows[0].n, 0);
});
test("org budget contention admits one reservation and rolls back channel/org together", async () => {
  const req = await fixture(); await budget(1);
  const results = await Promise.all(Array.from({ length: 5 }, () => reserve({ ...req, claimId: randomUUID() })));
  assert.equal(results.filter(r => r.rows[0].status === "reserved").length, 1);
  assert.equal(results.filter(r => r.rows[0].status === "line_budget").length, 4);
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
  assert.deepEqual((await db.query("SELECT used,reserved FROM app.b033_org_push_budgets")).rows[0], { used: 0, reserved: 1 });
});
test("budget writes require service gateway; client execution and direct service writes denied", async () => {
  const req = await fixture();
  await assert.rejects(svc(null, c => c.query("UPDATE app.b033_org_push_budgets SET budget=180")));
  const c = await connect();
  try {
    for (const role of ["anon", "authenticated"]) {
      await c.query(`SET ROLE ${role}`);
      await assert.rejects(c.query("SELECT app.b033_org_budget_set($1,$2,current_date,180)", [channel, req.orgId]));
      await c.query("RESET ROLE");
    }
  } finally { await c.end(); }
});
test("hanging transport is bounded, records unknown; retries cap at three with stable key", async () => {
  const req = await fixture(); let calls = 0;
  const started = Date.now();
  const result = await dispatchLinePush(req, { push: () => { calls++; return new Promise(() => {}); } }, env, { timeoutMs: 20 });
  assert.equal(result.status, "unknown"); assert.ok(Date.now() - started < 2000);
  const t = createCapturedLineTransport({ mode: "timeout" });
  for (let i = 0; i < 5; i++) assert.equal((await dispatchLinePush(req, t, env)).status, "unknown");
  assert.equal(calls + t.calls.length, 3);
  for (const call of t.calls) if (call.method === "push") assert.equal(call.request.headers["X-Line-Retry-Key"], req.claimId);
  const row = (await db.query("SELECT status,has_unknown,attempt_count,started_at,completed_at,notification_deadline,retry_until FROM app.b033_push_reservations")).rows[0];
  assert.equal(row.status, "unknown"); assert.equal(row.has_unknown, true); assert.equal(row.attempt_count, 3);
  assert.ok(row.started_at && row.completed_at && row.retry_until > row.notification_deadline);
  assert.equal((await db.query("SELECT error FROM deliveries WHERE notification_id=$1 AND channel='line'", [req.notificationId])).rows[0].error, "line_unknown");
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
});
for (const deadline of ["notification_deadline", "retry_until"]) test(`${deadline} expiry prevents retries and dedupes possible duplicate-channel fallback`, async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "timeout" });
  await dispatchLinePush(req, t, env);
  await db.query(`UPDATE app.b033_push_reservations SET ${deadline}=now()-interval '1 second'`);
  await Promise.all([expireLinePushes(ORG_ID, env), expireLinePushes(ORG_ID, env)]);
  await dispatchLinePush(req, t, env); await dispatchLinePush(req, t, env);
  assert.equal(t.calls.length, 1);
  const row = (await db.query("SELECT status,fallback_claim_id FROM app.b033_push_reservations")).rows[0];
  assert.equal(row.status, "expired"); assert.ok(row.fallback_claim_id);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1", [req.notificationId])).rows[0].n, 1);
  assert.deepEqual((await db.query("SELECT channel,status,error FROM deliveries WHERE notification_id=$1 ORDER BY channel", [req.notificationId])).rows,
    [{ channel: "email", status: "queued", error: "line_unknown_possible_duplicate" }, { channel: "line", status: "failed", error: "line_unknown_possible_duplicate" }]);
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
  assert.equal((await db.query("SELECT reserved FROM app.b033_org_push_budgets")).rows[0].reserved, 1);
});
test("Email worker sweeps an abandoned in-flight claim without another LINE request", async () => {
  const req = await fixture(); await reserve(req);
  const owner = randomUUID(); await svc(null, c => c.query("SELECT app.b033_push_start($1,$2)", [req.claimId, owner]));
  await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second'");
  const email = createCaptureAdapter("email");
  const old = process.env.LINE_PLATFORM_ENABLED; process.env.LINE_PLATFORM_ENABLED = "true";
  try {
  assert.equal(await runDeliveryAttempts(ORG_ID, email, 10), 1);
  assert.equal(await runDeliveryAttempts(ORG_ID, email, 10), 0);
  assert.equal(email.captures.length, 1);
  } finally { if (old === undefined) delete process.env.LINE_PLATFORM_ENABLED; else process.env.LINE_PLATFORM_ENABLED = old; }
  assert.equal((await svc(null, c => c.query("SELECT app.b033_push_settle($1,$2) done", [req.claimId, owner]))).rows[0].done, false);
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
});
for (const [name, setting, flag] of offCases) test(`B-028 ${name}: fallback_unavailable with zero LINE or Email writes`, async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  if (setting === undefined) await db.query("DELETE FROM platform_settings WHERE key='notification_delivery_v2'");
  else await db.query("UPDATE platform_settings SET value=$1 WHERE key='notification_delivery_v2'", [JSON.stringify(setting)]);
  await db.query("UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{notification_delivery_v2}',$1) WHERE id=$2", [JSON.stringify(flag), ORG_ID]);
  assert.equal((await svc(null, c => c.query("SELECT app.b033_push_enabled($1) enabled", [ORG_ID]))).rows[0].enabled, false);
  for (let i = 0; i < 2; i++) assert.equal((await dispatchLinePush(req, t, env)).status, "fallback_unavailable");
  assert.equal(t.calls.length, 0);
  for (const table of ["line_push_usage", "app.b033_push_reservations", "app.b028_delivery_attempts"])
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM deliveries WHERE notification_id=$1", [req.notificationId])).rows[0].n, 0);
});
test("exported POST resolves refs lazily: valid, invalid, missing signature, duplicate and missing secrets", async () => {
  await fixture();
  const oldEnabled = process.env.LINE_PLATFORM_ENABLED, oldSecrets = process.env.LINE_CHANNEL_SECRETS;
  try {
    process.env.LINE_PLATFORM_ENABLED = "true";
    for (const value of [undefined, "invalid", "{}", JSON.stringify({ "vault://demo/line/secret": { secret } })]) {
      if (value === undefined) delete process.env.LINE_CHANNEL_SECRETS; else process.env.LINE_CHANNEL_SECRETS = value;
      assert.equal((await POST(request([event("missing-secret", "unfollow")]))).status, 503);
      assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_webhook_events")).rows[0].n, 0);
    }
    process.env.LINE_CHANNEL_SECRETS = JSON.stringify({ "vault://demo/line/secret": { secret, identityPepper: pepper, destination } });
    const missing = request([event("missing-signature", "unfollow")]); missing.headers.delete("x-line-signature");
    assert.equal((await POST(missing)).status, 401);
    assert.equal((await POST(request([event("bad-signature", "unfollow")], { signature: "wrong" }))).status, 401);
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_webhook_events")).rows[0].n, 0);
    assert.equal((await POST(request([event("exported-valid", "unfollow")]))).status, 200);
    assert.equal((await POST(request([event("exported-valid", "unfollow")]))).status, 200);
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_webhook_events")).rows[0].n, 1);
    assert.equal((await db.query("SELECT friend_state FROM app.b033_line_identities")).rows[0].friend_state, false);
  } finally {
    if (oldEnabled === undefined) delete process.env.LINE_PLATFORM_ENABLED; else process.env.LINE_PLATFORM_ENABLED = oldEnabled;
    if (oldSecrets === undefined) delete process.env.LINE_CHANNEL_SECRETS; else process.env.LINE_CHANNEL_SECRETS = oldSecrets;
  }
});

test("abandoned owner becomes unknown; replacement failure and stale completion cannot free quota", async () => {
  const req = await fixture(); await reserve(req);
  const oldOwner = randomUUID(), newOwner = randomUUID();
  await svc(null, c => c.query("SELECT app.b033_push_start($1,$2)", [req.claimId, oldOwner]));
  await db.query("UPDATE app.b033_push_reservations SET started_at=now()-interval '16 seconds'");
  assert.equal((await svc(null, c => c.query("SELECT app.b033_push_start($1,$2) state", [req.claimId, newOwner]))).rows[0].state, "dispatching");
  for (const [fn, owner] of [["settle", oldOwner], ["release", oldOwner], ["release", newOwner]])
    assert.equal((await svc(null, c => c.query(`SELECT app.b033_push_${fn}($1,$2) done`, [req.claimId, owner]))).rows[0].done, false);
  assert.equal((await svc(null, c => c.query("SELECT app.b033_push_unknown($1,$2) done", [req.claimId, newOwner]))).rows[0].done, true);
  assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
  assert.deepEqual((await db.query("SELECT used,reserved FROM app.b033_org_push_budgets")).rows[0], { used: 0, reserved: 1 });
});

// Round 3: trusted configuration, terminal channel choice and transaction fault injection.
test("authenticated admin cannot forge verification on INSERT/UPDATE or call its gateway; service direct stamp is denied", async () => {
  const fields = "org_id,mode,display_name,line_provider_id,messaging_channel_id,messaging_channel_secret_ref,messaging_access_token_ref,is_active";
  const values = "$1,'org_owned','local','provider-demo',$2,'ref:s','ref:t',false";
  const admin = <T>(fn: (c: Client) => Promise<T>) => tx(USERS.admin, fn, { orgId: ORG_ID, environment: "live" });
  const ch = (await admin(c => c.query(`INSERT INTO line_channels(${fields}) VALUES(${values}) RETURNING id`, [ORG_ID, randomUUID()]))).rows[0].id;
  for (const role of ["authenticated", "service_role"]) {
    const run = role === "authenticated" ? admin : <T>(fn: (c: Client) => Promise<T>) => svc(null, fn);
    await assert.rejects(run(c => c.query("UPDATE line_channels SET tenant_config_verified_at=now() WHERE id=$1", [ch])));
  }
  await assert.rejects(admin(c => c.query(`INSERT INTO line_channels(${fields},tenant_config_verified_at) VALUES(${values},now())`, [ORG_ID, randomUUID()])));
  await assert.rejects(admin(c => c.query("SELECT app.b033_channel_verify($1)", [ch])));
  await svc(null, c => c.query("SELECT app.b033_channel_verify($1)", [ch]));
  assert.ok((await db.query("SELECT tenant_config_verified_at FROM line_channels WHERE id=$1", [ch])).rows[0].tenant_config_verified_at);
  for (const field of ["liff_id_tenant", "liff_id_owner", "liff_id_vendor", "line_provider_id", "messaging_channel_id", "messaging_channel_secret_ref", "messaging_access_token_ref", "login_channel_id", "login_channel_secret_ref", "liff_app_id", "webhook_url"]) {
    await svc(null, c => c.query("SELECT app.b033_channel_verify($1)", [ch]));
    if (["liff_id_tenant", "liff_id_owner", "liff_id_vendor"].includes(field)) {
      await assert.rejects(admin(c => c.query(`UPDATE line_channels SET ${field}=$2 WHERE id=$1`, [ch, `local-${randomUUID()}`])));
      const values = ["liff_id_tenant", "liff_id_vendor", "liff_id_owner"].map(key => key === field ? `local-${randomUUID()}` : null);
      await svc(null, c => c.query("SELECT app.b033_liff_configure($1,$2,$3,$4)", [ch, ...values]));
    } else {
      await admin(c => c.query(`UPDATE line_channels SET ${field}=$2 WHERE id=$1`, [ch, `local-${randomUUID()}`]));
    }
    assert.equal((await db.query("SELECT tenant_config_verified_at FROM line_channels WHERE id=$1", [ch])).rows[0].tenant_config_verified_at, null, field);
  }
});
test("settled replay ignores changed guard and identity without any writes or Email", async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  assert.equal((await dispatchLinePush(req, t, env)).status, "accepted");
  const before = await writeSnapshot();
  assert.equal((await dispatchLinePush({ ...req, to: "invalid" }, t, { ...env, LINE_PUSH_QUOTA_GUARD: "false" })).status, "accepted");
  assert.equal(t.calls.length, 1); assert.deepEqual(await writeSnapshot(), before);
});
for (const cause of ["guard", "quota", "budget"]) test(`${cause} fallback is terminal after recovery and concurrent replay`, async () => {
  const req = await fixture(), t = createCapturedLineTransport({ mode: "accepted" });
  if (cause === "quota") await usage(180);
  if (cause === "budget") await budget(0);
  const bad = cause === "guard" ? { ...env, LINE_PUSH_QUOTA_GUARD: "false" } : env;
  const results = await Promise.all(Array.from({ length: 4 }, () => dispatchLinePush(req, t, bad)));
  assert.ok(results.every(r => r.status === "skipped"));
  await budget(180); if (cause === "quota") await usage(0);
  const before = await writeSnapshot();
  assert.equal((await dispatchLinePush(req, t, env)).status, "skipped");
  assert.equal((await reserve(req)).rows[0].status, "fallback");
  assert.equal(t.calls.length, 0); assert.deepEqual(await writeSnapshot(), before);
  await assertFallback(req, `line_${cause}`);
});
test("unhealthy competing caller cannot enqueue Email while the owner dispatches", async () => {
  const req = await fixture(); let finish!: (o: PushOutcome) => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const inFlight = dispatchLinePush(req, { push() { entered(); return new Promise(r => { finish = r; }); } }, env);
  await started;
  const before = await writeSnapshot();
  assert.equal((await dispatchLinePush(req, createCapturedLineTransport({ mode: "failed" }), { ...env, LINE_PUSH_QUOTA_GUARD: "false" })).status, "busy");
  assert.deepEqual(await writeSnapshot(), before);
  finish({ status: "accepted" }); assert.equal((await inFlight).status, "accepted");
});
for (const table of ["app.b028_delivery_attempts", "public.deliveries"]) test(`failure fallback fault at ${table} rolls release back and remains recoverable`, async () => {
  const req = await fixture();
  await db.query(`CREATE FUNCTION public.b033_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF ${table === "public.deliveries" ? "NEW.channel='email'" : "true"} THEN RAISE EXCEPTION 'local injected fault'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER b033_test_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.b033_test_fail()`);
  try {
    await assert.rejects(dispatchLinePush(req, createCapturedLineTransport({ mode: "failed" }), env));
    const row = (await db.query("SELECT status,fallback_claim_id FROM app.b033_push_reservations WHERE claim_id=$1", [req.claimId])).rows[0];
    assert.deepEqual(row, { status: "dispatching", fallback_claim_id: null });
    assert.deepEqual(await counts(), { pushed_count: 0, reserved_count: 1 });
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_push_fallbacks")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1", [req.notificationId])).rows[0].n, 0);
  } finally { await db.query(`DROP TRIGGER b033_test_fail ON ${table}`); await db.query("DROP FUNCTION public.b033_test_fail()"); }
  await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second'");
  assert.equal(await expireLinePushes(ORG_ID, env), 1);
  assert.equal(await expireLinePushes(ORG_ID, env), 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1", [req.notificationId])).rows[0].n, 1);
});
test("LINE maintenance delivery contention is bounded, logged and retried while unrelated Email completes", async t => {
  const req = await fixture(); await dispatchLinePush(req, createCapturedLineTransport({ mode: "timeout" }), env);
  await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second'");
  const unrelated = randomUUID(); await enqueueDelivery(ORG_ID, "line_notification", unrelated, "contact:local", "email");
  const holder = await connect(), email = createCaptureAdapter("email");
  const errors: unknown[][] = []; t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  const old = process.env.LINE_PLATFORM_ENABLED; process.env.LINE_PLATFORM_ENABLED = "true";
  try {
    await holder.query("BEGIN"); await holder.query("SELECT 1 FROM deliveries WHERE notification_id=$1 FOR UPDATE", [req.notificationId]);
    const start = Date.now(); assert.equal(await runDeliveryAttempts(ORG_ID, email, 10), 1);
    assert.ok(Date.now() - start < 2500); assert.equal(email.captures[0].sourceId, unrelated);
    assert.deepEqual(errors.filter(e => e[0] === "b033_expiry_retry_pending"), [["b033_expiry_retry_pending", { code: "57014" }]]);
    assert.equal((await db.query("SELECT status FROM app.b033_push_reservations")).rows[0].status, "unknown");
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1", [req.notificationId])).rows[0].n, 0);
    await holder.query("ROLLBACK");
    assert.equal(await runDeliveryAttempts(ORG_ID, email, 10), 1);
    assert.equal(email.captures[1].sourceId, req.notificationId);
    assert.equal(await runDeliveryAttempts(ORG_ID, email, 10), 0);
  } finally {
    await holder.query("ROLLBACK"); await holder.end();
    if (old === undefined) delete process.env.LINE_PLATFORM_ENABLED; else process.env.LINE_PLATFORM_ENABLED = old;
  }
});
