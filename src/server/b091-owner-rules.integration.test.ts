import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
import { ownerRulePayloadFingerprint, ownerRuleView, setOwnerRule, staffRuleChanges } from "./b091-owner-rules";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-091 OWN-RULE (OWN-34-AC3/AC4) on a cloned disposable database: the real gateways through service_role, and
// lock-wait races against real row-lock holders. Never a pg mock or a grant.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const SET = "app.b091_owner_rule_set(uuid,uuid,text,uuid,uuid,text,integer,text)";
const VIEW = "app.b091_owner_rule_view(uuid,uuid,text,uuid)";
const STAFF = "app.b091_staff_rule_changes(uuid,uuid,text,uuid,uuid,bigint,integer)";
const sid: Record<string, string> = {};
const v3 = async () => true;
let ownerContact: string, owner2Contact: string, tenantContact: string, foreignOwner: string;
type Result = Record<string, unknown> & { status: string };
type Opts = { org?: string; live?: string; env?: string; pin?: string | null; pinEnv?: string | null; lockTimeout?: string };
const code = (c: string) => (e: unknown) => ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === c;

async function flag(platform: boolean, org = platform) {
  await db.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text,$3::text)) WHERE key='owner_rules'`, [platform, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('owner_rules',$2::boolean) WHERE id = ANY($1::uuid[])`, [[ORG_ID, ORG2_ID], org]);
}
async function call<T>(fn: string, who: string, args: unknown[], opts: Opts = {}): Promise<T> {
  const org = opts.org ?? ORG_ID, env = opts.env ?? "live";
  return svc(null, async client => {
    await client.query(`SET LOCAL lock_timeout = '${opts.lockTimeout ?? "10s"}'`);
    if (opts.pin !== null) await client.query("SELECT set_config('app.active_org_id',$1,true)", [opts.pin ?? org]);
    if (opts.pinEnv !== null) await client.query("SELECT set_config('app.env',$1,true)", [opts.pinEnv ?? env]);
    const params = args.map((_, i) => `$${i + 5}`).join(",");
    return (await client.query(`SELECT ${fn.split("(")[0]}($1,$2,$3,$4${params ? "," + params : ""}) r`, [org, opts.live ?? org, env, sid[who], ...args])).rows[0].r;
  }, { isolation: "read committed" });
}
/** Direct gateway call; the payload fingerprint defaults to the one setOwnerRule computes for these raw values. */
const set = (who: string, rule: string | null, expected: number | null, request = randomUUID(), opts: Opts & { fingerprint?: string } = {}) =>
  call<Result>(SET, who, [request, rule, expected, ("fingerprint" in opts ? opts.fingerprint : ownerRulePayloadFingerprint({ rule, expectedRevision: expected }))], opts);
const view = (who: string, opts: Opts = {}) => call<Record<string, unknown> | null>(VIEW, who, [], opts);
const staff = (who: string, contact: string | null = null, opts: Opts = {}) => call<Record<string, unknown> | null>(STAFF, who, [contact, null, 20], opts);
const snapshot = async () => (await db.query(`SELECT
  (SELECT md5(coalesce(string_agg(row_to_json(r)::text,'|' ORDER BY r.seq),'')) FROM app.b091_owner_rule_revisions r) revisions,
  (SELECT md5(coalesce(string_agg(row_to_json(c)::text,'|' ORDER BY c.org_id,c.request_id),'')) FROM app.b091_owner_rule_commands c) commands,
  (SELECT md5(coalesce(string_agg(row_to_json(a)::text,'|' ORDER BY a.id),'')) FROM public.audit_log a WHERE a.table_name='b091_owner_rule_revisions') audit`)).rows[0];
async function unchanged(label: string, fn: () => Promise<unknown>) { const before = await snapshot(); await fn(); assert.deepEqual(await snapshot(), before, label); }
const owner = (who: "owner" | "owner2", org = ORG_ID): Session => ({ kind: "owner", role: null, orgId: org, liveOrgId: org, userId: USERS[who], sessionId: sid[who],
  name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });
const staffSession = (who: keyof typeof USERS, role: Session["role"], org = ORG_ID): Session => ({ kind: "staff", role, orgId: org, liveOrgId: org, userId: USERS[who],
  sessionId: sid[who], name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });
const current = async (contact: string) => (await db.query("SELECT coalesce(max(revision),0)::int r FROM app.b091_owner_rule_revisions WHERE owner_contact_id=$1", [contact])).rows[0].r as number;
/** Resolve once another backend is waiting on a lock held by `holder`. */
async function waitForBlocked(holder: Client) {
  const pid = (await holder.query("SELECT pg_backend_pid() p")).rows[0].p;
  for (let i = 0; i < 100; i++) {
    const n = (await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid])).rows[0].n;
    if (n > 0) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail("no waiter appeared");
}
const holders: Client[] = [];
/** A real lock holder in its own transaction; every holder is closed in test.after, so a failed step cannot hang the file. */
async function holder() { const c = new Client({ connectionString: process.env.DATABASE_URL }); holders.push(c); await c.connect(); await c.query("BEGIN"); return c; }
/** A login with no contact anywhere: an actor that owns nothing until a fixture gives it a contact. */
async function freshUser(who: string) {
  const user = randomUUID();
  await db.query("INSERT INTO auth.users(id) VALUES ($1)", [user]);
  await session(who, user);
  return user;
}
async function session(who: string, user: string) {
  sid[who] = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid[who], user, randomUUID()]);
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
  for (const who of Object.keys(USERS)) await session(who, USERS[who as keyof typeof USERS]);
  sid.revoked = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours',clock_timestamp())", [sid.revoked, USERS.owner, randomUUID()]);
  const contactOf = async (user: string) => (await db.query("SELECT id FROM public.contacts WHERE org_id=$1 AND user_id=$2 AND is_owner", [ORG_ID, user])).rows[0].id as string;
  ownerContact = await contactOf(USERS.owner); owner2Contact = await contactOf(USERS.owner2);
  tenantContact = (await db.query("SELECT id FROM public.contacts WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.tenant])).rows[0].id;
  foreignOwner = (await db.query(`INSERT INTO public.contacts(org_id,is_owner,display_name) VALUES($1,true,'Coast Owner') RETURNING id`, [ORG2_ID])).rows[0].id;
});

test.after(async () => {
  try { for (const h of holders) await h.end().catch(() => undefined); if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("privileges: gateways EXECUTE for service_role only; the tables and the sequence have no application privilege; seeded OFF", async () => {
  for (const fn of [SET, VIEW, STAFF]) {
    for (const role of ["anon", "authenticated", "service_role"])
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok, role === "service_role", `${role} ${fn}`);
    assert.deepEqual((await db.query("SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [fn])).rows[0],
      { prosecdef: true, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"] });
    for (const role of ["anon", "authenticated"]) {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        const nulls = fn.slice(fn.indexOf("(") + 1, -1).split(",").map(t => `NULL::${t}`).join(",");
        await assert.rejects(db.query(`SELECT ${fn.split("(")[0]}(${nulls})`), { code: "42501" });
      } finally { await db.query("ROLLBACK"); }
    }
  }
  for (const table of ["app.b091_owner_rule_revisions", "app.b091_owner_rule_commands"]) {
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [table])).rows[0].relrowsecurity, true);
    for (const role of ["anon", "authenticated", "service_role"])
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
        assert.equal((await db.query("SELECT has_table_privilege($1,$2,$3) ok", [role, table, privilege])).rows[0].ok, false, `${role} ${privilege} ${table}`);
  }
  for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await db.query("SELECT has_sequence_privilege($1,'app.b091_owner_rule_revisions_seq_seq','USAGE,SELECT,UPDATE') ok", [role])).rows[0].ok, false);
  assert.deepEqual((await db.query("SELECT value FROM public.platform_settings WHERE key='owner_rules'")).rows[0].value, { enabled: false, allowed_org_ids: [] });
});

test("flag OFF (platform, org, both) and brand_v3 OFF: nothing readable, nothing written", async () => {
  for (const [platform, org] of [[false, false], [false, true], [true, false]] as const) {
    await flag(platform, org);
    await unchanged(`platform ${platform} org ${org}`, async () => {
      assert.equal(await view("owner"), null);
      assert.deepEqual(await set("owner", "ask_every_time", 0), { status: "disabled" });
      assert.equal(await staff("admin"), null);
      assert.deepEqual(await ownerRuleView(owner("owner"), { v3 }), { state: "off" });
      assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: randomUUID(), rule: "ask_every_time", expectedRevision: 0 }, { v3 }), { ok: false, reason: "off" });
      assert.deepEqual(await staffRuleChanges(staffSession("admin", "admin"), {}, { v3 }), { state: "off" });
    });
  }
  await flag(true);
  const never = (async () => { throw new Error("no transaction expected"); }) as never;
  await unchanged("brand_v3 off", async () => {
    assert.deepEqual(await ownerRuleView(owner("owner"), { v3: async () => false, transaction: never }), { state: "off" });
    assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: randomUUID(), rule: "ask_every_time", expectedRevision: 0 }, { v3: async () => false, transaction: never }), { ok: false, reason: "off" });
    assert.deepEqual(await staffRuleChanges(staffSession("admin", "admin"), {}, { v3: async () => false, transaction: never }), { state: "off" });
  });
});

test("OWN-34-AC3/AC4: default rule; the owner changes it; audited; staff see it on the owner and in the change log; owners never see each other's", async () => {
  await flag(true);
  assert.deepEqual(await view("owner"), { rule: "delegate_notify", revision: 0, changedAt: null });
  const request = randomUUID();
  assert.deepEqual(await set("owner", "delegate_unless_lower", 0, request), { status: "saved", rule: "delegate_unless_lower", revision: 1, replayed: false });
  const v = await view("owner");
  assert.equal(v!.rule, "delegate_unless_lower"); assert.equal(v!.revision, 1); assert.ok(v!.changedAt);
  assert.deepEqual(await view("owner2"), { rule: "delegate_notify", revision: 0, changedAt: null }, "owner2 keeps their own default");
  const rev = (await db.query("SELECT * FROM app.b091_owner_rule_revisions WHERE request_id=$1", [request])).rows[0];
  assert.deepEqual([rev.owner_contact_id, rev.renewal_rule, rev.previous_rule, rev.revision, rev.created_by], [ownerContact, "delegate_unless_lower", "delegate_notify", 1, USERS.owner]);
  const audit = (await db.query("SELECT actor_user_id,actor_role,action::text,event_type,reason,request_id,old_row,new_row FROM public.audit_log WHERE table_name='b091_owner_rule_revisions' AND row_id=$1", [rev.id])).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor_user_id, audit[0].actor_role, audit[0].action, audit[0].event_type, audit[0].request_id], [USERS.owner, "owner", "insert", "owner_rule_changed", request]);
  assert.deepEqual([audit[0].old_row.renewal_rule, audit[0].new_row.renewal_rule], ["delegate_notify", "delegate_unless_lower"]);
  // Staff: the owner's page and the org-wide change log (the in-app notice feed); accountant may read.
  for (const who of ["admin", "manager", "accountant"]) {
    const s = await staff(who, ownerContact);
    assert.equal((s!.owner as Record<string, unknown>).rule, "delegate_unless_lower");
    assert.deepEqual((s!.changes as Record<string, unknown>[]).map(c => [c.ownerContactId, c.rule, c.previousRule]), [[ownerContact, "delegate_unless_lower", "delegate_notify"]]);
  }
  const owner2Page = await staff("admin", owner2Contact);
  assert.deepEqual([(owner2Page!.owner as Record<string, unknown>).rule, owner2Page!.changes], ["delegate_notify", []]);
  // The TS layer: owner sees and sets their own; staff read.
  const ts = await setOwnerRule(owner("owner2"), { requestId: randomUUID(), rule: "ask_every_time", expectedRevision: 0 }, { v3 });
  assert.deepEqual(ts, { ok: true, rule: "ask_every_time", revision: 1, changed: true, replayed: false });
  assert.deepEqual(await ownerRuleView(owner("owner"), { v3 }), { state: "ready", ...(await view("owner")) as object });
  const log = await staffRuleChanges(staffSession("manager", "manager"), {}, { v3 });
  if (log.state !== "ready") assert.fail(log.state);
  assert.deepEqual(log.changes.map(c => c.ownerContactId), [owner2Contact, ownerContact], "newest first");
  assert.equal((await view("owner"))!.rule, "delegate_unless_lower", "owner2's change never touched owner's rule");
});

test("idempotency: every request id is reserved with its outcome; replay; conflict; stale; unchanged; invalid; no writes", async () => {
  await flag(true);
  const r = await current(ownerContact);
  const request = randomUUID();
  const saved = await set("owner", "ask_every_time", r, request);
  assert.deepEqual(saved, { status: "saved", rule: "ask_every_time", revision: r + 1, replayed: false });
  const command = async (id: string) => (await db.query("SELECT md5(row_to_json(c)::text) h FROM app.b091_owner_rule_commands c WHERE request_id=$1", [id])).rows[0]?.h as string;
  const savedCommand = await command(request);
  await unchanged("replay and payload conflicts", async () => {
    assert.deepEqual(await set("owner", "ask_every_time", r, request), { ...saved, replayed: true });
    assert.deepEqual(await set("owner", "delegate_notify", r, request), { status: "conflict" });
    assert.deepEqual(await set("owner", "ask_every_time", r + 1, request), { status: "conflict" });
  });
  // Stale (expected revision behind) and unchanged (same rule): reserved, no revision and no audit written.
  const staleId = randomUUID(), unchangedId = randomUUID(), invalidId = randomUUID();
  let before = await snapshot();
  assert.deepEqual(await set("owner", "delegate_notify", r, staleId), { status: "stale", rule: "ask_every_time", revision: r + 1, replayed: false });
  assert.deepEqual(await set("owner", "ask_every_time", r + 1, unchangedId), { status: "unchanged", rule: "ask_every_time", revision: r + 1, replayed: false });
  // Invalid payload (a request id is usable): reserved with outcome invalid; corrected input under it is a conflict.
  assert.deepEqual(await set("owner", "sometimes", r + 1, invalidId), { status: "invalid", replayed: false });
  assert.deepEqual(await set("owner", null, r + 1, randomUUID()), { status: "invalid", replayed: false });
  let after = await snapshot();
  assert.deepEqual([after.revisions, after.audit], [before.revisions, before.audit], "stale, unchanged and invalid write no revision or audit");
  assert.notEqual(after.commands, before.commands, "but their ids are reserved");
  const reserved = { stale: await command(staleId), unchanged: await command(unchangedId), invalid: await command(invalidId) };
  await unchanged("corrected input under a reserved invalid id", async () => {
    assert.deepEqual(await set("owner", "delegate_notify", r + 1, invalidId), { status: "conflict" });
    assert.deepEqual(await set("owner", "sometimes", r + 1, invalidId), { status: "invalid", replayed: true });
  });
  // A later change really saves (outcome and new revision) ...
  const later = await set("owner", "delegate_notify", r + 1);
  assert.deepEqual(later, { status: "saved", rule: "delegate_notify", revision: r + 2, replayed: false });
  // ... and afterwards every reserved id still answers exactly what it answered first, writing nothing.
  before = await snapshot();
  assert.deepEqual(await set("owner", "ask_every_time", r, request), { ...saved, replayed: true });
  assert.deepEqual(await set("owner", "delegate_notify", r, staleId), { status: "stale", rule: "ask_every_time", revision: r + 1, replayed: true });
  assert.deepEqual(await set("owner", "ask_every_time", r + 1, unchangedId), { status: "unchanged", rule: "ask_every_time", revision: r + 1, replayed: true });
  assert.deepEqual(await set("owner", "sometimes", r + 1, invalidId), { status: "invalid", replayed: true });
  after = await snapshot();
  assert.deepEqual(after, before, "replays write nothing");
  assert.deepEqual({ saved: await command(request), stale: await command(staleId), unchanged: await command(unchangedId), invalid: await command(invalidId) },
    { saved: savedCommand, ...reserved }, "reserved commands are immutable");
  const outcomes = (await db.query("SELECT outcome FROM app.b091_owner_rule_commands WHERE request_id = ANY($1::uuid[]) ORDER BY outcome", [[request, staleId, unchangedId, invalidId]])).rows.map(x => x.outcome);
  assert.deepEqual(outcomes, ["invalid", "saved", "stale", "unchanged"]);
  // TS: a valid id with an invalid rule reaches the gateway and is reserved too.
  const tsId = randomUUID();
  assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: tsId, rule: "x", expectedRevision: r + 2 }, { v3 }), { ok: false, reason: "invalid" });
  assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: tsId, rule: "ask_every_time", expectedRevision: r + 2 }, { v3 }), { ok: false, reason: "conflict" });
});

test("a valid id with an invalid expected revision: reserved invalid, replays the same, any other payload under it (another invalid one or the corrected one) is a conflict; nothing written", async () => {
  await flag(true);
  const r = await current(ownerContact);
  const rule = (await view("owner"))!.rule === "ask_every_time" ? "delegate_notify" : "ask_every_time";
  const id = randomUUID();
  const commandOf = async () => (await db.query("SELECT outcome,requested_rule,expected_revision,payload_fingerprint,md5(row_to_json(c)::text) h FROM app.b091_owner_rule_commands c WHERE request_id=$1", [id])).rows;
  const before = await snapshot();
  assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: id, rule, expectedRevision: -1 }, { v3 }), { ok: false, reason: "invalid" });
  const reserved = await commandOf();
  assert.equal(reserved.length, 1);
  assert.deepEqual([reserved[0].outcome, reserved[0].requested_rule, reserved[0].expected_revision], ["invalid", rule, null], "reserved invalid (the bad revision normalises to NULL)");
  const after = await snapshot();
  assert.deepEqual([after.revisions, after.audit], [before.revisions, before.audit], "no revision, no audit");
  await unchanged("replays and conflicts under the reserved id", async () => {
    // The same raw payload replays the same answer.
    assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: id, rule, expectedRevision: -1 }, { v3 }), { ok: false, reason: "invalid" });
    assert.deepEqual(await set("owner", rule, null, id, { fingerprint: ownerRulePayloadFingerprint({ rule, expectedRevision: -1 }) }), { status: "invalid", replayed: true });
    // Other invalid payloads that normalise to the same NULL are conflicts, not replays.
    for (const bad of [-2, 1.5, 2147483648, Number.NaN, "1", null, undefined])
      assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: id, rule, expectedRevision: bad as never }, { v3 }), { ok: false, reason: "conflict" }, String(bad));
    // The corrected input is a conflict too.
    assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: id, rule, expectedRevision: r }, { v3 }), { ok: false, reason: "conflict" });
  });
  assert.deepEqual(await commandOf(), reserved, "the reserved command is immutable");
  // Two different over-long rules normalise to the same NULL: the second is a conflict (TS fingerprint) ...
  const longId = randomUUID();
  assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: longId, rule: "x".repeat(65), expectedRevision: r }, { v3 }), { ok: false, reason: "invalid" });
  await unchanged("over-long rules", async () => {
    assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: longId, rule: "x".repeat(65), expectedRevision: r }, { v3 }), { ok: false, reason: "invalid" });
    assert.deepEqual(await setOwnerRule(owner("owner"), { requestId: longId, rule: "y".repeat(65), expectedRevision: r }, { v3 }), { ok: false, reason: "conflict" });
  });
  // ... and the gateway's own normalisation is protected as well: the same caller fingerprint with another raw
  // over-long rule text is a conflict.
  const gwId = randomUUID(), fp = ownerRulePayloadFingerprint({ rule: "opaque", expectedRevision: r });
  assert.deepEqual(await set("owner", "a".repeat(80), r, gwId, { fingerprint: fp }), { status: "invalid", replayed: false });
  await unchanged("gateway normalisation", async () => {
    assert.deepEqual(await set("owner", "a".repeat(80), r, gwId, { fingerprint: fp }), { status: "invalid", replayed: true });
    assert.deepEqual(await set("owner", "b".repeat(80), r, gwId, { fingerprint: fp }), { status: "conflict" });
    assert.deepEqual(await set("owner", "a".repeat(80), r, gwId, { fingerprint: "0".repeat(64) }), { status: "conflict" });
  });
  // A missing or malformed fingerprint is refused before anything is reserved.
  await unchanged("fingerprint required", async () => {
    for (const bad of [null, "", "XYZ", "A".repeat(64)]) await assert.rejects(set("owner", rule, r, randomUUID(), { fingerprint: bad as never }), code("22023"), String(bad));
  });
  assert.equal(await current(ownerContact), r, "nothing saved by any of these");
});

test("conflict on the actor alone and on the owner contact alone", async () => {
  await flag(true);
  const r = await current(ownerContact);
  const request = randomUUID();
  assert.equal((await set("owner", r % 2 ? "ask_every_time" : "delegate_unless_lower", r, request)).status, "saved");
  const payload = (await db.query("SELECT requested_rule,expected_revision FROM app.b091_owner_rule_commands WHERE request_id=$1", [request])).rows[0];
  // Only the actor changes: the same owner contact now belongs to another user.
  const other = await freshUser("other");
  await db.query("UPDATE public.contacts SET user_id=$2 WHERE id=$1", [ownerContact, other]);
  try {
    await unchanged("actor only", async () => assert.deepEqual(await set("other", payload.requested_rule, payload.expected_revision, request), { status: "conflict" }));
  } finally { await db.query("UPDATE public.contacts SET user_id=$2 WHERE id=$1", [ownerContact, USERS.owner]); }
  // Only the owner contact changes: the same user now owns through another contact (the old one archived, so it is
  // no longer a current owner; one active owner contact per user per company is a schema rule).
  const property = (await db.query("SELECT property_id,effective_from FROM public.property_owners WHERE owner_contact_id=$1 ORDER BY id LIMIT 1", [ownerContact])).rows[0];
  await db.query("UPDATE public.contacts SET archived_at=clock_timestamp() WHERE id=$1", [ownerContact]);
  const replacement = (await db.query(`INSERT INTO public.contacts(org_id,user_id,is_owner,display_name) VALUES($1,$2,true,'陳建宏（新）') RETURNING id`, [ORG_ID, USERS.owner])).rows[0].id;
  await db.query(`INSERT INTO public.property_owners(org_id,property_id,owner_contact_id,is_primary,effective_from) VALUES($1,$2,$3,false,$4)`,
    [ORG_ID, property.property_id, replacement, property.effective_from]);
  try {
    assert.ok(await view("owner"), "the same actor is admitted through the replacement contact");
    await unchanged("owner contact only", async () => assert.deepEqual(await set("owner", payload.requested_rule, payload.expected_revision, request), { status: "conflict" }));
  } finally {
    await db.query("DELETE FROM public.property_owners WHERE owner_contact_id=$1", [replacement]);
    await db.query("DELETE FROM public.contacts WHERE id=$1", [replacement]);
    await db.query("UPDATE public.contacts SET archived_at=NULL WHERE id=$1", [ownerContact]);
  }
  assert.deepEqual(await set("owner", payload.requested_rule, payload.expected_revision, request), { status: "saved", rule: payload.requested_rule, revision: r + 1, replayed: true }, "positive control");
});

test("two current-owner contacts for one user in one company: set and view are refused, nothing written", async () => {
  await flag(true);
  // The schema already refuses a second active owner contact for one login in one company ...
  await assert.rejects(db.query(`INSERT INTO public.contacts(org_id,user_id,is_owner,display_name) VALUES($1,$2,true,'第二個屋主身分')`, [ORG_ID, USERS.owner2]), code("23505"));
  // ... so, in this disposable clone only, lift that index to prove the gateways refuse the ambiguity on their own.
  const index = (await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='contacts_org_user_owner_uniq'")).rows[0].indexdef as string;
  await db.query("DROP INDEX public.contacts_org_user_owner_uniq");
  let second: string | undefined;
  try {
    second = (await db.query(`INSERT INTO public.contacts(org_id,user_id,is_owner,display_name) VALUES($1,$2,true,'第二個屋主身分') RETURNING id`, [ORG_ID, USERS.owner2])).rows[0].id;
    const property = (await db.query("SELECT property_id,effective_from FROM public.property_owners WHERE owner_contact_id=$1 ORDER BY id LIMIT 1", [owner2Contact])).rows[0];
    await db.query(`INSERT INTO public.property_owners(org_id,property_id,owner_contact_id,is_primary,effective_from) VALUES($1,$2,$3,false,$4)`, [ORG_ID, property.property_id, second, property.effective_from]);
    await unchanged("ambiguous owner", async () => {
      await assert.rejects(set("owner2", "delegate_unless_lower", await current(owner2Contact)), code("42501"));
      await assert.rejects(view("owner2"), code("42501"));
      assert.deepEqual(await setOwnerRule(owner("owner2"), { requestId: randomUUID(), rule: "delegate_unless_lower", expectedRevision: 0 }, { v3 }), { ok: false, reason: "forbidden" });
    });
  } finally {
    if (second) {
      await db.query("DELETE FROM public.property_owners WHERE owner_contact_id=$1", [second]);
      await db.query("DELETE FROM public.contacts WHERE id=$1", [second]);
    }
    await db.query(index);
  }
  assert.ok(await view("owner2"), "positive control");
});

test("staff change logs are isolated between companies in both directions; a revoked staff session alone is refused", async () => {
  await flag(true);
  // A revision in the other company (its own owner contact), written directly as a fixture.
  await db.query(`INSERT INTO app.b091_owner_rule_revisions(org_id,owner_contact_id,revision,renewal_rule,previous_rule,request_id,created_by)
    VALUES($1,$2,1,'ask_every_time','delegate_notify',$3,$4)`, [ORG2_ID, foreignOwner, randomUUID(), USERS.coastAdmin]);
  assert.ok((await current(ownerContact)) > 0, "this company has revisions too");
  const mine = await staff("admin"), theirs = await staff("coastAdmin", null, { org: ORG2_ID });
  const ids = (page: Record<string, unknown> | null) => (page!.changes as { ownerContactId: string }[]).map(c => c.ownerContactId);
  assert.ok(ids(mine).length > 0 && !ids(mine).includes(foreignOwner));
  assert.deepEqual(ids(theirs), [foreignOwner]);
  assert.ok(!ids(theirs).includes(ownerContact) && !ids(theirs).includes(owner2Contact));
  await assert.rejects(staff("coastAdmin", foreignOwner), code("42501"), "the other company's owner via this company");
  await assert.rejects(staff("admin", foreignOwner, { org: ORG2_ID }), code("42501"), "this company's admin via the other company");
  // An otherwise admitted staff session: works, then refused after revocation alone.
  await session("admin2", USERS.admin);
  assert.ok(await staff("admin2", ownerContact));
  await db.query("UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [sid.admin2]);
  await assert.rejects(staff("admin2", ownerContact), code("42501"));
  assert.deepEqual(await staffRuleChanges({ ...staffSession("admin", "admin"), sessionId: sid.admin2 }, {}, { v3 }), { state: "forbidden" });
});

test("denials: anon (ACL), cross-org, non-owners, revoked session, former owner, tuple and app.env; staff role and contact gates; no writes", async () => {
  await flag(true);
  await unchanged("denials", async () => {
    for (const who of ["tenant", "admin", "manager", "maintenance", "revoked", "coastAdmin"]) {
      await assert.rejects(set(who, "ask_every_time", 0), code("42501"), `${who} set`);
      await assert.rejects(view(who), code("42501"), `${who} view`);
    }
    // Cross-org: the owner has no current property in the other company.
    await assert.rejects(set("owner", "ask_every_time", 0, randomUUID(), { org: ORG2_ID }), code("42501"));
    await assert.rejects(view("owner", { org: ORG2_ID }), code("42501"));
    for (const [label, opts] of [["env", { env: "sandbox" }], ["live", { live: ORG2_ID }], ["org pin", { pin: ORG2_ID }], ["no org pin", { pin: null }],
      ["app.env mismatch", { pinEnv: "sandbox" }], ["app.env missing", { pinEnv: null }]] as [string, Opts][]) {
      await assert.rejects(set("owner", "ask_every_time", 0, randomUUID(), opts), code("42501"), `set ${label}`);
      await assert.rejects(view("owner", opts), code("42501"), `view ${label}`);
      await assert.rejects(staff("admin", null, opts), code("42501"), `staff ${label}`);
    }
    for (const who of ["maintenance", "tenant", "owner", "revoked", "coastAdmin"]) await assert.rejects(staff(who), code("42501"), `staff ${who}`);
    await assert.rejects(staff("admin", tenantContact), code("42501"), "a non-owner contact");
    await assert.rejects(staff("admin", foreignOwner), code("42501"), "another company's owner");
    await assert.rejects(staff("admin", randomUUID()), code("42501"), "missing contact");
    await assert.rejects(staff("coastAdmin", ownerContact, { org: ORG2_ID }), code("42501"), "this org's owner via another org");
    assert.deepEqual(await staffRuleChanges(staffSession("maintenance", "maintenance"), {}, { v3 }), { state: "forbidden" });
    assert.deepEqual(await setOwnerRule({ ...owner("owner"), sessionId: sid.revoked }, { requestId: randomUUID(), rule: "ask_every_time", expectedRevision: 0 }, { v3 }), { ok: false, reason: "forbidden" });
    assert.deepEqual(await ownerRuleView(staffSession("admin", "admin"), { v3 }), { state: "forbidden" });
  });
  // A former owner (ownership ended) is no longer admitted.
  const po = (await db.query("SELECT id,effective_to FROM public.property_owners WHERE owner_contact_id=$1", [owner2Contact])).rows;
  await db.query("UPDATE public.property_owners SET effective_to=effective_from WHERE owner_contact_id=$1", [owner2Contact]);
  try {
    await unchanged("former owner", async () => {
      await assert.rejects(set("owner2", "ask_every_time", 1), code("42501"));
      await assert.rejects(view("owner2"), code("42501"));
    });
  } finally {
    for (const row of po) await db.query("UPDATE public.property_owners SET effective_to=$2 WHERE id=$1", [row.id, row.effective_to]);
  }
});

test("lock-wait races: a session revoked, an ownership ended or the flag turned off while waiting refuses; concurrent writers serialise", async () => {
  await flag(true);
  // 1. Session revoked by a real row-lock holder while the writer waits on it.
  await session("raceA", USERS.owner);
  let h = await holder();
  await h.query("UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [sid.raceA]);
  let before = await snapshot();
  let pending: Promise<unknown> = set("raceA", "ask_every_time", await current(ownerContact)).then(r => r, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.ok(code("42501")(await pending), "revoked while waiting");
  assert.deepEqual(await snapshot(), before);
  // 2. Ownership ended while the writer waits on property_owners.
  const po = (await db.query("SELECT id,effective_to FROM public.property_owners WHERE owner_contact_id=$1", [ownerContact])).rows;
  h = await holder();
  await h.query("UPDATE public.property_owners SET effective_to=effective_from WHERE owner_contact_id=$1", [ownerContact]);
  before = await snapshot();
  pending = set("owner", "ask_every_time", await current(ownerContact)).then(r => r, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.ok(code("42501")(await pending), "ownership ended while waiting");
  assert.deepEqual(await snapshot(), before);
  for (const row of po) await db.query("UPDATE public.property_owners SET effective_to=$2 WHERE id=$1", [row.id, row.effective_to]);
  // 3. The flag turned off while the writer waits on the setting row.
  h = await holder();
  await h.query("UPDATE public.platform_settings SET value=jsonb_set(value,'{enabled}','false') WHERE key='owner_rules'");
  before = await snapshot();
  pending = set("owner", "ask_every_time", await current(ownerContact)).then(r => r, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.deepEqual(await pending, { status: "disabled" });
  assert.deepEqual(await snapshot(), before);
  await flag(true);
  // 4. Two writers for the same owner, on two different sessions of that owner, with the same expected revision:
  //    nothing else they share is locked exclusively, so the second waits on the first's contact row lock only, then
  //    answers stale; nothing is lost or duplicated. The first writer's transaction always closes.
  const r = await current(ownerContact);
  await session("ownerSecond", USERS.owner);
  const first = await holder();
  let firstResult: Result;
  try {
    await first.query("SET LOCAL ROLE service_role");
    await first.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [ORG_ID]);
    const firstRule = r % 2 ? "ask_every_time" : "delegate_unless_lower";
    firstResult = (await first.query(`SELECT ${SET.split("(")[0]}($1,$1,'live',$2,$3,$4,$5,$6) r`,
      [ORG_ID, sid.owner, randomUUID(), firstRule, r, ownerRulePayloadFingerprint({ rule: firstRule, expectedRevision: r })])).rows[0].r;
    assert.equal(firstResult.status, "saved");
    pending = setOwnerRule({ ...owner("owner"), sessionId: sid.ownerSecond }, { requestId: randomUUID(), rule: "delegate_notify", expectedRevision: r }, { v3 }).then(x => x, e => e);
    await waitForBlocked(first);
    // The waiter is queued on a row lock (the contact row; the sessions differ, and FOR SHARE never blocks FOR SHARE).
    const waiting = (await db.query(`SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [(await first.query("SELECT pg_backend_pid() p")).rows[0].p])).rows;
    assert.deepEqual(waiting.map(w => w.wait_event_type), ["Lock"]);
    assert.ok(["transactionid", "tuple"].includes(waiting[0].wait_event), waiting[0].wait_event);
    await first.query("COMMIT");
  } finally { await first.end(); }
  assert.deepEqual(await pending, { ok: false, reason: "stale", rule: firstResult.rule, revision: r + 1 });
  assert.equal(await current(ownerContact), r + 1);
  // 5. Negative control: a holder that commits without changing anything lets the waiting writer save.
  h = await holder();
  await h.query("SELECT 1 FROM public.contacts WHERE id=$1 FOR UPDATE", [ownerContact]);
  pending = set("owner", firstResult.rule === "ask_every_time" ? "delegate_notify" : "ask_every_time", r + 1).then(x => x, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.equal((await pending as Result).status, "saved");
});

test("contact-row races: a holder on the owner contact (FOR UPDATE) archives it, a contact moved to an actor with none, an ownership added to the locked contact, or a contact joining the locked set during the wait → refused, no writes; positive controls", async () => {
  await flag(true);
  // 1. The holder sits on the contact row itself (not the session or org rows) and archives the contact.
  let h = await holder();
  await h.query("UPDATE public.contacts SET archived_at=clock_timestamp() WHERE id=$1", [ownerContact]);
  let before = await snapshot();
  let pending: Promise<unknown> = set("owner", "ask_every_time", await current(ownerContact), randomUUID(), { lockTimeout: "5s" }).then(r => r, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.ok(code("42501")(await pending), "the archived contact is no longer an owner");
  assert.deepEqual(await snapshot(), before);
  await db.query("UPDATE public.contacts SET archived_at=NULL WHERE id=$1", [ownerContact]);
  // Positive control: the same holder that commits without a change → the waiting writer saves (serialised).
  h = await holder();
  await h.query("UPDATE public.contacts SET display_name=display_name WHERE id=$1", [ownerContact]);
  const r = await current(ownerContact), current0 = (await view("owner"))!.rule;
  pending = set("owner", current0 === "ask_every_time" ? "delegate_notify" : "ask_every_time", r, randomUUID(), { lockTimeout: "5s" }).then(x => x, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.equal((await pending as Result).status, "saved");
  // 2. No locked contact at first: an actor who owns nothing; during its wait (on the flag row, after the contact
  //    locks), a holder moves a current-owner contact to this actor. The locked set ({}) no longer equals the current
  //    set → refused, nothing written.
  const newOwner = await freshUser("newOwner");
  h = await holder();
  await h.query("UPDATE public.contacts SET user_id=$2 WHERE id=$1", [owner2Contact, newOwner]);
  await h.query("UPDATE public.platform_settings SET value=value WHERE key='owner_rules'");
  before = await snapshot();
  pending = set("newOwner", "ask_every_time", await current(owner2Contact), randomUUID(), { lockTimeout: "5s" }).then(x => x, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.ok(code("42501")(await pending), "a contact moved to the actor during the wait is not admitted");
  assert.deepEqual(await snapshot(), before);
  // Positive control: once committed (no wait), the same actor is admitted on the contact it now locks.
  const after = await set("newOwner", "ask_every_time", await current(owner2Contact), randomUUID(), { lockTimeout: "5s" });
  assert.ok(["saved", "unchanged"].includes(after.status));
  await db.query("UPDATE public.contacts SET user_id=$2 WHERE id=$1", [owner2Contact, USERS.owner2]);
  // 3. Any change to a locked contact's ownership set takes a key-share lock on that contact row (the foreign key),
  //    which conflicts with the writer's FOR UPDATE. A holder adding an ownership therefore serialises the writer
  //    behind it: after the wait the writer is admitted on the committed set (two ownerships) and saves once.
  const mine = (await db.query("SELECT property_id,effective_from FROM public.property_owners WHERE owner_contact_id=$1 ORDER BY id LIMIT 1", [ownerContact])).rows[0];
  const otherProperty = (await db.query("SELECT id FROM public.properties WHERE org_id=$1 AND archived_at IS NULL AND id NOT IN (SELECT property_id FROM public.property_owners WHERE owner_contact_id=$2) ORDER BY id LIMIT 1", [ORG_ID, ownerContact])).rows[0].id;
  h = await holder();
  await h.query(`INSERT INTO public.property_owners(org_id,property_id,owner_contact_id,is_primary,effective_from) VALUES($1,$2,$3,false,$4)`, [ORG_ID, otherProperty, ownerContact, mine.effective_from]);
  const rev = await current(ownerContact), rule = (await view("owner"))!.rule === "ask_every_time" ? "delegate_notify" : "ask_every_time";
  pending = set("owner", rule, rev, randomUUID(), { lockTimeout: "5s" }).then(x => x, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.deepEqual(await pending, { status: "saved", rule, revision: rev + 1, replayed: false }, "serialised behind the new ownership");
  assert.equal((await db.query("SELECT count(*)::int n FROM public.property_owners WHERE owner_contact_id=$1", [ownerContact])).rows[0].n, 2);
  await db.query("DELETE FROM public.property_owners WHERE owner_contact_id=$1 AND property_id=$2", [ownerContact, otherProperty]);
  assert.ok(await view("owner"), "positive control after cleanup");
  // 4. The locked contact set itself must still be current: during the wait (holder also on the flag row) an
  //    archived owner contact of someone else is moved to the actor. It confers no ownership, but the set the
  //    writer locked is no longer what the same predicate selects → refused, nothing written.
  const stranger = await freshUser("stranger");
  const archived = (await db.query(`INSERT INTO public.contacts(org_id,user_id,is_owner,display_name,archived_at) VALUES($1,$2,true,'已封存屋主',clock_timestamp()) RETURNING id`, [ORG_ID, stranger])).rows[0].id;
  h = await holder();
  await h.query("UPDATE public.contacts SET user_id=$2 WHERE id=$1", [archived, USERS.owner]);
  await h.query("UPDATE public.platform_settings SET value=value WHERE key='owner_rules'");
  before = await snapshot();
  pending = set("owner", "ask_every_time", await current(ownerContact), randomUUID(), { lockTimeout: "5s" }).then(x => x, e => e);
  try { await waitForBlocked(h); await h.query("COMMIT"); } finally { await h.end(); }
  assert.ok(code("42501")(await pending), "a contact that joined the actor's set mid-wait is refused");
  assert.deepEqual(await snapshot(), before);
  // Positive control: with that archived contact already the actor's before the call, the writer locks it and is admitted.
  const ok = await set("owner", (await view("owner"))!.rule === "ask_every_time" ? "delegate_notify" : "ask_every_time", await current(ownerContact), randomUUID(), { lockTimeout: "5s" });
  assert.equal(ok.status, "saved");
  await db.query("DELETE FROM public.contacts WHERE id=$1", [archived]);
});

test("an owner with several ownerships whose id order differs from their property order is admitted (locked sets compared in id order)", async () => {
  await flag(true);
  const mine = (await db.query("SELECT id,property_id,effective_from FROM public.property_owners WHERE owner_contact_id=$1 ORDER BY id", [ownerContact])).rows;
  assert.equal(mine.length, 1, "fixture: one ownership to start");
  // A second ownership whose id sorts on the other side of the first from its property id.
  const other = (await db.query("SELECT id FROM public.properties WHERE org_id=$1 AND archived_at IS NULL AND id NOT IN (SELECT property_id FROM public.property_owners WHERE owner_contact_id=$2) ORDER BY id", [ORG_ID, ownerContact])).rows.map(r => r.id as string);
  const propertyBelow = other.find(id => id < mine[0].property_id), propertyAbove = other.find(id => id > mine[0].property_id);
  const property = propertyBelow ?? propertyAbove!;
  const id = propertyBelow ? "ffffffff-ffff-4fff-bfff-ffffffffffff" : "00000000-0000-4000-8000-000000000000";
  assert.ok((property < mine[0].property_id) === (id > mine[0].id), "fixture: id order and property order disagree");
  await db.query(`INSERT INTO public.property_owners(id,org_id,property_id,owner_contact_id,is_primary,effective_from) VALUES($1,$2,$3,$4,false,$5)`, [id, ORG_ID, property, ownerContact, mine[0].effective_from]);
  try {
    const rev = await current(ownerContact), rule = (await view("owner"))!.rule === "ask_every_time" ? "delegate_notify" : "ask_every_time";
    assert.deepEqual(await set("owner", rule, rev), { status: "saved", rule, revision: rev + 1, replayed: false });
  } finally { await db.query("DELETE FROM public.property_owners WHERE id=$1", [id]); }
});
