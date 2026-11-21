import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
import { ownerDecidedList, ownerDecidedTicket } from "./b093-owner-decided";
import type { Session } from "./types";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

// B-093 / OWN-35-AC1…AC3 gateway integration. Real gateways (submit, decide, read) on a cloned
// disposable database; never a pg mock or a table grant. Run: CONDOLA_RLS_DISPOSABLE=YES DATABASE_URL=… .
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
let xinyi: string, daan: string, currency: string, minorUnit: number;
const admin = randomUUID(), ownerSid = randomUUID(), owner2Sid = randomUUID(), coastSid = randomUUID();
const LIST = "app.b093_owner_decided(uuid,uuid,text,uuid,jsonb,integer)";
const ONE = "app.b093_owner_decided_ticket(uuid,uuid,text,uuid,uuid)";
const hash = (seed: string) => createHash("sha256").update(seed).digest();
type Row = { ticketId: string; versionId: string; property: string; item: string; amountMinor: string; decision: string; decidedAt: string; decidedOn: string; currency: string; minorUnit: number };
type Page = { rows: Row[]; next: { decidedAt: string; versionId: string } | null };
const f: Record<string, { ticket: string; version: string }> = {};

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
    feature_flags=feature_flags||'{"repair_approvals":true,"brand_v2":true,"brand_v3":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  assert.equal((await db.query(`UPDATE public.platform_settings
    SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))
    WHERE key='repair_approvals'`, [ORG_ID])).rowCount, 1);
  const owned = async (user: string) => (await db.query(`SELECT po.id,po.property_id,p.currency::text currency,r.minor_unit
    FROM public.property_owners po JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
    JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id JOIN public.organizations o ON o.id=po.org_id
    JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
    WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND p.archived_at IS NULL ORDER BY po.id LIMIT 1`, [ORG_ID, user])).rows[0];
  const a = await owned(USERS.owner), b = await owned(USERS.owner2);
  assert.ok(a && b && a.property_id !== b.property_id);
  xinyi = a.property_id; daan = b.property_id; currency = a.currency.trim(); minorUnit = a.minor_unit;
  await db.query("UPDATE public.property_owners SET repair_approval_threshold_minor=1000 WHERE org_id=$1 AND id = ANY($2::uuid[])", [ORG_ID, [a.id, b.id]]);
  for (const [sid, user] of [[admin, USERS.admin], [ownerSid, USERS.owner], [owner2Sid, USERS.owner2], [coastSid, USERS.coastAdmin]])
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid, user, randomUUID()]);

  // Owner (陳): A approved, B v1 rejected then v2 pending, C more information, D pending only, E under threshold.
  // Owner2 (林): F approved on another property. Decision order A → B → F → C, so C is newest.
  f.A = await submit(xinyi, "A 換熱水器", 50000); await decide(ownerSid, USERS.owner, f.A.version, "approved", null);
  f.B = await submit(xinyi, "B 門鎖", 20000); await decide(ownerSid, USERS.owner, f.B.version, "rejected", "請附兩家報價");
  f.B2 = { ticket: f.B.ticket, version: (await estimate(f.B.ticket, f.B.version, 18000)).version };
  f.F = await submit(daan, "F 漏水", 30000); await decide(owner2Sid, USERS.owner2, f.F.version, "approved", null);
  f.C = await submit(xinyi, "C 窗戶", 7000); await decide(ownerSid, USERS.owner, f.C.version, "more_information", "請補照片");
  f.D = await submit(xinyi, "D 冷氣", 9000);
  f.E = await submit(xinyi, "E 燈泡", 500);
});

test.after(async () => {
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

async function ticket(property: string, title: string) {
  const id = randomUUID();
  assert.equal((await db.query(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
    SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),
      $3,category,priority,'open',$4,cost_bearer,owner_approval
    FROM public.maintenance_tickets WHERE org_id=$2 ORDER BY id LIMIT 1`, [id, ORG_ID, property, title])).rowCount, 1);
  return id;
}
async function estimate(ticketId: string, head: string | null, amount: number) {
  const r = await svc(USERS.admin, async client => (await client.query(`SELECT app.b013_submit_estimate(
    $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,$8::smallint,'Synthetic scope '||$6::text,'[]'::jsonb,$9::bytea) r`,
  [ORG_ID, admin, randomUUID(), ticketId, head, amount, currency, minorUnit, hash(randomUUID())])).rows[0].r);
  assert.equal(r.status, "recorded");
  return { ticket: ticketId, version: String(r.version_id) };
}
async function submit(property: string, title: string, amount: number) { return estimate(await ticket(property, title), null, amount); }
async function decide(sid: string, user: string, version: string, decision: string, reason: string | null) {
  const r = await svc(user, async client => (await client.query(
    "SELECT app.b013_decide_estimate($1,$1,'live',$2,$3,$4,$5,$6,$7) r", [ORG_ID, sid, randomUUID(), version, decision, reason, hash(randomUUID())])).rows[0].r);
  assert.equal(r.status, "recorded");
}
/** Service-role read with the reader's pins; `org`/`pin` vary only for denial tests. */
async function list(sid: string, after: unknown = null, limit = 20, org = ORG_ID, pin: string | null = org, live = ORG_ID): Promise<Page> {
  return svc(null, async client => {
    if (pin) await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [pin]);
    return (await client.query(`SELECT ${LIST.split("(")[0]}($1,$2,'live',$3,$4,$5) r`, [org, live, sid, after, limit])).rows[0].r;
  }, { isolation: "repeatable read" });
}
async function one(sid: string, ticketId: string, org = ORG_ID) {
  return svc(null, async client => {
    await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [org]);
    return (await client.query(`SELECT ${ONE.split("(")[0]}($1,$1,'live',$2,$3) r`, [org, sid, ticketId])).rows[0].r;
  }, { isolation: "repeatable read" });
}
const code = (c: string) => (e: unknown) => ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === c;
const ownerSession = (sid = ownerSid, userId: string = USERS.owner): Session => ({ kind: "owner", role: null, orgId: ORG_ID, liveOrgId: ORG_ID, userId, sessionId: sid,
  name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });

test("B-093 gateways: only service_role may EXECUTE; anon and authenticated are denied; no table grant is added", async () => {
  for (const signature of [LIST, ONE]) {
    for (const role of ["anon", "authenticated", "service_role"])
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok, role === "service_role", `${role} ${signature}`);
    // Ownership by the migration role is asserted by scripts/check-function-privileges.sh.
    const meta = (await db.query("SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows[0];
    assert.deepEqual(meta, { prosecdef: true, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"] });
    for (const role of ["anon", "authenticated"]) {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        const args = signature === LIST ? "NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::jsonb,NULL::integer" : "NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::uuid";
        await assert.rejects(db.query(`SELECT ${signature.split("(")[0]}(${args})`), { code: "42501" });
      } finally { await db.query("ROLLBACK"); }
    }
  }
  for (const table of ["estimate_versions", "estimate_decisions"]) {
    await db.query("BEGIN");
    try { await db.query("SET LOCAL ROLE service_role"); await assert.rejects(db.query(`SELECT 1 FROM app.b013_${table} LIMIT 1`), { code: "42501" }); }
    finally { await db.query("ROLLBACK"); }
  }
});

test("OWN-35-AC1: own decided estimates only, newest first; pending, re-estimated and under-threshold versions excluded", async () => {
  const page = await list(ownerSid);
  assert.deepEqual(page.rows.map(row => [row.ticketId, row.versionId, row.decision]),
    [[f.C.ticket, f.C.version, "more_information"], [f.B.ticket, f.B.version, "rejected"], [f.A.ticket, f.A.version, "approved"]]);
  assert.equal(page.next, null);
  const [c] = page.rows;
  const property = (await db.query("SELECT name FROM public.properties WHERE id=$1", [xinyi])).rows[0].name;
  const today = (await db.query("SELECT (clock_timestamp() AT TIME ZONE timezone)::date::text d FROM public.organizations WHERE id=$1", [ORG_ID])).rows[0].d;
  assert.deepEqual({ ...c, decidedAt: typeof c.decidedAt }, { ticketId: f.C.ticket, versionId: f.C.version, property, item: "C 窗戶", currency, minorUnit,
    amountMinor: "7000", decision: "more_information", decidedAt: "string", decidedOn: today });
  // Only the listed fields: no scope, reason, threshold, designation or decider identity.
  assert.deepEqual(Object.keys(c).sort(), ["amountMinor", "currency", "decidedAt", "decidedOn", "decision", "item", "minorUnit", "property", "ticketId", "versionId"]);
  for (const excluded of [f.B2.version, f.D.version, f.E.version, f.F.version]) assert.ok(!page.rows.some(row => row.versionId === excluded));
  // Another owner of the same company sees only their own decision.
  assert.deepEqual((await list(owner2Sid)).rows.map(row => row.versionId), [f.F.version]);
});

test("OWN-35-AC1: keyset pages are stable, disjoint and complete; ties order by version; bad cursors are 22023", async () => {
  const all = (await list(ownerSid)).rows.map(row => row.versionId);
  const seen: string[] = []; let after: unknown = null; let pages = 0;
  do { const page = await list(ownerSid, after, 1); seen.push(...page.rows.map(row => row.versionId)); after = page.next; pages++; } while (after);
  assert.deepEqual(seen, all); assert.equal(pages, 3);
  const two = await list(ownerSid, null, 2);
  assert.equal(two.rows.length, 2); assert.deepEqual(two.next, { decidedAt: two.rows[1].decidedAt, versionId: two.rows[1].versionId });
  assert.deepEqual((await list(ownerSid, two.next, 2)).rows.map(row => row.versionId), [all[2]]);
  // Ties on decided_at: version id DESC, and a cursor inside the tie neither skips nor repeats.
  // Tickets and estimates go through svc() on other connections, so create them before this
  // connection's transaction (they could not see its uncommitted rows); only the decisions are rolled back.
  const x = await submit(xinyi, "tie x", 4000), y = await submit(xinyi, "tie y", 4000);
  await db.query("BEGIN");
  try {
    const at = "2001-01-01T00:00:00+00:00";
    for (const v of [x, y]) await db.query(`INSERT INTO app.b013_estimate_decisions(org_id,ticket_id,version_id,decision,decided_by,decided_at)
      VALUES($1,$2,$3,'approved',$4,$5)`, [ORG_ID, v.ticket, v.version, USERS.owner, at]);
    await db.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
    await db.query("SET LOCAL ROLE service_role");
    const read = async (cursor: unknown, limit: number) => (await db.query(`SELECT ${LIST.split("(")[0]}($1,$1,'live',$2,$3,$4) r`, [ORG_ID, ownerSid, cursor, limit])).rows[0].r as Page;
    const tail = (await read(null, 50)).rows.slice(-2).map(row => row.versionId);
    assert.deepEqual(tail, [x.version, y.version].sort().reverse());
    const first = await read({ decidedAt: at, versionId: tail[0] }, 50);
    assert.deepEqual(first.rows.map(row => row.versionId), [tail[1]]);
    for (const bad of [{ decidedAt: at }, { decidedAt: at, versionId: "x" }, { decidedAt: "infinity", versionId: tail[0] }, { decidedAt: at, versionId: tail[0], extra: 1 }, '"x"', { decidedAt: 1, versionId: tail[0] }]) {
      await db.query("SAVEPOINT bad"); await assert.rejects(read(bad, 5), { code: "22023" }); await db.query("ROLLBACK TO SAVEPOINT bad");
    }
  } finally { await db.query("ROLLBACK"); }
});

test("OWN-35-AC2/AC3: one ticket's decided versions with scope, reason and status; other owners and pending-only are NULL", async () => {
  const b = await one(ownerSid, f.B.ticket);
  assert.equal(b.ticketId, f.B.ticket); assert.equal(b.item, "B 門鎖"); assert.equal(b.status, "open");
  assert.deepEqual(b.versions.map((v: { versionId: string; versionNo: string; decision: string; reason: string | null; workScope: string }) =>
    [v.versionId, v.versionNo, v.decision, v.reason, v.workScope]), [[f.B.version, "1", "rejected", "請附兩家報價", "Synthetic scope 20000"]]);
  assert.equal((await one(ownerSid, f.A.ticket)).versions[0].reason, null);
  for (const [sid, id] of [[ownerSid, f.F.ticket], [ownerSid, f.D.ticket], [ownerSid, f.E.ticket], [ownerSid, randomUUID()], [owner2Sid, f.A.ticket]])
    assert.equal(await one(sid, id), null, `${sid} ${id}`);
  // Status is the repair's live progress.
  await db.query("BEGIN");
  try {
    await db.query("UPDATE public.maintenance_tickets SET status='in_progress' WHERE id=$1", [f.A.ticket]);
    await db.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
    await db.query("SET LOCAL ROLE service_role");
    assert.equal((await db.query(`SELECT (${ONE.split("(")[0]}($1,$1,'live',$2,$3))->>'status' s`, [ORG_ID, ownerSid, f.A.ticket])).rows[0].s, "in_progress");
  } finally { await db.query("ROLLBACK"); }
});

test("OWN-35-AC3: former owners lose the property (org-local date) and, with no authority left, get 403", async () => {
  const endXinyi = `UPDATE public.property_owners po SET effective_from=(clock_timestamp() AT TIME ZONE o.timezone)::date-30,
    effective_to=(clock_timestamp() AT TIME ZONE o.timezone)::date FROM public.organizations o
    WHERE po.org_id=o.id AND po.org_id=$1 AND po.property_id=$2`;
  // Savepoint per read: a denied call rolls back only itself, including its SET LOCAL ROLE.
  const read = async (fn: string, args: unknown[]) => {
    await db.query("SAVEPOINT r");
    try {
      await db.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
      await db.query("SET LOCAL ROLE service_role");
      const r = (await db.query(`SELECT ${fn} r`, args)).rows[0].r;
      await db.query("RESET ROLE"); await db.query("RELEASE SAVEPOINT r");
      return r;
    } catch (e) { await db.query("ROLLBACK TO SAVEPOINT r"); await db.query("RELEASE SAVEPOINT r"); throw e; }
  };
  await db.query("BEGIN");
  try {
    // Still owns 大安 today: the 信義 history disappears but the reader is admitted.
    await db.query(`INSERT INTO public.property_owners(org_id,property_id,owner_contact_id,effective_from)
      SELECT $1,$2,c.id,CURRENT_DATE-400 FROM public.contacts c WHERE c.org_id=$1 AND c.user_id=$3 AND c.is_owner`, [ORG_ID, daan, USERS.owner]);
    await db.query("UPDATE public.organizations SET timezone='Pacific/Kiritimati' WHERE id=$1", [ORG_ID]);
    await db.query(endXinyi, [ORG_ID, xinyi]);
    assert.deepEqual((await read(`${LIST.split("(")[0]}($1,$1,'live',$2,NULL,20)`, [ORG_ID, ownerSid])).rows, []);
    assert.equal(await read(`${ONE.split("(")[0]}($1,$1,'live',$2,$3)`, [ORG_ID, ownerSid, f.A.ticket]), null);
    // Owner2's own history is untouched by another owner's authority change.
    assert.equal((await read(`${LIST.split("(")[0]}($1,$1,'live',$2,NULL,20)`, [ORG_ID, owner2Sid])).rows.length, 1);
  } finally { await db.query("ROLLBACK"); }
  await db.query("BEGIN");
  try {
    await db.query(endXinyi, [ORG_ID, xinyi]);
    await assert.rejects(read(`${LIST.split("(")[0]}($1,$1,'live',$2,NULL,20)`, [ORG_ID, ownerSid]), { code: "42501" });
    await assert.rejects(read(`${ONE.split("(")[0]}($1,$1,'live',$2,$3)`, [ORG_ID, ownerSid, f.A.ticket]), { code: "42501" });
  } finally { await db.query("ROLLBACK"); }
  // Future-dated end keeps authority today (PR-015: effective_to is exclusive, org-local).
  await db.query("BEGIN");
  try {
    await db.query(`UPDATE public.property_owners po SET effective_to=(clock_timestamp() AT TIME ZONE o.timezone)::date+1
      FROM public.organizations o WHERE po.org_id=o.id AND po.org_id=$1 AND po.property_id=$2`, [ORG_ID, xinyi]);
    assert.equal((await read(`${LIST.split("(")[0]}($1,$1,'live',$2,NULL,20)`, [ORG_ID, ownerSid])).rows.length, 3);
  } finally { await db.query("ROLLBACK"); }
});

test("OWN-35-AC3: other companies, wrong pins, wrong live tuple and revoked sessions are 403; approvals OFF is empty", async () => {
  // Another company's admin session and this owner's session against another company.
  await assert.rejects(list(coastSid), code("42501"));
  await assert.rejects(list(ownerSid, null, 20, ORG2_ID, ORG2_ID, ORG2_ID), code("42501"));
  await assert.rejects(list(ownerSid, null, 20, ORG2_ID), code("42501"));
  await assert.rejects(one(ownerSid, f.A.ticket, ORG2_ID), code("42501"));
  // Org/env pins are required and must match the requested org; the live tuple must be real.
  await assert.rejects(list(ownerSid, null, 20, ORG_ID, null), code("42501"));
  await assert.rejects(list(ownerSid, null, 20, ORG_ID, ORG2_ID), code("42501"));
  await assert.rejects(list(ownerSid, null, 20, ORG_ID, ORG_ID, ORG2_ID), code("42501"));
  await assert.rejects(list(randomUUID()), code("42501"));
  await db.query("BEGIN");
  try {
    await db.query("UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [ownerSid]);
    await db.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
    await db.query("SET LOCAL ROLE service_role");
    await assert.rejects(db.query(`SELECT ${LIST.split("(")[0]}($1,$1,'live',$2,NULL,20)`, [ORG_ID, ownerSid]), { code: "42501" });
  } finally { await db.query("ROLLBACK"); }
  await db.query("BEGIN");
  try {
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags||'{\"repair_approvals\":false}'::jsonb WHERE id=$1", [ORG_ID]);
    await db.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
    await db.query("SET LOCAL ROLE service_role");
    assert.deepEqual((await db.query(`SELECT ${LIST.split("(")[0]}($1,$1,'live',$2,NULL,20) r`, [ORG_ID, ownerSid])).rows[0].r, { rows: [], next: null });
    assert.equal((await db.query(`SELECT ${ONE.split("(")[0]}($1,$1,'live',$2,$3) r`, [ORG_ID, ownerSid, f.A.ticket])).rows[0].r, null);
  } finally { await db.query("ROLLBACK"); }
});

test("OWN-35 TS reader end to end: same rows as the gateway, 403 for another owner's ticket, no writes", async () => {
  const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM app.b013_estimate_versions) v,(SELECT count(*) FROM app.b013_estimate_decisions) d,
    (SELECT count(*) FROM app.b013_repair_commands) c,(SELECT count(*) FROM app.b013_repair_event_outbox) o,
    (SELECT count(*) FROM public.audit_log) a,(SELECT md5(feature_flags::text) FROM public.organizations WHERE id=$1) f`, [ORG_ID])).rows[0];
  const before = await counts();
  const page = await ownerDecidedList(ownerSession());
  assert.equal(page.state, "ready");
  assert.deepEqual(page.state === "ready" && page.rows.map(row => row.versionId), [f.C.version, f.B.version, f.A.version]);
  const view = await ownerDecidedTicket(ownerSession(), f.B.ticket);
  assert.equal(view.state === "ready" && view.detail.versions[0].reason, "請附兩家報價");
  assert.deepEqual(await ownerDecidedTicket(ownerSession(), f.F.ticket), { state: "forbidden" });
  assert.deepEqual(await ownerDecidedTicket(ownerSession(owner2Sid, USERS.owner2), f.A.ticket), { state: "forbidden" });
  assert.deepEqual(await ownerDecidedList({ ...ownerSession(), orgId: ORG2_ID, liveOrgId: ORG2_ID }), { state: "off" });
  assert.deepEqual(await counts(), before);
});
