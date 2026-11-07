import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { insertTestAuthSession } from "./test-auth-session";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { svc } from "./db";
import { addTicketComment, saveRepairRecord, type RepairInput } from "./repairs";
import { createCapturedLineTransport, type PushOutcome, type PushRequest } from "./line/transport";
import { providerUserHash } from "./line/webhook";
import { runLineRepairPushes, type RepairTargetResolver } from "./line/repair-push";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const env = { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" };
const pepper = "b038-local-pepper", TENANT_LIFF = "b038-tenant-liff", OWNER_LIFF = "b038-owner-liff";
const FLAGS = ["line_platform", "line_push", "notification_delivery_v2", "line_repair_push"] as const;
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
let channel: string, provider: string;
let ticket: string, tenantContact: string, ownerContact: string, ownerTicket: string;
let property: string, currency: string, minorUnit: number, ownership: string;
let admin: Session, managerSession: string, adminSession: string;
const targets = new Map<string, string>();
const resolveTarget: RepairTargetResolver = async ({ contactId }) => {
  const to = targets.get(contactId);
  return to ? { to, identityPepper: pepper } : null;
};
const TENANT_TO = `U${"1".repeat(32)}`, OWNER_TO = `U${"2".repeat(32)}`, OTHER_TO = `U${"3".repeat(32)}`;

function sha(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest(); }
function staff(userId: string, sessionId: string): Session {
  return { userId, sessionId, email: "staff@songxin.demo", name: "Staff", kind: "staff", role: "admin", orgId: ORG_ID,
    liveOrgId: ORG_ID, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
}
function repair(status: string, note = ""): RepairInput {
  return { status, note, internal: false, vendorName: "", estimated: "", finalCost: "", costBearer: "undecided",
    scheduledOn: "", completedOn: "", postExpense: false };
}
async function flag(key: string, value: unknown = true, orgs = [ORG_ID], org = ORG_ID) {
  await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [key, JSON.stringify({ enabled: value, allowed_org_ids: orgs })]);
  await db.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,$3::jsonb) WHERE id=$1",
    [org, key, JSON.stringify(value)]);
}
async function link(contact: string, user: string, persona: "tenant" | "owner", to: string) {
  await db.query(`UPDATE line_account_links SET status='unlinked',unlinked_at=now()
    WHERE contact_id=$1 AND line_channel_id=$2 AND status IN ('pending','linked')`, [contact, channel]);
  const identity = (await db.query(`INSERT INTO app.b033_line_identities(line_channel_id,provider_user_hash,user_id,persona,friend_state)
    VALUES($1,$2,$3,$4,true) RETURNING id`, [channel, providerUserHash(provider, to, pepper), user, persona])).rows[0].id;
  const org = (await db.query("SELECT org_id FROM contacts WHERE id=$1", [contact])).rows[0].org_id;
  await db.query(`INSERT INTO line_account_links(org_id,contact_id,line_channel_id,status,linked_at,is_friend,login_identity_id,
    identity_verified_at,notification_opt_in,consented_at,consent_text_key,persona)
    VALUES($1,$2,$3,'linked',now(),true,$4,now(),true,now(),'line.binding.v1',$5)`, [org, contact, channel, identity, persona]);
  targets.set(contact, to);
}
async function submit(ticketId: string, expected: string | null = null, amount = "500001") {
  const args = [ticketId, expected, amount, currency, minorUnit, "SCOPE-SECRET replace pipe", []];
  // B-028 package 4: session mutators bind the environment tuple and the request principal.
  return svc(USERS.manager, async c => (await c.query(`SELECT app.b013_submit_estimate($1::uuid,$2::uuid,$3::text,$4::uuid,
    $5::uuid,$6::uuid,$7::uuid,$8::bigint,$9::text,$10::smallint,$11::text,$12::jsonb,$13::bytea) r`,
  [ORG_ID, ORG_ID, "live", managerSession, randomUUID(), ...args.slice(0, 6), JSON.stringify(args[6]), sha(args)])).rows[0].r);
}
/** A real owner-visible ticket photo (private-bucket file + attachment) whose file name carries a secret marker. */
async function secretPhoto(ticketId: string) {
  const file = randomUUID(), attachment = randomUUID();
  await db.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)
    VALUES($1::uuid,$2::uuid,'ticket-photos-private','org/'||$2::uuid::text||'/tickets/'||$3::uuid::text||'/'||$1::uuid::text||'.jpg',
    'PHOTO-SECRET.jpg','image/jpeg',1024,$4)`, [file, ORG_ID, ticketId, USERS.admin]);
  await db.query("INSERT INTO ticket_attachments(id,org_id,ticket_id,file_id) VALUES($1,$2,$3,$4)", [attachment, ORG_ID, ticketId, file]);
  return attachment;
}
async function emergency(version: string) {
  const ticketId = (await db.query("SELECT ticket_id FROM app.b013_estimate_versions WHERE id=$1", [version])).rows[0].ticket_id;
  const photoId = await secretPhoto(ticketId);
  const photos = [{ id: photoId }], args = [version, "water", "EMERGENCY-REASON-SECRET", photos];
  const r = await svc(USERS.admin, async c => (await c.query(`SELECT app.b013_authorize_emergency($1::uuid,$2::uuid,$3::text,$4::uuid,
    $5::uuid,$6::uuid,$7::text,$8::text,$9::jsonb,$10::bytea) r`, [ORG_ID, ORG_ID, "live", adminSession, randomUUID(), version,
    "water", "EMERGENCY-REASON-SECRET", JSON.stringify(photos), sha(args)])).rows[0].r);
  return { ...r, photoId };
}
function transport(mode: PushOutcome["status"] = "accepted") { return createCapturedLineTransport({ mode }); }
function pushes(t: ReturnType<typeof transport>) {
  return t.calls.flatMap(c => c.method === "push" ? [c.request] : []);
}
async function run(t = transport(), options: { env?: Record<string, string | undefined>; org?: string } = {}) {
  return runLineRepairPushes(options.org ?? ORG_ID, { transport: t, resolveTarget, env: options.env ?? env });
}
async function rows(sql: string, values: unknown[] = []) { return (await db.query(sql, values)).rows; }
async function n(sql: string, values: unknown[] = []) { return Number((await db.query(sql, values)).rows[0].n); }
async function usage(pushed: number) {
  await db.query(`INSERT INTO line_push_usage(line_channel_id,period_month,pushed_count)
    VALUES($1,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,$2)
    ON CONFLICT(line_channel_id,period_month) DO UPDATE SET pushed_count=$2`, [channel, pushed]);
}
const WRITE_TABLES = ["public.notifications", "public.deliveries", "app.b038_repair_pushes", "app.b038_repair_cursors",
  "app.b033_push_reservations", "app.b033_push_fallbacks", "app.b028_delivery_attempts", "app.b028_delivery_attempt_events",
  "public.line_push_usage", "app.b033_quota_alerts", "app.b033_org_push_budgets", "public.audit_log"];
async function snapshot() {
  const out: Record<string, string> = {};
  for (const table of WRITE_TABLES) out[table] = (await db.query(
    `SELECT count(*)::text||':'||md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS s FROM ${table} t`)).rows[0].s;
  return out;
}
async function deliveries(notification: string) {
  return rows(`SELECT channel::text,status::text,error,counts_toward_quota FROM deliveries WHERE notification_id=$1
    AND b033_claim_id IS NOT NULL ORDER BY channel`, [notification]);
}
async function only(kind: string) {
  const found = await rows("SELECT notification_id::text AS id FROM app.b038_repair_pushes WHERE source_kind=$1", [kind]);
  assert.equal(found.length, 1); return found[0].id as string;
}
async function taipeiToday() {
  return (await db.query("SELECT (now() AT TIME ZONE timezone)::date::text d FROM organizations WHERE id=$1", [ORG_ID])).rows[0].d;
}

test.before(async () => {
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("network disabled in B-038 tests"); }) as typeof fetch;
  clone = await cloneTestDatabase(); db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
test.beforeEach(async () => {
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true"; process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
  targets.clear();
  for (const key of FLAGS) await flag(key);
  await flag("repair_approvals");
  const ch = (await db.query("SELECT id,line_provider_id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0];
  channel = ch.id; provider = ch.line_provider_id;
  await db.query("UPDATE line_channels SET liff_id_tenant=$2,liff_id_owner=$3 WHERE id=$1", [channel, TENANT_LIFF, OWNER_LIFF]);
  await svc(null, c => c.query("SELECT app.b033_channel_verify($1)", [channel]));
  await svc(null, c => c.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)", [channel, ORG_ID]));
  // Tenant: seeded request #1001 reported by the lease tenant.
  const t = (await db.query("SELECT id,reported_by_contact_id FROM maintenance_tickets WHERE org_id=$1 AND ticket_number=1001", [ORG_ID])).rows[0];
  ticket = t.id; tenantContact = t.reported_by_contact_id;
  await link(tenantContact, USERS.tenant2, "tenant", TENANT_TO);
  // Owner: the designated owner of one property with a 500000 threshold.
  const po = (await db.query(`SELECT po.id,po.property_id,c.id contact,p.currency::text currency,r.minor_unit
    FROM property_owners po JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
    JOIN properties p ON p.org_id=po.org_id AND p.id=po.property_id JOIN organizations o ON o.id=po.org_id
    JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
    WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND c.archived_at IS NULL AND p.archived_at IS NULL ORDER BY po.id LIMIT 1`,
  [ORG_ID, USERS.owner])).rows[0];
  property = po.property_id; ownership = po.id; ownerContact = po.contact; currency = po.currency.trim(); minorUnit = po.minor_unit;
  await db.query(`UPDATE property_owners SET effective_from=least(effective_from,CURRENT_DATE-2),effective_to=CURRENT_DATE-1
    WHERE org_id=$1 AND property_id=$2 AND id<>$3`, [ORG_ID, property, ownership]);
  await db.query("UPDATE property_owners SET repair_approval_threshold_minor=500000,effective_from=CURRENT_DATE-2,effective_to=NULL WHERE id=$1", [ownership]);
  ownerTicket = randomUUID();
  await db.query(`INSERT INTO maintenance_tickets(id,org_id,ticket_number,property_id,category,priority,status,title,description,cost_bearer)
    VALUES($1,$2,2001,$3,'plumbing','normal','open','TITLE-SECRET leak','DESCRIPTION-SECRET','undecided')`, [ownerTicket, ORG_ID, property]);
  await link(ownerContact, USERS.owner, "owner", OWNER_TO);
  managerSession = await insertTestAuthSession(db, USERS.manager);
  adminSession = await insertTestAuthSession(db, USERS.admin);
  admin = staff(USERS.admin, adminSession);
});
test.after(async () => {
  globalThis.fetch = originalFetch;
  try { await db?.end(); } finally { await clone?.cleanup(); }
  assert.equal(fetchCalls, 0, "no network call was attempted");
});

test("private tables: RLS on, no direct grants or policies; definer gateways pinned and service-only", async () => {
  for (const table of ["b038_repair_pushes", "b038_repair_cursors"]) {
    const row = (await db.query(`SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname='app' AND c.relname=$1`, [table])).rows[0];
    assert.equal(row.relrowsecurity, true);
    assert.equal(await n("SELECT count(*) n FROM pg_policies WHERE schemaname='app' AND tablename=$1", [table]), 0);
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await db.query(`SELECT has_table_privilege($1,$2,'SELECT') OR has_table_privilege($1,$2,'INSERT')
        OR has_table_privilege($1,$2,'UPDATE') OR has_table_privilege($1,$2,'DELETE') a`, [role, `app.${table}`])).rows[0].a, false);
    }
  }
  const fns = await rows(`SELECT p.proname,p.prosecdef,p.proconfig,has_function_privilege('service_role',p.oid,'EXECUTE') svc,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') auth
    FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='app' AND p.proname LIKE 'b038_%'`);
  const gateways = ["b038_repair_enabled", "b038_repair_enqueue", "b038_repair_claim", "b038_repair_context", "b038_repair_authorize",
    "b038_repair_withhold", "b038_repair_complete"];
  assert.equal(fns.length, 12);
  for (const f of fns) {
    assert.equal(f.prosecdef, true, f.proname);
    assert.ok((f.proconfig as string[]).includes("search_path=pg_catalog, public, app, pg_temp"), f.proname);
    assert.equal(f.anon, false); assert.equal(f.auth, false);
    assert.equal(f.svc, gateways.includes(f.proname), f.proname);
  }
  assert.equal((await db.query("SELECT value FROM platform_settings WHERE key='line_repair_push'")).rows[0].value.enabled, true);
});

test("tenant-visible repair change: tenant receives only the authorized summary and LIFF deep link", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress", "PUBLIC-NOTE-visible"));
  await addTicketComment(admin, ticket, "INTERNAL-SECRET note", true);
  await db.query(`INSERT INTO ticket_comments(org_id,ticket_id,author_user_id,body,is_internal,status_from,status_to)
    VALUES($1,$2,$3,'INTERNAL-STATUS-SECRET',true,'in_progress','on_hold')`, [ORG_ID, ticket, USERS.admin]);
  const zhang = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND is_tenant AND id<>$2 AND user_id IS NOT NULL ORDER BY id LIMIT 1", [ORG_ID, tenantContact])).rows[0].id;
  await link(zhang, (await db.query("SELECT user_id FROM contacts WHERE id=$1", [zhang])).rows[0].user_id, "tenant", OTHER_TO);
  const t = transport(), result = await run(t);
  assert.equal(result.enqueued, 1);
  const sent = pushes(t);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, TENANT_TO);
  assert.deepEqual(sent[0].messages, [{ type: "text",
    text: `修繕進度更新：報修單 #1001 目前為「處理中」。請登入查看詳情：https://liff.line.me/${TENANT_LIFF}?org=${ORG_ID}` }]);
  const raw = JSON.stringify(sent);
  for (const secret of ["PUBLIC-NOTE", "INTERNAL", "浴室水龍頭滲水", "洗手台", pepper, "token", "session", "photo", "storage", USERS.tenant2])
    assert.equal(raw.includes(secret), false, secret);
  const id = await only("ticket_status");
  assert.deepEqual((await db.query("SELECT payload,event_type,template_key FROM notifications WHERE id=$1", [id])).rows[0],
    { payload: { kind: "ticket_status" }, event_type: "b038_repair", template_key: "line_repair.ticket_status" });
  assert.deepEqual(await deliveries(id), [{ channel: "line", status: "sent", error: null, counts_toward_quota: true }]);
  assert.equal((await db.query("SELECT outcome FROM app.b038_repair_pushes WHERE notification_id=$1", [id])).rows[0].outcome, "accepted");
  // English recipients get the English summary.
  await db.query("UPDATE contacts SET locale='en' WHERE id=$1", [tenantContact]);
  await saveRepairRecord(admin, ticket, repair("resolved"));
  const en = transport(); await run(en);
  assert.equal(pushes(en).length, 1);
  assert.equal(pushes(en)[0].messages[0].text, `Repair update: request #1001 is now "Done". Sign in to view details: https://liff.line.me/${TENANT_LIFF}?org=${ORG_ID}`);
});

test("owner approval: recipient selection checks current designated property authority", async () => {
  const other = (await db.query(`SELECT c.id,c.user_id FROM contacts c WHERE c.org_id=$1 AND c.is_owner AND c.id<>$2 AND c.user_id IS NOT NULL ORDER BY c.id LIMIT 1`,
    [ORG_ID, ownerContact])).rows[0];
  if (other) await link(other.id, other.user_id, "owner", OTHER_TO);
  const first = await submit(ownerTicket);
  assert.equal(first.state, "pending_approval");
  const t = transport(); await run(t);
  assert.deepEqual(pushes(t).map(p => p.to), [OWNER_TO]);
  assert.equal(pushes(t)[0].messages[0].text,
    `修繕估價待您決定：報修單 #2001（第 1 版估價）。請登入查看並決定：https://liff.line.me/${OWNER_LIFF}?org=${ORG_ID}`);
  for (const secret of ["SCOPE-SECRET", "TITLE-SECRET", "DESCRIPTION-SECRET", "500001", "5,000", pepper])
    assert.equal(JSON.stringify(pushes(t)).includes(secret), false, secret);
  // Ownership ended today (exclusive end date) before selection: the new version selects nobody.
  const second = await submit(ownerTicket, first.version_id);
  await db.query("UPDATE property_owners SET effective_to=$2::date WHERE id=$1", [ownership, await taipeiToday()]);
  const ended = transport(), result = await run(ended);
  assert.equal(result.enqueued, 0); assert.equal(pushes(ended).length, 0);
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE version_id=$1", [second.version_id]), 0);
  // Restored authority (still within the activation window) selects the designated owner again.
  await db.query("UPDATE property_owners SET effective_to=NULL WHERE id=$1", [ownership]);
  const restored = transport(); await run(restored);
  assert.deepEqual(pushes(restored).map(p => p.to), [OWNER_TO]);
  assert.match(pushes(restored)[0].messages[0].text, /第 2 版估價/);
  // Staff/admins and non-designated owners never receive approval pushes.
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE persona='owner' AND recipient_contact_id<>$1", [ownerContact]), 0);
});

test("emergency owner notice omits reason and photos; superseded approvals close without LINE or Email", async () => {
  const v = await submit(ownerTicket);
  const e = await emergency(v.version_id);
  assert.equal(e.status, "recorded");
  const t = transport(); await run(t);
  // The request is superseded by the emergency authorization; only the emergency notice is sent.
  const texts = pushes(t).map(p => p.messages[0].text);
  assert.deepEqual(texts, [`緊急修繕通知：報修單 #2001 已依緊急例外安排處理。請登入查看詳情：https://liff.line.me/${OWNER_LIFF}?org=${ORG_ID}`]);
  for (const secret of ["EMERGENCY-REASON", "PHOTO-SECRET", "water", e.photoId]) assert.equal(JSON.stringify(pushes(t)).includes(secret), false);
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE source_kind='approval_requested'"), 0);
  // A queued request that becomes stale before dispatch closes as superseded with no delivery.
  const ticket2 = randomUUID();
  await db.query(`INSERT INTO maintenance_tickets(id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer)
    VALUES($1,$2,2002,$3,'plumbing','normal','open','B038 second','undecided')`, [ticket2, ORG_ID, property]);
  const v2 = await submit(ticket2);
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0].n), 1);
  assert.equal((await emergency(v2.version_id)).status, "recorded");
  const stale = transport(); await run(stale);
  assert.equal(pushes(stale).filter(p => p.messages[0].text.includes("待您決定")).length, 0);
  const id = (await rows("SELECT notification_id::text id,outcome,reason FROM app.b038_repair_pushes WHERE version_id=$1 AND source_kind='approval_requested'", [v2.version_id]))[0];
  assert.equal(id.outcome, "superseded"); assert.equal(id.reason, "repair_superseded");
  assert.deepEqual(await deliveries(id.id), []);
});

test("event replay and version change: dedupe blocks same-version duplicates, new versions still notify", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const v1 = await submit(ownerTicket);
  const t = transport();
  await run(t); await run(t); await run(t);
  assert.equal(pushes(t).length, 2);
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0].n), 0);
  // Replaying a settled claim (e.g. a crashed worker re-queues it) never pushes the same version twice.
  await db.query("UPDATE app.b038_repair_pushes SET state='queued',outcome=NULL,reason=NULL,completed_at=NULL");
  const replay = transport(); const replayed = await run(replay);
  assert.equal(pushes(replay).length, 0);
  assert.deepEqual(replayed.results.map(r => r.status), ["accepted", "accepted"]);
  assert.deepEqual(await n("SELECT pushed_count n FROM line_push_usage WHERE line_channel_id=$1", [channel]), 2);
  // New tenant status version and a new reminder event each notify once.
  await saveRepairRecord(admin, ticket, repair("on_hold"));
  assert.equal((await svc(null, async c => (await c.query("SELECT app.b013_emit_reminder($1,$2,now()+interval '25 hours') r", [ORG_ID, v1.version_id])).rows[0].r)).status, "recorded");
  const next = transport(); await run(next); await run(next);
  assert.deepEqual(pushes(next).map(p => p.messages[0].text).sort(), [
    `修繕進度更新：報修單 #1001 目前為「暫停」。請登入查看詳情：https://liff.line.me/${TENANT_LIFF}?org=${ORG_ID}`,
    `提醒：報修單 #2001 的修繕估價（第 1 版）仍待您決定。請登入查看：https://liff.line.me/${OWNER_LIFF}?org=${ORG_ID}`,
  ].sort());
  // A new estimate version is a new event; the superseded v1 request is never re-sent.
  const v2 = await submit(ownerTicket, v1.version_id);
  const version = transport(); await run(version); await run(version);
  assert.deepEqual(pushes(version).map(p => p.messages[0].text),
    [`修繕估價待您決定：報修單 #2001（第 2 版估價）。請登入查看並決定：https://liff.line.me/${OWNER_LIFF}?org=${ORG_ID}`]);
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE version_id=$1", [v2.version_id]), 1);
  assert.equal(await n("SELECT count(*) n FROM notifications WHERE event_type='b038_repair'"), 5);
  assert.equal(await n("SELECT count(DISTINCT claim_id) n FROM app.b038_repair_pushes"), 5);
  assert.equal(await n("SELECT pushed_count n FROM line_push_usage WHERE line_channel_id=$1", [channel]), 5);
});

test("reminder for the current undecided version notifies once", async () => {
  const v1 = await submit(ownerTicket);
  const first = transport(); await run(first);
  assert.equal(pushes(first).length, 1);
  await svc(null, c => c.query("SELECT app.b013_emit_reminder($1,$2,now()+interval '25 hours')", [ORG_ID, v1.version_id]));
  await svc(null, c => c.query("SELECT app.b013_emit_reminder($1,$2,now()+interval '26 hours')", [ORG_ID, v1.version_id]));
  const t = transport(); await run(t); await run(t);
  assert.deepEqual(pushes(t).map(p => p.messages[0].text),
    [`提醒：報修單 #2001 的修繕估價（第 1 版）仍待您決定。請登入查看：https://liff.line.me/${OWNER_LIFF}?org=${ORG_ID}`]);
});

test("revoked authority at worker time withholds the payload and records one deduplicated Email fallback", async () => {
  await submit(ownerTicket);
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0].n), 2);
  await db.query("UPDATE property_owners SET effective_to=$2::date WHERE id=$1", [ownership, await taipeiToday()]);
  const lease = (await db.query("SELECT lease_id FROM maintenance_tickets WHERE id=$1", [ticket])).rows[0].lease_id;
  await db.query("DELETE FROM lease_parties WHERE lease_id=$1 AND contact_id=$2", [lease, tenantContact]);
  const t = transport(), result = await run(t);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(result.results.map(r => [r.status, r.reason]),
    [["skipped", "repair_authority_revoked"], ["skipped", "repair_authority_revoked"]]);
  for (const kind of ["approval_requested", "ticket_status"]) {
    const id = await only(kind);
    assert.deepEqual(await deliveries(id), [
      { channel: "email", status: "queued", error: "repair_authority_revoked", counts_toward_quota: false },
      { channel: "line", status: "skipped", error: "repair_authority_revoked", counts_toward_quota: false }]);
    assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'", [id]), 1);
    assert.deepEqual((await db.query("SELECT payload FROM notifications WHERE id=$1", [id])).rows[0].payload, { kind });
    assert.deepEqual((await rows("SELECT state,outcome,reason FROM app.b038_repair_pushes WHERE notification_id=$1", [id]))[0],
      { state: "done", outcome: "withheld", reason: "repair_authority_revoked" });
  }
  await db.query("UPDATE app.b038_repair_pushes SET state='queued',outcome=NULL,reason=NULL,completed_at=NULL");
  await run(t);
  assert.equal(t.calls.length, 0);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE channel='email'"), 2);
  assert.equal(await n("SELECT count(*) n FROM app.b033_push_reservations"), 0);
});

test("quota exhaustion and guard failures withhold the push with deduplicated Email fallback reasons", async () => {
  await usage(180);
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const t = transport(); await run(t); await run(t);
  assert.equal(t.calls.length, 0);
  const quota = await only("ticket_status");
  assert.deepEqual(await deliveries(quota), [
    { channel: "email", status: "queued", error: "line_quota", counts_toward_quota: false },
    { channel: "line", status: "skipped", error: "line_quota", counts_toward_quota: false }]);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE source_id=$1", [quota]), 1);
  assert.equal((await rows("SELECT outcome,reason FROM app.b038_repair_pushes WHERE notification_id=$1", [quota]))[0].reason, "line_quota");
  // Guard not ready and an unresolvable/mismatched recipient both fail closed as line_guard.
  await usage(0);
  await submit(ownerTicket);
  const guard = transport(); await run(guard, { env: { LINE_PLATFORM_ENABLED: "true" } });
  assert.equal(guard.calls.length, 0);
  assert.equal((await deliveries(await only("approval_requested")))[0].error, "line_guard");
  targets.set(tenantContact, `U${"9".repeat(32)}`);
  await saveRepairRecord(admin, ticket, repair("on_hold"));
  const mismatch = transport(); await run(mismatch);
  assert.equal(mismatch.calls.length, 0);
  assert.equal(await n("SELECT count(*) n FROM deliveries WHERE channel='email' AND error='line_guard'"), 2);
});

test("global kill: env OFF, line_push OFF or line_platform OFF sends no new LINE push and writes nothing", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  await submit(ownerTicket);
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0].n), 2);
  const kills: Array<[string, () => Promise<void>, Record<string, string | undefined>]> = [
    ["env unset", async () => {}, { LINE_PUSH_QUOTA_GUARD: "true" }],
    ["env false", async () => {}, { LINE_PLATFORM_ENABLED: "false", LINE_PUSH_QUOTA_GUARD: "true" }],
    ["line_push platform", () => flag("line_push", false), env],
    ["line_push org", async () => { await flag("line_push"); await db.query("UPDATE organizations SET feature_flags=feature_flags||'{\"line_push\":false}' WHERE id=$1", [ORG_ID]); }, env],
    ["line_platform", async () => { await flag("line_push"); await flag("line_platform", false); }, env],
  ];
  for (const [name, apply, killEnv] of kills) {
    await apply();
    const before = await snapshot(), t = transport();
    await run(t, { env: killEnv });
    assert.equal(t.calls.length, 0, name);
    assert.deepEqual(await snapshot(), before, name);
  }
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE state='queued'"), 2);
  // Kill between claim and dispatch: the gateways return no summary and record nothing.
  await flag("line_platform");
  const claim = (await svc(null, async c => (await c.query("SELECT * FROM app.b038_repair_claim($1,1,60)", [ORG_ID])).rows))[0];
  await flag("line_push", false);
  const ctx = (await svc(null, async c => (await c.query("SELECT * FROM app.b038_repair_context($1,$2,$3)", [ORG_ID, claim.notification_id, claim.token])).rows))[0];
  assert.equal(ctx.authority, "disabled"); assert.equal(ctx.liff_id, null); assert.equal(ctx.ticket_number, null);
  const w = (await svc(null, async c => (await c.query("SELECT * FROM app.b038_repair_withhold($1,$2,$3,'repair_authority_revoked')", [ORG_ID, claim.notification_id, claim.token])).rows))[0];
  assert.equal(w.state, "disabled");
  assert.equal(await n("SELECT count(*) n FROM deliveries WHERE b033_claim_id IS NOT NULL"), 0);
});

test("OFF matrix: each missing/malformed flag writes nothing and leaves repair flows unchanged", async () => {
  const cases: Array<[string, () => Promise<void>]> = [
    ["line_repair_push platform", () => flag("line_repair_push", false)],
    ["line_repair_push malformed", () => flag("line_repair_push", "true")],
    ["line_repair_push org", async () => { await flag("line_repair_push"); await db.query("UPDATE organizations SET feature_flags=feature_flags-'line_repair_push' WHERE id=$1", [ORG_ID]); }],
    ["line_repair_push allowlist", async () => { await flag("line_repair_push", true, [ORG2_ID]); }],
    ["notification_delivery_v2", async () => { await flag("line_repair_push"); await flag("notification_delivery_v2", false); }],
    ["missing setting", async () => { await flag("notification_delivery_v2"); await db.query("DELETE FROM platform_settings WHERE key='line_repair_push'"); }],
  ];
  let status = "in_progress";
  for (const [name, apply] of cases) {
    await apply();
    status = status === "in_progress" ? "on_hold" : "in_progress";
    await saveRepairRecord(admin, ticket, repair(status, `note ${name}`));
    const estimate = await submit(ownerTicket, (await db.query("SELECT current_version_id FROM app.b013_estimate_heads WHERE ticket_id=$1", [ownerTicket])).rows[0]?.current_version_id ?? null);
    assert.equal(estimate.status, "recorded", name);
    assert.equal((await db.query("SELECT status::text FROM maintenance_tickets WHERE id=$1", [ticket])).rows[0].status, status, name);
    const before = await snapshot(), t = transport();
    await run(t);
    assert.equal(t.calls.length, 0, name);
    assert.deepEqual(await snapshot(), before, name);
  }
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes"), 0);
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_cursors"), 0);
  // No trigger anywhere routes into B-038: existing repair transactions are untouched.
  assert.equal(await n(`SELECT count(*) n FROM pg_trigger tg JOIN pg_proc p ON p.oid=tg.tgfoid WHERE p.prosrc ILIKE '%b038%'`), 0);
});

test("cross-org and foreign scope: other org events, pinned foreign context and foreign claims are refused", async () => {
  for (const key of FLAGS) await flag(key, true, [ORG_ID, ORG2_ID], ORG2_ID);
  for (const key of FLAGS) await flag(key, true, [ORG_ID, ORG2_ID]);
  const coast = (await db.query(`SELECT l.id lease,l.property_id,lp.contact_id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id
    WHERE l.org_id=$1 ORDER BY l.id LIMIT 1`, [ORG2_ID])).rows[0];
  const foreignTicket = randomUUID();
  await db.query(`INSERT INTO maintenance_tickets(id,org_id,ticket_number,property_id,lease_id,category,priority,status,title,reported_by_contact_id,cost_bearer)
    VALUES($1,$2,9001,$3,$4,'plumbing','normal','open','Foreign',$5,'undecided')`, [foreignTicket, ORG2_ID, coast.property_id, coast.lease, coast.contact_id]);
  await db.query(`INSERT INTO ticket_comments(org_id,ticket_id,author_user_id,is_internal,status_from,status_to)
    VALUES($1,$2,$3,false,'open','in_progress')`, [ORG2_ID, foreignTicket, USERS.coastAdmin]);
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const t = transport(); const result = await run(t);
  assert.equal(result.enqueued, 1);
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE org_id=$1", [ORG2_ID]), 0);
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE ticket_id=$1", [foreignTicket]), 0);
  // A pinned foreign org context disables the gateways for the requested org.
  const pinned = await svc(null, async c => {
    await c.query("SELECT set_config('app.active_org_id',$1,true)", [ORG2_ID]);
    return (await c.query("SELECT app.b038_repair_enabled($1) e, app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0];
  });
  assert.deepEqual(pinned, { e: false, n: 0 });
  // A claim token is bound to its own organization and notification.
  await saveRepairRecord(admin, ticket, repair("on_hold"));
  await svc(null, c => c.query("SELECT app.b038_repair_enqueue($1)", [ORG_ID]));
  const claim = (await svc(null, async c => (await c.query("SELECT * FROM app.b038_repair_claim($1,1,60)", [ORG_ID])).rows))[0];
  await assert.rejects(svc(null, c => c.query("SELECT * FROM app.b038_repair_context($1,$2,$3)", [ORG2_ID, claim.notification_id, claim.token])));
  await assert.rejects(svc(null, c => c.query("SELECT * FROM app.b038_repair_context($1,$2,$3)", [ORG_ID, claim.notification_id, "0".repeat(64)])));
  await assert.rejects(svc(null, c => c.query("SELECT app.b038_repair_complete($1,$2,$3,'accepted',NULL)", [ORG2_ID, claim.notification_id, claim.token])));
  assert.equal((await svc(null, async c => (await c.query("SELECT * FROM app.b038_repair_claim($1,5,60)", [ORG2_ID])).rows)).length, 0);
  for (const role of ["anon", "authenticated"]) {
    const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    try {
      await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(c.query("SELECT app.b038_repair_enqueue($1)", [ORG_ID]), { code: "42501" });
    } finally { await c.query("ROLLBACK"); await c.end(); }
  }
});

test("concurrent workers claim each notification once; one push per recipient version", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  await saveRepairRecord(admin, ticket, repair("on_hold"));
  await submit(ownerTicket);
  const a = transport(), b = transport();
  await Promise.all([run(a), run(b), run(a)]);
  const all = [...pushes(a), ...pushes(b)];
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map(p => p.headers["X-Line-Retry-Key"])).size, 3);
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE outcome='accepted'"), 3);
  assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0],
    { pushed_count: 3, reserved_count: 0 });
});

test("provider timeout keeps the same claim and retry key; no duplicate on later acceptance", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const slow = transport("timeout"); await run(slow);
  assert.equal(pushes(slow).length, 1);
  assert.equal((await rows("SELECT state FROM app.b038_repair_pushes"))[0].state, "queued");
  const ok = transport("duplicateAccepted"); await run(ok); await run(ok);
  assert.equal(pushes(ok).length, 1);
  assert.equal(pushes(ok)[0].headers["X-Line-Retry-Key"], pushes(slow)[0].headers["X-Line-Retry-Key"]);
  assert.equal((await rows("SELECT outcome FROM app.b038_repair_pushes"))[0].outcome, "accepted");
  assert.equal(fetchCalls, 0);
});

test("authority revoked between the context check and dispatch: no push, one Email fallback with the reason", async () => {
  await submit(ownerTicket);
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const lease = (await db.query("SELECT lease_id FROM maintenance_tickets WHERE id=$1", [ticket])).rows[0].lease_id;
  const today = await taipeiToday();
  let barrier = 0;
  const t = transport();
  // Barrier: revoke exactly the authority of the row that already passed the context check.
  const revoke = async (notification: string) => {
    barrier++;
    const { persona } = (await db.query("SELECT persona FROM app.b038_repair_pushes WHERE notification_id=$1", [notification])).rows[0];
    if (persona === "owner") await db.query("UPDATE property_owners SET effective_to=$2::date WHERE id=$1", [ownership, today]);
    else await db.query("DELETE FROM lease_parties WHERE lease_id=$1 AND contact_id=$2", [lease, tenantContact]);
  };
  const result = await runLineRepairPushes(ORG_ID, { transport: t, resolveTarget, env, beforeDispatch: revoke });
  assert.equal(barrier, 2);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(result.results.map(r => [r.status, r.reason]),
    [["skipped", "repair_authority_revoked"], ["skipped", "repair_authority_revoked"]]);
  for (const kind of ["approval_requested", "ticket_status"]) {
    const id = await only(kind);
    assert.deepEqual(await deliveries(id), [
      { channel: "email", status: "queued", error: "repair_authority_revoked", counts_toward_quota: false },
      { channel: "line", status: "skipped", error: "repair_authority_revoked", counts_toward_quota: false }]);
    assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'", [id]), 1);
    assert.deepEqual((await rows("SELECT outcome,reason FROM app.b038_repair_pushes WHERE notification_id=$1", [id]))[0],
      { outcome: "fallback", reason: "repair_authority_revoked" });
  }
  assert.equal(await n("SELECT count(*) n FROM app.b033_push_reservations"), 0);
  await run(t);
  assert.equal(t.calls.length, 0);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE channel='email'"), 2);
});

test("a stuck row never starves later rows; past the SLA rows close with one deduplicated Email fallback", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  await submit(ownerTicket);
  const ticket2 = randomUUID();
  await db.query(`INSERT INTO maintenance_tickets(id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer)
    VALUES($1,$2,2002,$3,'plumbing','normal','open','B038 second','undecided')`, [ticket2, ORG_ID, property]);
  await submit(ticket2);
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0].n), 3);
  await db.query("UPDATE app.b038_repair_pushes SET created_at=created_at-interval '1 minute' WHERE persona='tenant'");
  const calls: PushRequest[] = [];
  const stuck = { async push(req: PushRequest): Promise<PushOutcome> {
    calls.push(req); return { status: req.to === TENANT_TO ? "timeout" : "accepted" };
  } };
  await runLineRepairPushes(ORG_ID, { transport: stuck, resolveTarget, env });
  assert.deepEqual(calls.map(c => c.to).sort(), [OWNER_TO, OWNER_TO, TENANT_TO].sort());
  assert.equal(await n("SELECT count(*) n FROM app.b038_repair_pushes WHERE outcome='accepted'"), 2);
  const tenantRow = await only("ticket_status");
  assert.equal((await rows("SELECT state FROM app.b038_repair_pushes WHERE notification_id=$1", [tenantRow]))[0].state, "queued");
  // Past the five-minute SLA the uncertain row closes with exactly one possible-duplicate Email.
  await db.query("UPDATE app.b038_repair_pushes SET created_at=now()-interval '6 minutes' WHERE notification_id=$1", [tenantRow]);
  await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second' WHERE notification_id=$1", [tenantRow]);
  const later = transport(); await run(later); await run(later);
  assert.equal(later.calls.length, 0);
  assert.deepEqual((await rows("SELECT state,outcome,reason FROM app.b038_repair_pushes WHERE notification_id=$1", [tenantRow]))[0],
    { state: "done", outcome: "fallback", reason: "line_unknown_possible_duplicate" });
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'", [tenantRow]), 1);
  // A row that was never attempted before the SLA closes as repair_push_expired (no reservation).
  await saveRepairRecord(admin, ticket, repair("on_hold"));
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0].n), 1);
  await db.query("UPDATE app.b038_repair_pushes SET created_at=now()-interval '6 minutes' WHERE state='queued'");
  const aged = transport(); await run(aged); await run(aged);
  assert.equal(aged.calls.length, 0);
  const agedRow = (await rows("SELECT notification_id::text id,outcome,reason FROM app.b038_repair_pushes WHERE reason='repair_push_expired'"))[0];
  assert.equal(agedRow.outcome, "fallback");
  assert.deepEqual(await deliveries(agedRow.id), [
    { channel: "email", status: "queued", error: "repair_push_expired", counts_toward_quota: false },
    { channel: "line", status: "skipped", error: "repair_push_expired", counts_toward_quota: false }]);
});

test("no selected LINE channel: payload withheld, LINE skipped and one Email fallback recorded", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  await db.query("UPDATE line_channels SET is_active=false");
  const t = transport(); await run(t); await run(t);
  assert.equal(t.calls.length, 0);
  const id = await only("ticket_status");
  assert.deepEqual(await deliveries(id), [
    { channel: "email", status: "queued", error: "line_unavailable", counts_toward_quota: false },
    { channel: "line", status: "skipped", error: "line_unavailable", counts_toward_quota: false }]);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'", [id]), 1);
  assert.deepEqual((await rows("SELECT state,outcome FROM app.b038_repair_pushes WHERE notification_id=$1", [id]))[0],
    { state: "done", outcome: "withheld" });
});

test("re-enable after an OFF gap does not push stale events from the gap", async () => {
  await run(transport());
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  await db.query("UPDATE ticket_comments SET created_at=now()-interval '20 minutes' WHERE ticket_id=$1 AND status_to='in_progress'", [ticket]);
  // Simulate the flag being OFF (no scans) for an hour.
  await db.query("UPDATE app.b038_repair_cursors SET scanned_at=now()-interval '1 hour',started_at=now()-interval '2 hours'");
  await saveRepairRecord(admin, ticket, repair("on_hold"));
  const t = transport(); await run(t);
  assert.deepEqual(pushes(t).map(p => p.messages[0].text),
    [`修繕進度更新：報修單 #1001 目前為「暫停」。請登入查看詳情：https://liff.line.me/${TENANT_LIFF}?org=${ORG_ID}`]);
  // Continuous operation (no gap) still covers events inside the window.
  await db.query("UPDATE app.b038_repair_cursors SET started_at=now()-interval '2 hours'");
  await saveRepairRecord(admin, ticket, repair("resolved"));
  await db.query("UPDATE ticket_comments SET created_at=now()-interval '30 minutes' WHERE ticket_id=$1 AND status_to='resolved'", [ticket]);
  const recent = transport(); await run(recent);
  assert.ok(pushes(recent).some(p => p.messages[0].text.includes("「已完成」")));
});

test("past-SLA close rechecks first: superseded closes silently, revoked uses its reason, current expires to Email", async () => {
  const v1 = await submit(ownerTicket);
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const ticket2 = randomUUID();
  await db.query(`INSERT INTO maintenance_tickets(id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer)
    VALUES($1,$2,2002,$3,'plumbing','normal','open','B038 second','undecided')`, [ticket2, ORG_ID, property]);
  await submit(ticket2);
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0].n), 3);
  await submit(ownerTicket, v1.version_id); // supersedes v1
  const lease = (await db.query("SELECT lease_id FROM maintenance_tickets WHERE id=$1", [ticket])).rows[0].lease_id;
  await db.query("DELETE FROM lease_parties WHERE lease_id=$1 AND contact_id=$2", [lease, tenantContact]);
  await db.query("UPDATE app.b038_repair_pushes SET created_at=now()-interval '6 minutes'");
  const t = transport(); await run(t);
  assert.deepEqual(pushes(t).map(p => p.messages[0].text),
    [`修繕估價待您決定：報修單 #2001（第 2 版估價）。請登入查看並決定：https://liff.line.me/${OWNER_LIFF}?org=${ORG_ID}`]);
  const superseded = (await rows("SELECT notification_id::text id,state,outcome,reason FROM app.b038_repair_pushes WHERE version_id=$1", [v1.version_id]))[0];
  assert.deepEqual({ ...superseded, id: undefined }, { id: undefined, state: "done", outcome: "superseded", reason: "repair_superseded" });
  assert.deepEqual(await deliveries(superseded.id), []);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE source_id=$1", [superseded.id]), 0);
  const revoked = await only("ticket_status");
  assert.deepEqual((await rows("SELECT outcome,reason FROM app.b038_repair_pushes WHERE notification_id=$1", [revoked]))[0],
    { outcome: "withheld", reason: "repair_authority_revoked" });
  assert.equal((await deliveries(revoked))[0].error, "repair_authority_revoked");
  const expired = (await rows(`SELECT p.notification_id::text id,p.outcome FROM app.b038_repair_pushes p
    JOIN app.b013_estimate_versions v ON v.id=p.version_id WHERE v.ticket_id=$1`, [ticket2]))[0];
  assert.equal(expired.outcome, "fallback");
  assert.deepEqual((await deliveries(expired.id)).map(d => [d.channel, d.error]),
    [["email", "repair_push_expired"], ["line", "repair_push_expired"]]);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE channel='email'"), 2);
});

test("a failing past-SLA row is isolated and backed off; the good row behind it is still processed", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  assert.equal(await svc(null, async c => (await c.query("SELECT app.b038_repair_enqueue($1) n", [ORG_ID])).rows[0].n), 1);
  const bad = await only("ticket_status");
  const claim = (await db.query("SELECT claim_id FROM app.b038_repair_pushes WHERE notification_id=$1", [bad])).rows[0].claim_id;
  const other = (await db.query("SELECT id FROM notifications WHERE org_id=$1 AND id<>$2 LIMIT 1", [ORG_ID, bad])).rows[0].id;
  // Synthetic fault: a terminal B-033 fallback pinned to a different notification => scope mismatch raise.
  await db.query(`INSERT INTO app.b033_push_fallbacks(claim_id,org_id,notification_id,line_channel_id,reason,email_claim_id)
    VALUES($1,$2,$3,$4,'line_guard',$5)`, [claim, ORG_ID, other, channel, randomUUID()]);
  await db.query("UPDATE app.b038_repair_pushes SET created_at=now()-interval '6 minutes' WHERE notification_id=$1", [bad]);
  await submit(ownerTicket);
  const t = transport(); await run(t);
  assert.deepEqual(pushes(t).map(p => p.to), [OWNER_TO]);
  const row = (await rows("SELECT state,outcome,reason,attempts,retry_after>now() backed_off FROM app.b038_repair_pushes WHERE notification_id=$1", [bad]))[0];
  assert.deepEqual(row, { state: "queued", outcome: null, reason: "repair_fallback_error", attempts: 0, backed_off: true });
  assert.deepEqual(await deliveries(bad), []);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts WHERE source_id=$1", [bad]), 0);
  const again = transport(); await run(again);
  assert.equal(again.calls.length, 0);
  assert.equal((await rows("SELECT reason FROM app.b038_repair_pushes WHERE notification_id=$1", [bad]))[0].reason, "repair_fallback_error");
});

test("a past-SLA row still owned by B-033 (busy) backs off instead of refilling the claim window", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const slow = transport("timeout"); await run(slow);
  assert.equal(slow.calls.length, 1);
  const id = await only("ticket_status");
  assert.equal((await rows("SELECT status FROM app.b033_push_reservations WHERE notification_id=$1", [id]))[0].status, "unknown");
  await db.query("UPDATE app.b038_repair_pushes SET created_at=now()-interval '6 minutes' WHERE notification_id=$1", [id]);
  const claimed = await svc(null, async c => (await c.query("SELECT * FROM app.b038_repair_claim($1,5,120)", [ORG_ID])).rows);
  assert.equal(claimed.length, 0);
  const before = (await rows("SELECT state,outcome,attempts,retry_after>now() backed_off,retry_after::text ra FROM app.b038_repair_pushes WHERE notification_id=$1", [id]))[0];
  assert.deepEqual({ state: before.state, outcome: before.outcome, backed_off: before.backed_off }, { state: "queued", outcome: null, backed_off: true });
  await svc(null, c => c.query("SELECT * FROM app.b038_repair_claim($1,5,120)", [ORG_ID]));
  const after = (await rows("SELECT attempts,retry_after::text ra FROM app.b038_repair_pushes WHERE notification_id=$1", [id]))[0];
  assert.deepEqual(after, { attempts: before.attempts, ra: before.ra });
  assert.equal(await n("SELECT count(*) n FROM deliveries WHERE notification_id=$1 AND channel='email'", [id]), 0);
});

test("authorize lock contention defers without writes or Email; the row is pushed once the lock is released", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const t = transport();
  // An in-flight repair save holds the ticket FOR UPDATE; an ordinary contact UPDATE holds FOR NO KEY UPDATE.
  for (const [sql, value] of [["SELECT 1 FROM maintenance_tickets WHERE id=$1 FOR UPDATE", ticket],
    ["SELECT 1 FROM contacts WHERE id=$1 FOR NO KEY UPDATE", tenantContact]]) {
    const holder = new Client({ connectionString: process.env.DATABASE_URL }); await holder.connect();
    try {
      await holder.query("BEGIN"); await holder.query(sql, [value]);
      const result = await run(t);
      assert.deepEqual(result.results.map(r => r.status), ["deferred"], sql);
    } finally { await holder.query("ROLLBACK"); await holder.end(); }
  }
  assert.equal(t.calls.length, 0);
  const id = await only("ticket_status");
  assert.equal((await rows("SELECT state FROM app.b038_repair_pushes WHERE notification_id=$1", [id]))[0].state, "queued");
  assert.deepEqual(await deliveries(id), []);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts"), 0);
  assert.equal(await n("SELECT count(*) n FROM app.b033_push_reservations"), 0);
  await run(t);
  assert.equal(pushes(t).length, 1);
});

test("an authorize failure other than lock contention sends neither LINE nor Email and keeps the row for a later run", async () => {
  await saveRepairRecord(admin, ticket, repair("in_progress"));
  const t = transport();
  const original = (await db.query("SELECT pg_get_functiondef('app.b038_tenant_authorized(uuid,uuid,uuid)'::regprocedure) def")).rows[0].def;
  // Synthetic non-lock failure inside the dispatch-time re-authorization only (e.g. a statement timeout):
  // swapped in after enqueue and the context check, right before dispatch.
  const fail = async () => { await db.query(`CREATE OR REPLACE FUNCTION app.b038_tenant_authorized(p_org uuid, p_ticket uuid, p_contact uuid) RETURNS boolean
    LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$BEGIN RAISE EXCEPTION 'synthetic authorize failure' USING ERRCODE='57014'; END$$`); };
  try {
    const result = await runLineRepairPushes(ORG_ID, { transport: t, resolveTarget, env, beforeDispatch: fail });
    assert.deepEqual(result.results.map(r => r.status), ["unknown"]);
  } finally { await db.query(original); }
  assert.equal(t.calls.length, 0);
  const id = await only("ticket_status");
  assert.equal((await rows("SELECT state FROM app.b038_repair_pushes WHERE notification_id=$1", [id]))[0].state, "queued");
  assert.deepEqual(await deliveries(id), []);
  assert.equal(await n("SELECT count(*) n FROM app.b028_delivery_attempts"), 0);
  assert.equal(await n("SELECT count(*) n FROM app.b033_push_fallbacks"), 0);
  await run(t);
  assert.equal(pushes(t).length, 1);
});
