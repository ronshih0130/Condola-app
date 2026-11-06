import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { svc } from "./db";
import { providerUserHash } from "./line/webhook";
import { createCapturedLineTransport, type PushOutcome, type PushRequest } from "./line/transport";
import { dispatchLinePush, expireLinePushes } from "./line/quota";
import { claimRentPushes, dispatchRentPush, lineRentPushStatus, runLineRentPushes, type LineRecipientResolver } from "./line/rent-pushes";
import { lineRentPushStatusLabel } from "@/i18n/line-rent-push";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const pepper = "local-b037-pepper", env = { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" };
const FLAGS = ["line_platform", "line_push", "notification_delivery_v2", "line_rent_push", "rent_reminders_v2", "payment_results_v2"];
const SNAPSHOT = ["notifications", "deliveries", "audit_log", "email_log", "line_push_usage", "app.b037_rent_push_claims", "app.b033_push_reservations",
 "app.b033_push_fallbacks", "app.b033_quota_alerts", "app.b037_event_marks", "app.b033_org_push_budgets", "app.b028_delivery_attempts", "app.b028_delivery_attempt_events",
 "app.b028_recipient_claims", "app.b010_source_events", "app.b010_tenant_due_preferences"];
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client, channel: string;
let rent: { contact: string; user: string; lease: string; invoice: string; due: string };
let pay: { contact: string; user: string; lease: string; payment: string };
const subs = new Map<string, string>();
let fetchCalls = 0;
// Local evidence for e2e/results/B-037 (written only when B037_WRITE_EVIDENCE=1). No LINE addresses.
const evidence: { payloads: Record<string, Record<string, string>>; quota: Record<string, unknown>; concurrency: Record<string, unknown>; off: unknown[]; emails: unknown[] } =
 { payloads: {}, quota: {}, concurrency: {}, off: [], emails: [] };
const originalFetch = globalThis.fetch;

const resolver: LineRecipientResolver = async ({ linkId }) => {
 const to = subs.get(linkId); return to ? { to, identityPepper: pepper } : null;
};
function at(offset: number, hour = 4) { return new Date(Date.parse(`${rent.due}T${String(hour).padStart(2, "0")}:00:00Z`) + offset * 86_400_000); }
async function setFlag(key: string, value: unknown, orgs: Record<string, unknown> = { [ORG_ID]: true }) {
 await db.query("INSERT INTO platform_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, JSON.stringify(value)]);
 for (const [org, on] of Object.entries(orgs)) {
  await db.query("UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($2::text,$3::jsonb) WHERE id=$1", [org, key, JSON.stringify(on)]);
 }
}
async function enableAll(orgs = [ORG_ID]) {
 for (const key of FLAGS) await setFlag(key, { enabled: true, allowed_org_ids: orgs }, Object.fromEntries(orgs.map(o => [o, true])));
}
async function disableAll() {
 for (const key of FLAGS) await setFlag(key, { enabled: false, allowed_org_ids: [] }, { [ORG_ID]: false, [ORG2_ID]: false });
}
async function usage(pushed: number) {
 await db.query(`INSERT INTO line_push_usage(line_channel_id,period_month,pushed_count) VALUES($1,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,$2)
  ON CONFLICT(line_channel_id,period_month) DO UPDATE SET pushed_count=$2`, [channel, pushed]);
}
async function link(contact: string, user: string, options: { friend?: boolean; optIn?: boolean; org?: string } = {}) {
 const to = `U${randomBytes(16).toString("hex")}`;
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1", [contact]);
 const identity = (await db.query(`INSERT INTO app.b033_line_identities(line_channel_id,provider_user_hash,user_id,persona,friend_state)
  VALUES($1,$2,$3,'tenant',$4) RETURNING id`, [channel, providerUserHash("provider-demo", to, pepper), user, options.friend ?? true])).rows[0].id;
 const id = (await db.query(`INSERT INTO line_account_links(org_id,contact_id,line_channel_id,status,linked_at,is_friend,login_identity_id,
  identity_verified_at,notification_opt_in,consented_at,consent_text_key,persona) VALUES($1,$2,$3,'linked',now(),$4,$5,now(),$6,now(),'line.binding.v1','tenant') RETURNING id`,
 [options.org ?? ORG_ID, contact, channel, options.friend ?? true, identity, options.optIn ?? true])).rows[0].id;
 subs.set(id, to);
 return { id, to };
}
async function schedule(offset: number) {
 const id = await svc(null, async c => (await c.query<{ id: string | null }>("SELECT app.b010_schedule_rent($1,$2,$3)::text AS id",
  [ORG_ID, rent.invoice, at(offset).toISOString()])).rows[0].id);
 assert.ok(id, `B-010 event for offset ${offset}`);
 return id!;
}
async function paymentEvent(kind: "payment_confirmed" | "payment_rejected" | "payment_reversed", payment = pay.payment) {
 return (await db.query(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id) VALUES($1,$2,$3,$4,$4,$5) RETURNING id`,
  [ORG_ID, pay.lease, payment, kind, USERS.admin])).rows[0].id as string;
}
function capture(outcomes: PushOutcome["status"][] = ["accepted"], delayMs = 0) {
 const calls: PushRequest[] = [];
 return { calls, async push(request: PushRequest): Promise<PushOutcome> {
  calls.push(structuredClone(request));
  if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  return { status: outcomes[Math.min(calls.length - 1, outcomes.length - 1)] };
 } };
}
async function claims(event?: string) {
 return (await db.query(`SELECT claim_id::text,event_id::text,version,recipient_contact_id::text,reminder_offset,state,reason,notification_id::text
  FROM app.b037_rent_push_claims ${event ? "WHERE event_id=$1" : ""} ORDER BY created_at`, event ? [event] : [])).rows;
}
async function deliveriesOf(notification: string) {
 return (await db.query("SELECT channel::text,status::text,error,counts_toward_quota FROM deliveries WHERE notification_id=$1 ORDER BY channel", [notification])).rows;
}
async function emailAttempts(notification: string) {
 return (await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'", [notification])).rows[0].n as number;
}
async function b010Claims(event: string, contact: string) {
 return (await db.query("SELECT id::text FROM app.b028_recipient_claims WHERE event_id=$1 AND contact_id=$2 AND channel='email'", [event, contact])).rows as { id: string }[];
}
/** Every Email for one recipient and one occurrence, across the B-010 claim and the LINE fallback path. */
async function allEmails(event: string, contact: string, notification: string) {
 return (await b010Claims(event, contact)).length + await emailAttempts(notification);
}
async function owner(claimId: string) {
 return (await db.query("SELECT email_owner,email_claim_id::text FROM app.b037_rent_push_claims WHERE claim_id=$1", [claimId])).rows[0];
}
async function forceDeadline(claimId: string) {
 await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second' WHERE claim_id=$1", [claimId]);
}
async function rejectedPayment(amount = 5000) {
 await setFlag("payment_results_v2", { enabled: false, allowed_org_ids: [] });
 const id = (await db.query(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,rejected_reason)
  SELECT org_id,property_id,lease_id,payer_contact_id,currency,$2,paid_on,method,'rejected',source,'local reason' FROM payments WHERE id=$1 RETURNING id`, [pay.payment, amount])).rows[0].id as string;
 await setFlag("payment_results_v2", { enabled: true, allowed_org_ids: [ORG_ID] });
 return id;
}
async function reversePayment(payment = pay.payment) {
 await setFlag("payment_results_v2", { enabled: false, allowed_org_ids: [] });
 await db.query("UPDATE payments SET status='reversed' WHERE id=$1", [payment]);
 await setFlag("payment_results_v2", { enabled: true, allowed_org_ids: [ORG_ID] });
}
async function snapshot() {
 const out: Record<string, unknown> = {};
 for (const name of SNAPSHOT) out[name] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) d FROM ${name} t`)).rows[0].d;
 return out;
}
function assertLiffOnly(text: string, liffId = "local-tenant") {
 const urls = text.match(/https?:\/\/\S+/g) ?? [];
 assert.deepEqual(urls, [`https://liff.line.me/${liffId}?org=${ORG_ID}`]);
 assert.doesNotMatch(text, /token|flow=|invite|session|claim|contact_?id|password/i);
 for (const word of ["房東", "收款", "收租", "入帳", "已收", "統一編號"]) assert.equal(text.includes(word), false, word);
}

test.before(async () => {
 clone = await cloneTestDatabase(); db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
 globalThis.fetch = async () => { fetchCalls++; throw new Error("External HTTP forbidden in B-037 tests"); };
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
 subs.clear();
 await disableAll();
 channel = (await db.query("SELECT id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0].id;
 await db.query("SELECT app.b033_liff_configure($1,'local-tenant','local-vendor','local-owner')", [channel]);
 await db.query("SELECT app.b033_channel_verify($1)", [channel]);
 await db.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)", [channel, ORG_ID]);
 rent = (await db.query(`SELECT c.id contact,c.user_id::text "user",l.id::text lease,i.id::text invoice,i.due_date::text due FROM invoices i
  JOIN leases l ON l.id=i.lease_id JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' JOIN contacts c ON c.id=lp.contact_id
  WHERE i.org_id=$1 AND c.user_id=$2 AND l.status='active' AND i.status IN ('open','partially_paid') AND i.balance_minor>0 ORDER BY i.due_date LIMIT 1`,
 [ORG_ID, USERS.tenant2])).rows[0];
 pay = (await db.query(`SELECT p.payer_contact_id::text contact,c.user_id::text "user",p.lease_id::text lease,p.id::text payment FROM payments p
  JOIN contacts c ON c.id=p.payer_contact_id WHERE p.org_id=$1 AND c.user_id=$2 AND p.status='confirmed' LIMIT 1`, [ORG_ID, USERS.tenant])).rows[0];
 assert.ok(rent && pay);
});
test.after(async () => {
 globalThis.fetch = originalFetch;
 if (process.env.B037_WRITE_EVIDENCE === "1") {
  const dir = join(process.cwd(), "e2e/results/B-037"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "captured-payloads.json"), JSON.stringify(evidence.payloads, null, 1) + "\n");
  writeFileSync(join(dir, "quota-179-180-181.json"), JSON.stringify(evidence.quota, null, 1) + "\n");
  writeFileSync(join(dir, "concurrency.json"), JSON.stringify(evidence.concurrency, null, 1) + "\n");
  writeFileSync(join(dir, "off-matrix.json"), JSON.stringify(evidence.off, null, 1) + "\n");
  writeFileSync(join(dir, "single-email.json"), JSON.stringify(evidence.emails, null, 1) + "\n");
 }
 assert.equal(fetchCalls, 0, "no external network call");
 await db?.end(); await clone?.cleanup();
});

test("A1 committed unpaid rent_due event claims exactly one recipient/version/offset and pushes a LIFF-only reminder", async () => {
 await enableAll(); const l = await link(rent.contact, rent.user);
 // Uncommitted producer transactions are invisible, and cannot claim their own event.
 const open = new Client({ connectionString: process.env.DATABASE_URL }); await open.connect();
 try {
  await open.query("BEGIN");
  const pending = (await open.query("SELECT app.b010_schedule_rent($1,$2,$3)::text AS id", [ORG_ID, rent.invoice, at(0).toISOString()])).rows[0].id;
  assert.ok(pending);
  assert.equal(await claimRentPushes(at(0), env), 0);
  await assert.rejects(open.query("SELECT * FROM app.b037_claim($1,$2,$3)", [ORG_ID, pending, at(0).toISOString()]), (e: { code?: string }) => e.code === "55000");
  await open.query("ROLLBACK");
 } finally { await open.end(); }
 assert.equal((await claims()).length, 0);
 const event = await schedule(0);
 const both = await Promise.all([0, 1].map(() => svc(null, async c => (await c.query("SELECT claim_id::text FROM app.b037_claim($1,$2,$3)", [ORG_ID, event, at(0).toISOString()])).rows)));
 assert.deepEqual(both[0], both[1]);
 const rows = await claims(event);
 assert.equal(rows.length, 1);
 assert.deepEqual({ ...rows[0], claim_id: "", notification_id: "" }, { claim_id: "", event_id: event, version: 1, recipient_contact_id: rent.contact,
  reminder_offset: 0, state: "claimed", reason: null, notification_id: "" });
 const n = (await db.query("SELECT org_id::text,recipient_contact_id::text,lease_id::text,event_type,dedupe_key,payload FROM notifications WHERE id=$1", [rows[0].notification_id])).rows[0];
 assert.deepEqual(n, { org_id: ORG_ID, recipient_contact_id: rent.contact, lease_id: rent.lease, event_type: "rent_due",
  dedupe_key: `b037:${event}:v1:${rent.contact}:0`, payload: { source: "b037", version: 1, offset: 0 } });
 const transport = capture();
 const run = await runLineRentPushes(at(0), transport, resolver, env);
 assert.deepEqual(run.results.map(r => r.outcome), ["sent"]);
 assert.equal(transport.calls.length, 1);
 const call = transport.calls[0];
 assert.equal(call.to, l.to); assert.equal(call.headers["X-Line-Retry-Key"], rows[0].claim_id);
 assert.match(call.messages[0].text, /租金提醒/); assert.match(call.messages[0].text, /應繳日/);
 assertLiffOnly(call.messages[0].text);
 // Replays and a second worker run never claim or push the same occurrence again.
 const again = await runLineRentPushes(at(0), transport, resolver, env);
 assert.deepEqual([again.claimed, again.results.length, transport.calls.length], [0, 0, 1]);
 assert.equal((await claims(event))[0].state, "sent");
 // Offsets are separate occurrences (one claim per offset).
 const due3 = await schedule(-3);
 await runLineRentPushes(at(-3), transport, resolver, env);
 assert.deepEqual((await claims(due3)).map(r => [r.reminder_offset, r.state]), [[-3, "sent"]]);
 // The new address is transient: it is not persisted in claims, notifications or deliveries.
 const leaked = await db.query(`SELECT 1 FROM app.b037_rent_push_claims c JOIN notifications n ON n.id=c.notification_id
  LEFT JOIN deliveries d ON d.notification_id=n.id WHERE to_jsonb(c)::text LIKE $1 OR to_jsonb(n)::text LIKE $1 OR coalesce(to_jsonb(d)::text,'') LIKE $1`, [`%${l.to}%`]);
 assert.equal(leaked.rowCount, 0);
});

test("A1 payment results push from committed payment status; reversed/manual events are never pushed", async () => {
 await enableAll(); const l = await link(pay.contact, pay.user);
 await db.query("UPDATE contacts SET locale='en' WHERE id=$1", [pay.contact]);
 const confirmed = await paymentEvent("payment_confirmed");
 const reversed = await paymentEvent("payment_reversed");
 const transport = capture();
 const run = await runLineRentPushes(new Date(), transport, resolver, env);
 assert.deepEqual(run.results.map(r => r.outcome), ["sent"]);
 assert.equal((await claims(reversed)).length, 0);
 assert.deepEqual((await claims(confirmed)).map(r => [r.reminder_offset, r.state]), [[0, "sent"]]);
 assert.equal(transport.calls[0].to, l.to);
 assert.match(transport.calls[0].messages[0].text, /reconciled and confirmed/);
 assertLiffOnly(transport.calls[0].messages[0].text);
 // A rejected result follows its own committed status.
 const rejected = await paymentEvent("payment_rejected", await rejectedPayment());
 await runLineRentPushes(new Date(), transport, resolver, env);
 assert.deepEqual((await claims(rejected)).map(r => r.state), ["sent"]);
 assert.match(transport.calls[1].messages[0].text, /could not be reconciled/);
 assert.doesNotMatch(transport.calls[1].messages[0].text, /local reason/);
 assertLiffOnly(transport.calls[1].messages[0].text);
});

for (const scenario of ["paid", "terminated", "stale_day", "timezone_change", "recipient_lease", "payment_changed"] as const) {
 test(`A2 ${scenario}: reminder eligibility is re-evaluated at dispatch and the reminder is suppressed`, async () => {
  await enableAll();
  const isPayment = scenario === "payment_changed";
  await link(isPayment ? pay.contact : rent.contact, isPayment ? pay.user : rent.user);
  const event = isPayment ? await paymentEvent("payment_confirmed") : await schedule(0);
  const when = isPayment ? new Date() : at(0);
  assert.equal(await claimRentPushes(when, env), 1);
  const [claim] = await claims(event);
  if (scenario === "paid") await db.query("UPDATE invoices SET status='paid' WHERE id=$1", [rent.invoice]);
  if (scenario === "terminated") await db.query("UPDATE leases SET status='terminated',terminated_on=current_date WHERE id=$1", [rent.lease]);
  if (scenario === "timezone_change") await db.query("UPDATE organizations SET timezone='Pacific/Pago_Pago' WHERE id=$1", [ORG_ID]);
  if (scenario === "recipient_lease") await db.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [rent.contact]);
  if (scenario === "payment_changed") {
   await setFlag("payment_results_v2", { enabled: false, allowed_org_ids: [] });
   await db.query("UPDATE payments SET status='reversed' WHERE id=$1", [pay.payment]);
   await setFlag("payment_results_v2", { enabled: true, allowed_org_ids: [ORG_ID] });
  }
  const dispatchAt = scenario === "stale_day" ? at(1) : when;
  const transport = capture();
  const result = await dispatchRentPush(ORG_ID, claim.claim_id, dispatchAt, transport, resolver, env);
  const reason = { paid: "paid", terminated: "terminated", stale_day: "stale_day", timezone_change: "stale_day", recipient_lease: "recipient_lease", payment_changed: "payment_changed" }[scenario];
  assert.deepEqual(result, { claimId: claim.claim_id, outcome: "suppressed", reason });
  assert.equal(transport.calls.length, 0);
  assert.deepEqual(await deliveriesOf(claim.notification_id), []);
  assert.equal(await emailAttempts(claim.notification_id), 0);
  assert.equal((await db.query("SELECT status::text FROM notifications WHERE id=$1", [claim.notification_id])).rows[0].status, "cancelled");
  assert.equal((await lineRentPushStatus(ORG_ID, claim.notification_id)).status, "suppressed");
  assert.deepEqual((await runLineRentPushes(dispatchAt, transport, resolver, env)).results, []);
  assert.equal(transport.calls.length, 0);
 });
}

test("A2 an already paid or terminated lease is never claimed", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const event = await schedule(0);
 await db.query("UPDATE invoices SET status='paid' WHERE id=$1", [rent.invoice]);
 assert.equal(await claimRentPushes(at(0), env), 0);
 await db.query("UPDATE invoices SET status='open' WHERE id=$1", [rent.invoice]);
 await db.query("UPDATE leases SET status='terminated',terminated_on=current_date WHERE id=$1", [rent.lease]);
 assert.equal(await claimRentPushes(at(0), env), 0);
 assert.deepEqual(await claims(event), []);
 assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE dedupe_key LIKE 'b037:%'")).rows[0].n, 0);
});

for (const scenario of ["line_unlinked", "line_unfollowed", "line_opt_out", "line_quota", "line_guard"] as const) {
 test(`A3 ${scenario}: skipped LINE delivery records the reason against the single existing B-010 Email claim`, async () => {
  await enableAll();
  if (scenario !== "line_unlinked") {
   await link(rent.contact, rent.user, { friend: scenario !== "line_unfollowed" });
  }
  if (scenario === "line_opt_out") await db.query("UPDATE line_account_links SET notification_opt_in=false WHERE contact_id=$1", [rent.contact]);
  if (scenario === "line_quota") await usage(180);
  const runEnv = scenario === "line_guard" ? { LINE_PLATFORM_ENABLED: "true" } : env;
  const event = await schedule(0), transport = capture();
  for (let i = 0; i < 2; i++) await runLineRentPushes(at(0), transport, resolver, runEnv);
  const [claim] = await claims(event);
  const [b010] = await b010Claims(event, rent.contact);
  assert.ok(b010, "B-010 already holds this recipient's Email claim");
  assert.deepEqual({ state: claim.state, reason: claim.reason }, { state: "fallback", reason: scenario });
  assert.equal(transport.calls.length, 0);
  assert.deepEqual(await deliveriesOf(claim.notification_id), [{ channel: "line", status: "skipped", error: scenario, counts_toward_quota: false }]);
  assert.equal(await emailAttempts(claim.notification_id), 0);
  assert.equal(await allEmails(event, rent.contact, claim.notification_id), 1);
  assert.deepEqual(await owner(claim.claim_id), { email_owner: "b010_claim", email_claim_id: b010.id });
  assert.deepEqual((await db.query("SELECT email_claim_id::text,reason FROM app.b033_push_fallbacks WHERE claim_id=$1", [claim.claim_id])).rows, [{ email_claim_id: b010.id, reason: scenario }]);
  // A direct replay of the dispatcher creates no Email either.
  assert.equal((await dispatchRentPush(ORG_ID, claim.claim_id, at(0), transport, resolver, runEnv)).outcome, "fallback");
  assert.equal(await allEmails(event, rent.contact, claim.notification_id), 1);
  assert.deepEqual(await lineRentPushStatus(ORG_ID, claim.notification_id), { status: "email_fallback", label: "改以 Email 通知", reason: scenario });
  evidence.emails.push({ path: "rent_due with B-010 Email claim", reason: scenario, b010Claims: 1, lineFallbackEmails: 0, total: 1 });
  if (scenario === "line_quota") {
   assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0], { pushed_count: 180, reserved_count: 0 });
   assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_quota_alerts")).rows[0].n, 1);
  }
 });
}

for (const scenario of ["line_unlinked", "line_quota"] as const) {
 test(`A3 ${scenario} without a B-010 Email claim (payment result): exactly one deduplicated fallback Email with the reason`, async () => {
  await enableAll();
  if (scenario === "line_quota") { await link(pay.contact, pay.user); await usage(180); }
  const event = await paymentEvent("payment_confirmed"), transport = capture();
  for (let i = 0; i < 2; i++) await runLineRentPushes(new Date(), transport, resolver, env);
  const [claim] = await claims(event);
  assert.deepEqual(await b010Claims(event, pay.contact), []);
  assert.deepEqual({ state: claim.state, reason: claim.reason }, { state: "fallback", reason: scenario });
  assert.deepEqual(await deliveriesOf(claim.notification_id), [{ channel: "email", status: "queued", error: scenario, counts_toward_quota: false },
   { channel: "line", status: "skipped", error: scenario, counts_toward_quota: false }]);
  await dispatchRentPush(ORG_ID, claim.claim_id, new Date(), transport, resolver, env);
  assert.equal(await allEmails(event, pay.contact, claim.notification_id), 1);
  assert.equal((await owner(claim.claim_id)).email_owner, "line_fallback");
  assert.equal(transport.calls.length, 0);
  evidence.emails.push({ path: "payment result without B-010 Email claim", reason: scenario, b010Claims: 0, lineFallbackEmails: 1, total: 1 });
 });
}

for (const kind of ["rent", "payment"] as const) {
 test(`A3/A4 unknown LINE result expiring after the SLA never adds a second Email (${kind})`, async () => {
  await enableAll();
  const who = kind === "rent" ? rent : pay;
  await link(who.contact, who.user);
  const event = kind === "rent" ? await schedule(0) : await paymentEvent("payment_confirmed");
  const when = kind === "rent" ? at(0) : new Date();
  await runLineRentPushes(when, capture(["timeout"]), resolver, env, { timeoutMs: 50 });
  const [claim] = await claims(event);
  await forceDeadline(claim.claim_id);
  assert.equal(await expireLinePushes(ORG_ID, env), 1);
  const transport = capture();
  assert.deepEqual(await dispatchRentPush(ORG_ID, claim.claim_id, when, transport, resolver, env),
   { claimId: claim.claim_id, outcome: "fallback", reason: "line_unknown_possible_duplicate" });
  assert.equal(transport.calls.length, 0);
  assert.equal(await allEmails(event, who.contact, claim.notification_id), 1);
  assert.equal((await owner(claim.claim_id)).email_owner, kind === "rent" ? "b010_claim" : "line_fallback");
  assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0], { pushed_count: 0, reserved_count: 1 });
  evidence.emails.push({ path: `${kind} unknown result expired`, reason: "line_unknown_possible_duplicate", total: 1 });
 });
}

for (const used of [179, 180, 181]) test(`A3 quota boundary ${used}: ${used === 179 ? "last slot pushes" : "Email fallback line_quota"}`, async () => {
 await enableAll(); await link(rent.contact, rent.user); await usage(used);
 const event = await schedule(0), transport = capture();
 await runLineRentPushes(at(0), transport, resolver, env);
 const [claim] = await claims(event);
 const counts = (await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0];
 if (used === 179) {
  assert.deepEqual([claim.state, transport.calls.length, counts], ["sent", 1, { pushed_count: 180, reserved_count: 0 }]);
 } else {
  assert.deepEqual([claim.state, claim.reason, transport.calls.length, counts], ["fallback", "line_quota", 0, { pushed_count: used, reserved_count: 0 }]);
  assert.equal(await allEmails(event, rent.contact, claim.notification_id), 1);
 }
 evidence.quota[String(used)] = { claim: claim.state, reason: claim.reason, pushes: transport.calls.length, counter: counts,
  emailsForRecipient: await allEmails(event, rent.contact, claim.notification_id) };
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_quota_alerts")).rows[0].n, 1);
});

test("A4 timeout is retried with the same X-Line-Retry-Key and reservation; concurrent retries never double-push", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const event = await schedule(0);
 const first = capture(["timeout"]);
 const r1 = await runLineRentPushes(at(0), first, resolver, env, { timeoutMs: 50 });
 assert.deepEqual(r1.results.map(r => r.outcome), ["retry"]);
 const [claim] = await claims(event);
 assert.equal(claim.state, "claimed");
 const reservation = async () => (await db.query("SELECT id::text,status,attempt_count FROM app.b033_push_reservations WHERE claim_id=$1", [claim.claim_id])).rows;
 const [held] = await reservation();
 assert.equal(held.status, "unknown");
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0], { pushed_count: 0, reserved_count: 1 });
 // Two concurrent retries: exactly one reaches the transport; the other is busy.
 const second = capture(["duplicateAccepted"], 300);
 const results = await Promise.all([0, 1].map(() => dispatchRentPush(ORG_ID, claim.claim_id, at(0), second, resolver, env)));
 assert.deepEqual(results.map(r => r.outcome).sort(), ["busy", "sent"]);
 evidence.concurrency = { firstAttempt: "timeout", concurrentRetries: results.map(r => r.outcome).sort(), transportCalls: first.calls.length + second.calls.length,
  sameRetryKey: [...first.calls, ...second.calls].every(c => c.headers["X-Line-Retry-Key"] === claim.claim_id), reservationRows: 1 };
 assert.equal(second.calls.length, 1);
 assert.deepEqual([...first.calls, ...second.calls].map(c => c.headers["X-Line-Retry-Key"]), [claim.claim_id, claim.claim_id]);
 const after = await reservation();
 assert.deepEqual(after, [{ id: held.id, status: "settled", attempt_count: 2 }]);
 Object.assign(evidence.concurrency, { reservation: { status: "settled", attempt_count: 2 } });
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0], { pushed_count: 1, reserved_count: 0 });
 assert.deepEqual(await deliveriesOf(claim.notification_id), [{ channel: "line", status: "sent", error: null, counts_toward_quota: true }]);
 assert.equal(await emailAttempts(claim.notification_id), 0);
 // A later run has nothing to retry.
 assert.deepEqual((await runLineRentPushes(at(0), second, resolver, env)).results, []);
 assert.equal(second.calls.length, 1);
});

for (const scenario of ["paid", "terminated", "recipient_lease"] as const) {
 test(`A4 a held retry whose occurrence became ${scenario} is suppressed: no push, no Email, reservation kept unsettled`, async () => {
  await enableAll(); await link(rent.contact, rent.user);
  const event = await schedule(0);
  await runLineRentPushes(at(0), capture(["timeout"]), resolver, env, { timeoutMs: 50 });
  const [claim] = await claims(event);
  if (scenario === "paid") await db.query("UPDATE invoices SET status='paid' WHERE id=$1", [rent.invoice]);
  if (scenario === "terminated") await db.query("UPDATE leases SET status='terminated',terminated_on=current_date WHERE id=$1", [rent.lease]);
  if (scenario === "recipient_lease") await db.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [rent.contact]);
  const retry = capture(["accepted"]);
  assert.deepEqual(await dispatchRentPush(ORG_ID, claim.claim_id, at(0), retry, resolver, env), { claimId: claim.claim_id, outcome: "suppressed", reason: scenario });
  assert.equal(retry.calls.length, 0);
  const held = async () => (await db.query("SELECT status,has_unknown FROM app.b033_push_reservations WHERE claim_id=$1", [claim.claim_id])).rows;
  assert.deepEqual(await held(), [{ status: "expired", has_unknown: true }]);
  const counter = { pushed_count: 0, reserved_count: 1 };
  assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0], counter);
  assert.equal(await emailAttempts(claim.notification_id), 0);
  assert.deepEqual((await db.query("SELECT count(*)::int n FROM app.b033_push_fallbacks WHERE claim_id=$1", [claim.claim_id])).rows[0].n, 0);
  assert.deepEqual(await deliveriesOf(claim.notification_id), [{ channel: "line", status: "failed", error: "line_unknown_suppressed", counts_toward_quota: false }]);
  // Expiry and later runs never turn it into a push or a possible-duplicate Email.
  await forceDeadline(claim.claim_id); await expireLinePushes(ORG_ID, env);
  assert.deepEqual((await runLineRentPushes(at(0), retry, resolver, env)).results, []);
  assert.equal(retry.calls.length, 0); assert.equal(await emailAttempts(claim.notification_id), 0);
  assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage WHERE line_channel_id=$1", [channel])).rows[0], counter);
  assert.equal((await lineRentPushStatus(ORG_ID, claim.notification_id)).status, "suppressed");
 });
}

test("A4 an eligible held retry keeps its original key and reservation", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const event = await schedule(0);
 await runLineRentPushes(at(0), capture(["timeout"]), resolver, env, { timeoutMs: 50 });
 const [claim] = await claims(event);
 const retry = capture(["accepted"]);
 assert.equal((await dispatchRentPush(ORG_ID, claim.claim_id, at(0), retry, resolver, env)).outcome, "sent");
 assert.deepEqual(retry.calls.map(c => c.headers["X-Line-Retry-Key"]), [claim.claim_id]);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_push_reservations WHERE claim_id=$1", [claim.claim_id])).rows[0].n, 1);
});

test("discovery pages past evaluated ineligible events, so more than the limit cannot starve a later eligible event", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const localDate = (await db.query("SELECT ($1::timestamptz AT TIME ZONE 'Asia/Taipei')::date::text d", [at(0).toISOString()])).rows[0].d;
 for (let i = 0; i < 5; i++) {
  await db.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,$5)`,
   [ORG_ID, rent.lease, rent.invoice, `local-stale:${i}`, localDate]);
 }
 const event = await schedule(0), transport = capture();
 const outcomes: string[][] = [];
 for (let run = 0; run < 3; run++) outcomes.push((await runLineRentPushes(at(0), transport, resolver, env, { limit: 2 })).results.map(r => r.outcome));
 assert.deepEqual(outcomes, [[], [], ["sent"]]);
 assert.deepEqual((await claims(event)).map(c => c.state), ["sent"]);
 assert.deepEqual((await db.query("SELECT reason,count(*)::int n FROM app.b037_event_marks GROUP BY reason")).rows, [{ reason: "stale_day", n: 5 }]);
 assert.equal((await svc(null, c => c.query("SELECT * FROM app.b037_pending($1,200)", [at(0).toISOString()]))).rowCount, 0);
 assert.equal(transport.calls.length, 1);
});

test("payment results: a missed run is caught up within the 7-day look-back; older results are not pushed", async () => {
 await enableAll(); await link(pay.contact, pay.user);
 const recent = await paymentEvent("payment_confirmed");
 const old = await paymentEvent("payment_rejected", await rejectedPayment());
 await db.query("UPDATE app.b010_source_events SET created_at=now()-interval '3 days' WHERE id=$1", [recent]);
 await db.query("UPDATE app.b010_source_events SET created_at=now()-interval '8 days' WHERE id=$1", [old]);
 const transport = capture();
 await runLineRentPushes(new Date(), transport, resolver, env);
 assert.deepEqual((await claims(recent)).map(c => c.state), ["sent"]);
 assert.deepEqual(await claims(old), []);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b037_event_marks WHERE event_id=$1", [old])).rows[0].n, 0);
 assert.equal(transport.calls.length, 1);
});

for (const locale of ["zh-TW", "en"] as const) test(`evidence: captured ${locale} payloads for all four kinds carry only the reminder and LIFF link`, async () => {
 await enableAll();
 await db.query("UPDATE contacts SET locale=$1 WHERE id=ANY($2::uuid[])", [locale, [rent.contact, pay.contact]]);
 await link(rent.contact, rent.user); await link(pay.contact, pay.user);
 const transport = capture();
 await schedule(0); await runLineRentPushes(at(0), transport, resolver, env);
 await schedule(1); await runLineRentPushes(at(1), transport, resolver, env);
 await paymentEvent("payment_confirmed"); await paymentEvent("payment_rejected", await rejectedPayment());
 await runLineRentPushes(new Date(), transport, resolver, env);
 assert.equal(transport.calls.length, 4);
 const kinds = ["rent_due", "rent_overdue", "payment_confirmed", "payment_rejected"];
 const rows = (await db.query(`SELECT c.kind,c.claim_id::text FROM app.b037_rent_push_claims c ORDER BY c.created_at`)).rows;
 assert.deepEqual(rows.map(r => r.kind), kinds);
 evidence.payloads[locale] = {};
 for (const [i, call] of transport.calls.entries()) {
  assertLiffOnly(call.messages[0].text);
  assert.equal(call.headers["X-Line-Retry-Key"], rows[i].claim_id);
  evidence.payloads[locale][kinds[i]] = call.messages[0].text;
 }
 if (locale === "en") assert.match(transport.calls[0].messages[0].text, /^\[.+\] Rent reminder: NT\$[0-9,]+ is due on \d{4}-\d{2}-\d{2}\./);
 else assert.match(transport.calls[0].messages[0].text, /^【.+】租金提醒：本期租金 NT\$[0-9,]+，應繳日為 \d{4}年\d{1,2}月\d{1,2}日。/);
});

for (const kind of ["payment", "rent"] as const) test(`no usable OA (${kind}): terminal line_unavailable with exactly one Email for the recipient`, async () => {
 await enableAll();
 const who = kind === "rent" ? rent : pay;
 const event = kind === "rent" ? await schedule(0) : await paymentEvent("payment_confirmed");
 const when = kind === "rent" ? at(0) : new Date();
 await db.query("UPDATE line_channels SET is_active=false");
 const transport = capture();
 for (let i = 0; i < 2; i++) await runLineRentPushes(when, transport, resolver, env);
 const [claim] = await claims(event);
 assert.deepEqual({ state: claim.state, reason: claim.reason }, { state: "fallback", reason: "line_unavailable" });
 assert.equal(transport.calls.length, 0);
 assert.equal(await allEmails(event, who.contact, claim.notification_id), 1);
 assert.equal(await emailAttempts(claim.notification_id), kind === "rent" ? 0 : 1);
 assert.deepEqual(await deliveriesOf(claim.notification_id), [
  ...(kind === "payment" ? [{ channel: "email", status: "queued", error: "line_unavailable", counts_toward_quota: false }] : []),
  { channel: "line", status: "skipped", error: "line_unavailable", counts_toward_quota: false }]);
 assert.equal((await owner(claim.claim_id)).email_owner, kind === "rent" ? "b010_claim" : "line_fallback");
 assert.deepEqual(await lineRentPushStatus(ORG_ID, claim.notification_id), { status: "email_fallback", label: "改以 Email 通知", reason: "line_unavailable" });
 assert.deepEqual((await runLineRentPushes(when, transport, resolver, env)).results, []);
});

test("open claims rotate: more than the limit of stuck claims in one org cannot block another org", async () => {
 await link(pay.contact, pay.user);
 const stuck = new Set([...subs.values()]);
 const events: string[] = [];
 for (let i = 0; i < 3; i++) events.push(await paymentEvent("payment_rejected", await rejectedPayment(1000 + i)));
 const org2 = (await db.query(`SELECT c.id contact,c.user_id::text "user",lp.lease_id::text lease FROM contacts c JOIN lease_parties lp ON lp.contact_id=c.id
  WHERE c.org_id=$1 AND lp.role='primary' LIMIT 1`, [ORG2_ID])).rows[0];
 const payment2 = (await db.query(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,rejected_reason)
  SELECT l.org_id,l.property_id,l.id,$2,'TWD',2000,current_date,p.method,'rejected',p.source,'local reason' FROM leases l CROSS JOIN (SELECT method,source FROM payments LIMIT 1) p
  WHERE l.id=$1 RETURNING id`, [org2.lease, org2.contact])).rows[0].id;
 await enableAll([ORG_ID, ORG2_ID]);
 await db.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)", [channel, ORG2_ID]);
 const other = await link(org2.contact, org2.user, { org: ORG2_ID });
 const event2 = (await db.query(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id) VALUES($1,$2,$3,'payment_rejected','payment_rejected',$4) RETURNING id`,
  [ORG2_ID, org2.lease, payment2, USERS.admin])).rows[0].id;
 const calls: PushRequest[] = [];
 const transport = { async push(request: PushRequest): Promise<PushOutcome> { calls.push(structuredClone(request)); return { status: stuck.has(request.to) ? "timeout" : "accepted" }; } };
 const runs: string[][] = [];
 for (let run = 0; run < 2; run++) runs.push((await runLineRentPushes(new Date(), transport, resolver, env, { limit: 2, timeoutMs: 50 })).results.map(r => r.outcome));
 assert.deepEqual(runs, [["retry", "retry"], ["retry", "sent"]]);
 assert.deepEqual((await claims(event2)).map(c => c.state), ["sent"]);
 assert.ok(calls.some(c => c.to === other.to));
 for (const e of events) assert.deepEqual((await claims(e)).map(c => c.state), ["claimed"]);
 evidence.concurrency.rotation = { orgAStuckClaims: 3, limit: 2, runs, orgBSentOnRun: 2 };
});

test("an in-flight worker that fails after a concurrent recheck suppressed the occurrence sends no Email", async () => {
 await enableAll(); await link(pay.contact, pay.user);
 const event = await paymentEvent("payment_confirmed");
 await claimRentPushes(new Date(), env);
 const [claim] = await claims(event);
 let release!: () => void; const gate = new Promise<void>(r => { release = r; });
 const calls: PushRequest[] = [];
 const slow = { async push(request: PushRequest): Promise<PushOutcome> { calls.push(request); await gate; return { status: "failed" }; } };
 const inFlight = dispatchRentPush(ORG_ID, claim.claim_id, new Date(), slow, resolver, env);
 for (let i = 0; i < 200 && calls.length === 0; i++) await new Promise(r => setTimeout(r, 10));
 assert.equal(calls.length, 1);
 await reversePayment();
 assert.deepEqual(await dispatchRentPush(ORG_ID, claim.claim_id, new Date(), capture(), resolver, env),
  { claimId: claim.claim_id, outcome: "suppressed", reason: "payment_changed" });
 release();
 assert.equal((await inFlight).outcome, "suppressed");
 assert.equal(await emailAttempts(claim.notification_id), 0);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_push_fallbacks WHERE claim_id=$1", [claim.claim_id])).rows[0].n, 0);
 assert.equal((await claims(event))[0].state, "suppressed");
 await forceDeadline(claim.claim_id); await expireLinePushes(ORG_ID, env);
 assert.equal(await emailAttempts(claim.notification_id), 0);
 assert.equal((await lineRentPushStatus(ORG_ID, claim.notification_id)).status, "suppressed");
});

for (const crashed of ["fallback", "settle"] as const) test(`crash after B-033 ${crashed} commit but before mark: a later ineligible recheck reports the real outcome`, async () => {
 await enableAll();
 if (crashed === "settle") await link(pay.contact, pay.user);
 const event = await paymentEvent("payment_confirmed");
 await claimRentPushes(new Date(), env);
 const [claim] = await claims(event);
 const transport = capture();
 if (crashed === "fallback") {
  await svc(null, c => c.query("SELECT * FROM app.b037_push_fallback($1,$2,$3,$4,$5)", [channel, claim.claim_id, ORG_ID, claim.notification_id, "line_unlinked"]));
 } else {
  const [linkId, to] = [...subs.entries()][0];
  assert.ok(linkId);
  assert.equal((await dispatchLinePush({ orgId: ORG_ID, notificationId: claim.notification_id, claimId: claim.claim_id, channelId: channel, persona: "tenant",
   to, identityPepper: pepper, messages: [{ type: "text", text: "local test" }] }, transport, env, { fallbackGateway: "b037" })).status, "accepted");
 }
 assert.equal((await claims(event))[0].state, "claimed");
 await reversePayment();
 const result = await dispatchRentPush(ORG_ID, claim.claim_id, new Date(), transport, resolver, env);
 assert.deepEqual(result, crashed === "fallback" ? { claimId: claim.claim_id, outcome: "fallback", reason: "line_unlinked" } : { claimId: claim.claim_id, outcome: "sent" });
 assert.equal((await claims(event))[0].state, crashed === "fallback" ? "fallback" : "sent");
 assert.equal((await lineRentPushStatus(ORG_ID, claim.notification_id)).status, crashed === "fallback" ? "email_fallback" : "sent");
 assert.equal(await emailAttempts(claim.notification_id), crashed === "fallback" ? 1 : 0);
 assert.equal(transport.calls.length, crashed === "fallback" ? 0 : 1);
});

test("A5 provider acceptance is displayed as sent (送出), never delivered or read", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const event = await schedule(0);
 await runLineRentPushes(at(0), createCapturedLineTransport({ mode: "accepted" }), resolver, env);
 const [claim] = await claims(event);
 const row = (await db.query("SELECT status::text,sent_at IS NOT NULL sent,delivered_at,read_at FROM deliveries WHERE notification_id=$1 AND channel='line'", [claim.notification_id])).rows[0];
 assert.deepEqual(row, { status: "sent", sent: true, delivered_at: null, read_at: null });
 assert.deepEqual(await lineRentPushStatus(ORG_ID, claim.notification_id), { status: "sent", label: "已送出" });
 assert.deepEqual(await lineRentPushStatus(ORG_ID, claim.notification_id, "en"), { status: "sent", label: "Sent" });
 assert.equal((await db.query("SELECT count(*)::int n FROM deliveries WHERE status IN ('delivered','read')")).rows[0].n, 0);
 for (const locale of ["zh-TW", "en"] as const) for (const status of ["sent", "email_fallback", "queued", "suppressed"] as const) {
  assert.doesNotMatch(lineRentPushStatusLabel(status, locale), /deliver|read|已讀|送達|已收/i);
 }
});

const offMatrix: [string, () => Promise<void>, Record<string, string>?][] = [
 ["environment kill", async () => {}, { LINE_PLATFORM_ENABLED: "false", LINE_PUSH_QUOTA_GUARD: "true" }],
 ["line_rent_push platform disabled", async () => setFlag("line_rent_push", { enabled: false, allowed_org_ids: [ORG_ID] })],
 ["line_rent_push org flag missing", async () => { await db.query("UPDATE organizations SET feature_flags=feature_flags-'line_rent_push' WHERE id=$1", [ORG_ID]); }],
 ["line_rent_push org flag non-boolean", async () => setFlag("line_rent_push", { enabled: true, allowed_org_ids: [ORG_ID] }, { [ORG_ID]: "true" })],
 ["line_rent_push malformed allowlist", async () => setFlag("line_rent_push", { enabled: true, allowed_org_ids: "bad" })],
 ["line_rent_push other org only", async () => setFlag("line_rent_push", { enabled: true, allowed_org_ids: [ORG2_ID] })],
 ["line_push off", async () => setFlag("line_push", { enabled: false, allowed_org_ids: [] })],
 ["line_platform off", async () => setFlag("line_platform", { enabled: false, allowed_org_ids: [] })],
 ["notification_delivery_v2 off", async () => setFlag("notification_delivery_v2", { enabled: false, allowed_org_ids: [] })],
];
for (const [name, off, runEnv] of offMatrix) test(`OFF ${name}: zero writes, zero transport calls, existing reminders unchanged`, async () => {
 await enableAll(); await link(rent.contact, rent.user);
 await schedule(0); await paymentEvent("payment_confirmed");
 await off();
 const before = await snapshot(), transport = capture();
 const run = await runLineRentPushes(at(0), transport, resolver, runEnv ?? env);
 await runLineRentPushes(new Date(), transport, resolver, runEnv ?? env);
 assert.deepEqual(run.results, []); assert.equal(transport.calls.length, 0);
 assert.deepEqual(await snapshot(), before);
 evidence.off.push({ layer: name, writes: 0, transportCalls: 0, existingRemindersUnchanged: true });
});

test("OFF after claiming: a claimed occurrence is not dispatched, suppressed or marked while disabled", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const event = await schedule(0);
 await claimRentPushes(at(0), env);
 const [claim] = await claims(event);
 await setFlag("line_rent_push", { enabled: false, allowed_org_ids: [] });
 await db.query("UPDATE invoices SET status='paid' WHERE id=$1", [rent.invoice]);
 const before = await snapshot(), transport = capture();
 assert.equal((await dispatchRentPush(ORG_ID, claim.claim_id, at(0), transport, resolver, env)).outcome, "disabled");
 assert.equal(transport.calls.length, 0);
 assert.deepEqual(await snapshot(), before);
});

test("cross-org: other organizations' events and claims are never claimed, prepared or marked", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const event = await schedule(0);
 // Wrong org argument finds nothing and writes nothing.
 assert.equal((await svc(null, c => c.query("SELECT * FROM app.b037_claim($1,$2,$3)", [ORG2_ID, event, at(0).toISOString()]))).rowCount, 0);
 assert.equal((await claims()).length, 0);
 // A pinned org context cannot act for another organization.
 const pinned = await svc(null, async c => {
  await c.query("SELECT set_config('app.active_org_id',$1,true)", [ORG2_ID]);
  return (await c.query("SELECT * FROM app.b037_claim($1,$2,$3)", [ORG_ID, event, at(0).toISOString()])).rowCount;
 });
 assert.equal(pinned, 0); assert.equal((await claims()).length, 0);
 await claimRentPushes(at(0), env);
 const [claim] = await claims(event);
 await enableAll([ORG_ID, ORG2_ID]);
 for (const fn of ["SELECT * FROM app.b037_prepare($1,$2,$3)", "SELECT app.b037_mark($1,$2)"]) {
  await assert.rejects(svc(null, c => c.query(fn, fn.includes("$3") ? [ORG2_ID, claim.claim_id, at(0).toISOString()] : [ORG2_ID, claim.claim_id])));
 }
 assert.equal((await claims(event))[0].state, "claimed");
 // Private storage and gateways: no client role reads the table or executes the functions.
 const grants = (await db.query(`SELECT r, p FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
  WHERE has_table_privilege(r,'app.b037_rent_push_claims',p) OR has_table_privilege(r,'app.b037_event_marks',p)`)).rows;
 assert.deepEqual(grants, []);
 const exec = (await db.query(`SELECT p.proname,r FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r
  WHERE n.nspname='app' AND p.proname LIKE 'b037_%' AND has_function_privilege(r,p.oid,'EXECUTE') ORDER BY 1,2`)).rows;
 assert.deepEqual(exec.map(r => `${r.proname}:${r.r}`), ["b037_claim:service_role", "b037_enabled:service_role", "b037_mark:service_role",
  "b037_open:service_role", "b037_pending:service_role", "b037_prepare:service_role", "b037_push_fallback:service_role"]);
 const defs = (await db.query(`SELECT p.proname,p.prosecdef,array_to_string(p.proconfig,',') cfg FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app' AND p.proname LIKE 'b037_%'`)).rows;
 for (const d of defs) { assert.equal(d.prosecdef, true, d.proname); assert.match(d.cfg, /search_path=pg_catalog, public, app, pg_temp/, d.proname); }
 assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.b037_rent_push_claims'::regclass")).rows[0].relrowsecurity, true);
});

test("legacy overlap: an occurrence already owned by a legacy email_log claim is never pushed", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const event = await schedule(1);
 await setFlag("rent_reminders_v2", { enabled: false, allowed_org_ids: [] });
 await db.query("INSERT INTO email_log(org_id,kind,target_id,threshold) VALUES($1,'rent_overdue_tenant',$2,1)", [ORG_ID, rent.invoice]);
 await setFlag("rent_reminders_v2", { enabled: true, allowed_org_ids: [ORG_ID] });
 const transport = capture();
 await runLineRentPushes(at(1), transport, resolver, env);
 assert.deepEqual(await claims(event), []); assert.equal(transport.calls.length, 0);
 // While the new path owns the org, the legacy reminder claim stays fenced.
 await assert.rejects(db.query("INSERT INTO email_log(org_id,kind,target_id,threshold) VALUES($1,'rent_overdue_tenant',$2,7)", [ORG_ID, rent.invoice]),
  (e: { code?: string }) => e.code === "42501");
});

test("legacy overlap: an in-flight legacy claim (BLK-MAC-11 invoice fence) serializes the claim, which then defers to legacy", async () => {
 await enableAll(); await link(rent.contact, rent.user);
 const event = await schedule(1);
 await setFlag("rent_reminders_v2", { enabled: false, allowed_org_ids: [] });
 const legacy = new Client({ connectionString: process.env.DATABASE_URL }); await legacy.connect();
 try {
  await legacy.query("BEGIN");
  await legacy.query("INSERT INTO email_log(org_id,kind,target_id,threshold) VALUES($1,'rent_overdue_tenant',$2,1)", [ORG_ID, rent.invoice]);
  await setFlag("rent_reminders_v2", { enabled: true, allowed_org_ids: [ORG_ID] });
  const started = Date.now();
  const claim = svc(null, async c => (await c.query("SELECT * FROM app.b037_claim($1,$2,$3)", [ORG_ID, event, at(1).toISOString()])).rowCount);
  await new Promise(r => setTimeout(r, 400));
  await legacy.query("COMMIT");
  assert.equal(await claim, 0);
  assert.ok(Date.now() - started >= 350, "claim waited for the legacy invoice lock");
 } finally { await legacy.end(); }
 assert.deepEqual(await claims(event), []);
 assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE dedupe_key LIKE 'b037:%'")).rows[0].n, 0);
});
