import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
import { loadTicketRelay, type TicketRelay } from "./b3-ticket-relay";
import type { Session } from "./types";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { hashVendorToken } from "./vendor-repair-rules";
import { submitVendorReport } from "./vendor-repair";

// MGT-150-AC1…AC5 (TK-RELAY / TK-RELAY-MNT) through the real readers on a cloned disposable database:
// the 3b staff snapshot (service_role), the existing scoped manager view, and RLS ticket facts.
// Synthetic fixtures; prints labels only. Run: CONDOLA_RLS_DISPOSABLE=YES DATABASE_URL=… .
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
let property: string, currency: string, minorUnit: number, ownerName: string, tenantContact: string, tenantName: string;
const adminSid = randomUUID(), ownerSid = randomUUID(), maintenanceSid = randomUUID(), accountantSid = randomUUID();
const base = { kind: "staff" as const, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live" as const, email: "synthetic@example.test",
  name: "Fixture", locale: "zh-TW" as const, calendar: "gregorian" as const, leaseId: null };
const admin: Session = { ...base, userId: USERS.admin, sessionId: adminSid, role: "admin" };
const maintenance: Session = { ...base, userId: USERS.maintenance, sessionId: maintenanceSid, role: "maintenance" };
const accountant: Session = { ...base, userId: USERS.accountant, sessionId: accountantSid, role: "accountant" };
const owner: Session = { ...base, userId: USERS.owner, sessionId: ownerSid, kind: "owner", role: null };

async function flag(key: string, value: boolean) {
  await db.query("UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,$3::boolean) WHERE id=$1", [ORG_ID, key, value]);
}

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
  await db.query(`UPDATE public.organizations SET plan_tier='beta',
    feature_flags=feature_flags||'{"repair_approvals":true,"vendor_dispatch":true,"vendor_link":false,"brand_v2":true,"brand_v3":true}'::jsonb
    WHERE id=$1`, [ORG_ID]);
  assert.equal((await db.query(`UPDATE public.platform_settings
    SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'`, [ORG_ID])).rowCount, 1);
  const row = (await db.query(`SELECT po.id,po.property_id,p.currency::text currency,r.minor_unit,c.display_name
    FROM public.property_owners po
    JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
    JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id
    JOIN public.organizations o ON o.id=po.org_id
    JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
    WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND c.archived_at IS NULL
      AND p.archived_at IS NULL ORDER BY po.id LIMIT 1`, [ORG_ID, USERS.owner])).rows[0];
  assert.ok(row);
  property = row.property_id; currency = row.currency.trim(); minorUnit = row.minor_unit; ownerName = row.display_name;
  await db.query(`UPDATE public.property_owners SET effective_from=CURRENT_DATE-1,effective_to=CURRENT_DATE
    WHERE org_id=$1 AND property_id=$2 AND id<>$3`, [ORG_ID, property, row.id]);
  await db.query(`UPDATE public.property_owners SET repair_approval_threshold_minor=500000,
    effective_from=CURRENT_DATE-1,effective_to=NULL WHERE id=$1`, [row.id]);
  const tenant = (await db.query("SELECT id,display_name FROM public.contacts WHERE org_id=$1 AND is_tenant AND archived_at IS NULL ORDER BY id LIMIT 1", [ORG_ID])).rows[0];
  assert.ok(tenant); tenantContact = tenant.id; tenantName = tenant.display_name;
  for (const [sid, user] of [[adminSid, USERS.admin], [ownerSid, USERS.owner], [maintenanceSid, USERS.maintenance], [accountantSid, USERS.accountant]])
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid, user, randomUUID()]);
});

test.after(async () => {
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

async function fixture(amount: number) {
  const ticket = randomUUID(), job = randomUUID(), token = randomBytes(32).toString("base64url");
  assert.equal((await db.query(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval,reported_by_contact_id)
    SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),
      $3,category,priority,'in_progress','Relay fixture',cost_bearer,owner_approval,$4
    FROM public.maintenance_tickets WHERE org_id=$2 ORDER BY id LIMIT 1`, [ticket, ORG_ID, property, tenantContact])).rowCount, 1);
  const estimate = await svc(USERS.admin, async client => (await client.query(`SELECT app.b013_submit_estimate(
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,NULL,$8::bigint,$5::text,$6::smallint,
      'Repair pipe','[]'::jsonb,$7::bytea) r`,
    [ORG_ID, adminSid, randomUUID(), ticket, currency, minorUnit, createHash("sha256").update(ticket).digest(), amount])).rows[0].r);
  assert.equal(estimate.status, "recorded");
  await db.query(`INSERT INTO public.repair_vendor_jobs
    (id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by)
    VALUES($1,$2,$3,'陳師傅','+886900000000','Weekdays',$4,clock_timestamp()+interval '1 day',$5)`,
  [job, ORG_ID, ticket, hashVendorToken(token), USERS.admin]);
  return { ticket, job, token, version: String(estimate.version_id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function decision(f: Fixture, value: "approved" | "rejected" | "more_information") {
  const r = await svc(USERS.owner, async c => (await c.query(`SELECT app.b013_decide_estimate(
    $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::bytea) r`,
  [ORG_ID, ownerSid, randomUUID(), f.version, value, value === "approved" ? null : "想先比價",
    createHash("sha256").update(randomUUID()).digest()])).rows[0].r);
  assert.equal(r.status, "recorded");
}
async function newVersion(f: Fixture, amount: number) {
  const r = await svc(USERS.admin, async c => (await c.query(`SELECT app.b013_submit_estimate(
    $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,$8::smallint,
    'Repair scope','[]'::jsonb,$9::bytea) r`, [ORG_ID, adminSid, randomUUID(), f.ticket, f.version, amount, currency, minorUnit,
    createHash("sha256").update(randomUUID()).digest()])).rows[0].r);
  assert.equal(r.status, "recorded"); f.version = String(r.version_id);
}
async function emergency(f: Fixture) {
  await db.query(`INSERT INTO app.b013_repair_emergencies
    (org_id,ticket_id,version_id,category,reason,authorized_photo_snapshot,authorized_by)
    VALUES($1,$2,$3,'water','Synthetic emergency',$4::jsonb,$5)`,
  [ORG_ID, f.ticket, f.version, JSON.stringify([{ id: randomUUID() }]), USERS.admin]);
}
const shape = (r: TicketRelay) => r.state === "ready" ? r.relay.nodes?.map(n => `${n.party}:${n.step}:${n.state}`) ?? null : r.state;
const estimate = (r: TicketRelay) => { assert.ok(r.state === "ready" && r.view === "estimate", JSON.stringify(r)); return r.relay; };

test.beforeEach(async () => {
  await flag("repair_approvals", true); await flag("vendor_dispatch", true); await flag("brand_v3", true);
});

test("MGT-150-AC4 real R5: owner sent the estimate back → 管 重新估價 pill and the lead with the deciding owner's name", async () => {
  const f = await fixture(600000);
  const pending = estimate(await loadTicketRelay(admin, f.ticket));
  assert.deepEqual(shape({ state: "ready", view: "estimate", relay: pending }),
    ["t:report:done", "m:dispatch:done", "o:approve_estimate:now", "v:do_repair:next", "m:confirm_cost:next"]);
  assert.equal(pending.nodes?.[0].subs[0]?.kind === "name" && pending.nodes[0].subs[0].text, tenantName);
  await decision(f, "rejected");
  const r5 = estimate(await loadTicketRelay(admin, f.ticket));
  assert.deepEqual(shape({ state: "ready", view: "estimate", relay: r5 }),
    ["t:report:done", "m:dispatch:done", "o:approve_estimate:done", "m:re_estimate:now", "v:do_repair:next"]);
  assert.deepEqual(r5.lead, { kind: "re_estimate", owner: ownerName });
  assert.deepEqual(r5.nodes?.[2].subs, [{ kind: "name", text: ownerName }, { kind: "sent_back" }]);
  assert.equal(r5.nodes?.[4].subs[0]?.kind === "name" && r5.nodes[4].subs[0].text, "陳師傅");
  assert.equal(r5.why, null);
});

test("MGT-150-AC3 real emergency rows: open owner decision, then sent back; 屋 only above the threshold", async () => {
  const f = await fixture(600000); await emergency(f);
  const open = estimate(await loadTicketRelay(admin, f.ticket));
  assert.deepEqual(shape({ state: "ready", view: "estimate", relay: open }),
    ["t:report:done", "m:dispatch:done", "o:approve_estimate:next", "v:do_repair:now", "m:confirm_cost:next"]);
  assert.equal(open.why, "emergency_open"); assert.equal(open.lead, null);
  await decision(f, "more_information");
  const back = estimate(await loadTicketRelay(admin, f.ticket));
  assert.equal(back.why, "emergency_back"); assert.equal(back.lead, null);
  assert.equal(back.nodes?.find(n => n.state === "now")?.party, "v");
  const below = estimate(await loadTicketRelay(admin, (await fixture(100)).ticket));
  assert.deepEqual(shape({ state: "ready", view: "estimate", relay: below }), ["t:report:done", "m:dispatch:done", "v:do_repair:now", "m:confirm_cost:next"]);
  assert.equal(below.why, null);
});

test("MGT-150-AC3 real resolved-but-waiting and unconfirmable reported cost", async () => {
  const f = await fixture(600000);
  await db.query("UPDATE public.maintenance_tickets SET status='resolved',resolved_at=clock_timestamp() WHERE id=$1", [f.ticket]);
  assert.equal(estimate(await loadTicketRelay(admin, f.ticket)).why, "resolved_owner");
  // Real path: retained B-026 work, the vendor's real report (which resolves the ticket), then a new
  // above-threshold head waiting for the owner → R3 with an unconfirmable reported cost.
  const g = await fixture(100);
  await db.query("INSERT INTO app.b026_vendor_estimates(org_id,ticket_id,version_id,vendor_job_id) VALUES($1,$2,$3,$4)", [ORG_ID, g.ticket, g.version, g.job]);
  await submitVendorReport(g.token, { done: true, cost: "10" });
  await newVersion(g, 600000);
  const cost = estimate(await loadTicketRelay(admin, g.ticket));
  assert.equal(cost.nodes?.find(n => n.state === "now")?.party, "o");
  assert.equal(cost.why, "cost_pending");
});

test("MGT-150-AC2 hidden owner/estimate/flag state NEVER changes the real maintenance view", async () => {
  const f = await fixture(600000);
  const read = () => loadTicketRelay(maintenance, f.ticket);
  const baseline = await read();
  assert.ok(baseline.state === "ready" && baseline.view === "maintenance");
  assert.deepEqual(shape(baseline), ["t:report:done", "m:dispatch:done", "v:do_repair:now", "m:confirm_cost:next"]);
  assert.ok(!JSON.stringify(baseline).includes("approve_estimate") && !JSON.stringify(baseline).includes(ownerName));
  await emergency(f); assert.deepEqual(await read(), baseline);
  await decision(f, "rejected"); assert.deepEqual(await read(), baseline);
  await db.query("UPDATE public.repair_vendor_jobs SET reported_at=clock_timestamp(),reported_cost_minor=12000 WHERE id=$1", [f.job]);
  assert.deepEqual(await read(), baseline);
  for (const approvals of [false, true]) for (const dispatch of [false, true]) {
    await flag("repair_approvals", approvals); await flag("vendor_dispatch", dispatch); assert.deepEqual(await read(), baseline);
  }
  // The public status is the only thing that moves the marker.
  await db.query("UPDATE public.maintenance_tickets SET status='open' WHERE id=$1", [f.ticket]);
  assert.deepEqual(shape(await read()), ["t:report:done", "m:dispatch:now", "v:do_repair:next", "m:confirm_cost:next"]);
});

test("admission: brand_v3 OFF, accountant, owner, cross-org and unknown tickets never render a relay", async () => {
  const f = await fixture(100);
  await flag("brand_v3", false);
  assert.deepEqual(await loadTicketRelay(admin, f.ticket), { state: "off" });
  await flag("brand_v3", true);
  assert.deepEqual(await loadTicketRelay(accountant, f.ticket), { state: "forbidden" });
  assert.deepEqual(await loadTicketRelay(owner, f.ticket), { state: "forbidden" });
  const otherProperty = (await db.query("SELECT id FROM public.properties WHERE org_id=$1 ORDER BY id LIMIT 1", [ORG2_ID])).rows[0];
  assert.ok(otherProperty);
  const foreign = randomUUID();
  assert.equal((await db.query(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
    SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),
      $3,category,priority,'open','Other-org relay fixture',cost_bearer,owner_approval
    FROM public.maintenance_tickets WHERE org_id=$4 ORDER BY id LIMIT 1`, [foreign, ORG2_ID, otherProperty.id, ORG_ID])).rowCount, 1);
  assert.deepEqual(await loadTicketRelay(admin, foreign), { state: "forbidden" });
  assert.deepEqual(await loadTicketRelay(admin, randomUUID()), { state: "forbidden" });
  // Closed: no relay, no tick (MGT-150-AC5).
  await db.query("UPDATE public.maintenance_tickets SET status='closed',closed_at=clock_timestamp() WHERE id=$1", [f.ticket]);
  const closed = estimate(await loadTicketRelay(admin, f.ticket));
  assert.equal(closed.nodes, null); assert.equal(closed.why, null);
});
