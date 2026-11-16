import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { svc } from "./db";
import { phoneHistory } from "./b076a-phone-history";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-076a / mgr-history-direct (MGT-76-AC3/AC12) on a cloned disposable database: real B-015 edits through
// app.b015_edit_contact, read back through app.b076a_phone_history as service_role. Never a pg mock or a grant.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const FN = "app.b076a_phone_history(uuid,uuid,text,uuid,uuid,bigint,integer)";
const sid: Record<string, string> = {};
const v3 = async () => true;
let tenant: string, ownerContact: string;
type Row = { id: string; occurredAt: string; at: string; status: string; actorRole: string; actorName: string | null; oldMasked: string | null; newMasked: string | null };
type Page = { tenant: string; place: string | null; rows: Row[]; next: string | null } | null;
const code = (c: string) => (e: unknown) => ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === c;

async function flag(on: boolean, orgOn = on) {
  await db.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text,$3::text)) WHERE key='tenant_directory_edit'`, [on, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('tenant_directory_edit',$2::boolean) WHERE id = ANY($1::uuid[])`, [[ORG_ID, ORG2_ID], orgOn]);
}
async function read(who: string, contact = tenant, opts: { org?: string; pin?: string | null; after?: string | null; limit?: number } = {}): Promise<Page> {
  const org = opts.org ?? ORG_ID;
  return svc(null, async client => {
    if (opts.pin !== null) await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)", [opts.pin ?? org]);
    return (await client.query(`SELECT ${FN.split("(")[0]}($1,$1,'live',$2,$3,$4::bigint,$5) r`, [org, sid[who], contact, opts.after ?? null, opts.limit ?? 20])).rows[0].r;
  }, { isolation: "repeatable read" });
}
/** A real B-015 edit (the only source this slice lists), as `who`. */
async function edit(who: keyof typeof USERS, contact: string, phone: string | null, name?: string) {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const before = (await db.query("SELECT display_name,email::text email FROM public.contacts WHERE id=$1", [contact])).rows[0];
    const expected = (await db.query<{ s: string }>("SELECT app.b015_contact_snapshot($1,$2) s", [ORG_ID, contact])).rows[0].s;
    await c.query("BEGIN");
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`, [USERS[who]]);
    await c.query("SET LOCAL ROLE service_role");
    const r = (await c.query(`SELECT app.b015_edit_contact($1,$1,'live',$2,$3,$4,$5,$6,$7,$8) r`,
      [ORG_ID, sid[who], contact, randomUUID(), expected, name ?? before.display_name, before.email, phone])).rows[0].r;
    await c.query("COMMIT");
    assert.equal(r.outcome, "changed");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { await c.end(); }
}
const snapshot = async () => (await db.query(`SELECT
  (SELECT md5(coalesce(string_agg(row_to_json(a)::text,'|' ORDER BY a.id),'')) FROM public.audit_log a) audit,
  (SELECT md5(coalesce(string_agg(row_to_json(c)::text,'|' ORDER BY c.org_id,c.actor_id,c.request_id),'')) FROM app.b015_edit_commands c) commands,
  (SELECT md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY t.id),'')) FROM public.contacts t) contacts`)).rows[0];
const session = (who: keyof typeof USERS, role: Session["role"], org = ORG_ID): Session => ({ kind: "staff", role, orgId: org, liveOrgId: org,
  userId: USERS[who], sessionId: sid[who], name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });

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
  for (const who of Object.keys(USERS)) {
    sid[who] = randomUUID();
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid[who], USERS[who as keyof typeof USERS], randomUUID()]);
  }
  sid.revoked = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours',clock_timestamp())", [sid.revoked, USERS.manager, randomUUID()]);
  tenant = randomUUID(); ownerContact = randomUUID();
  await db.query(`INSERT INTO public.contacts(id,org_id,is_tenant,display_name,email,phone_e164) VALUES($1,$2,true,'林小美',$3,NULL)`, [tenant, ORG_ID, `${randomUUID()}@example.test`]);
  await db.query(`INSERT INTO public.contacts(id,org_id,is_owner,display_name,email,phone_e164) VALUES($1,$2,true,'Owner Only',$3,'+886911222333')`, [ownerContact, ORG_ID, `${randomUUID()}@example.test`]);
  await flag(true);
  // History, oldest first: admin sets the first number; manager changes it; manager changes the name only
  // (not listed); a non-B-015 update changes the phone (not listed); manager changes to a non-Taiwan number.
  await edit("admin", tenant, "+886933123456");
  await edit("manager", tenant, "+886912345678");
  await edit("manager", tenant, "+886912345678", "林小美二");
  await db.query("UPDATE public.contacts SET phone_e164='+886955000111' WHERE id=$1", [tenant]);
  await edit("manager", tenant, "+14155550123");
  // Role at the time: the manager is promoted afterwards; the history keeps 經理.
  await db.query("UPDATE public.org_members SET role='admin' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]);
});

test.after(async () => {
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("effective privileges: only service_role may EXECUTE; anon, authenticated and PUBLIC are denied", async () => {
  for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, FN])).rows[0].ok, role === "service_role", role);
  assert.equal((await db.query(`SELECT count(*)::int n FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`, [FN])).rows[0].n, 0, "PUBLIC");
  assert.deepEqual((await db.query("SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [FN])).rows[0],
    { prosecdef: true, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"] });
  for (const role of ["anon", "authenticated"]) {
    await db.query("BEGIN");
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(db.query(`SELECT ${FN.split("(")[0]}(NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::uuid,NULL::bigint,NULL::integer)`), { code: "42501" });
    } finally { await db.query("ROLLBACK"); }
  }
});

test("MGT-76-AC3/AC12: B-015 phone edits only, newest first, role at the time, masked numbers; name-only and other updates excluded", async () => {
  await flag(true);
  const page = await read("admin");
  assert.ok(page);
  assert.equal(page.tenant, "林小美二");
  assert.deepEqual(page.rows.map(r => [r.status, r.actorRole, r.oldMasked, r.newMasked]), [
    ["direct", "manager", "0955‑•••‑111", "•••‑•••‑123"],
    ["direct", "manager", "0933‑•••‑456", "0912‑•••‑678"],
    ["direct", "admin", null, "0933‑•••‑456"],
  ]);
  assert.equal(page.next, null);
  const names = Object.fromEntries((await db.query("SELECT id::text id,display_name FROM public.profiles WHERE id = ANY($1::uuid[])", [[USERS.admin, USERS.manager]])).rows.map(r => [r.id, r.display_name]));
  assert.deepEqual(page.rows.map(r => r.actorName), [names[USERS.manager], names[USERS.manager], names[USERS.admin]]);
  for (const row of page.rows) {
    assert.match(row.at, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    assert.deepEqual(Object.keys(row).sort(), ["actorName", "actorRole", "at", "id", "newMasked", "occurredAt", "oldMasked", "status"]);
  }
  assert.ok(Number(page.rows[0].id) > Number(page.rows[1].id) && Number(page.rows[1].id) > Number(page.rows[2].id));
  // Masking: no full number, in any form, anywhere in the returned value.
  const json = JSON.stringify(page);
  for (const full of ["+886933123456", "886933123456", "0933123456", "933123456", "+886912345678", "0912345678", "912345678",
    "+886955000111", "0955000111", "+14155550123", "14155550123", "4155550123", "5550123"]) assert.ok(!json.includes(full), full);
  // The manager has since been promoted; the row keeps the role at the time.
  assert.equal((await db.query("SELECT role::text FROM public.org_members WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager])).rows[0].role, "admin");
  // TS reader, same data.
  const ts = await phoneHistory(session("admin", "admin"), tenant, {}, { v3 });
  assert.equal(ts.state, "ready");
  if (ts.state === "ready") assert.deepEqual(ts.rows, page.rows);
});

test("keyset paging: newest first, no overlap, no gap", async () => {
  await flag(true);
  const all = (await read("admin"))!.rows.map(r => r.id);
  const first = await read("admin", tenant, { limit: 2 });
  assert.deepEqual(first!.rows.map(r => r.id), all.slice(0, 2));
  assert.equal(first!.next, all[1]);
  const second = await read("admin", tenant, { limit: 2, after: first!.next });
  assert.deepEqual(second!.rows.map(r => r.id), all.slice(2));
  assert.equal(second!.next, null);
  const ts = await phoneHistory(session("admin", "admin"), tenant, { after: all[0] }, { v3 });
  if (ts.state !== "ready") assert.fail(ts.state);
  assert.deepEqual(ts.rows.map(r => r.id), all.slice(1));
  await assert.rejects(read("admin", tenant, { after: "0" }), code("22023"));
});

test("denials and no access: anon via ACL, cross-org, accountant, maintenance, revoked session, non-tenant contact, flag off", async () => {
  await flag(true);
  const before = await snapshot();
  for (const who of ["accountant", "maintenance", "revoked", "tenant", "owner"]) await assert.rejects(read(who), code("42501"), who);
  await assert.rejects(read("coastAdmin"), code("42501"), "another company's admin against this org");
  await assert.rejects(read("coastAdmin", tenant, { org: ORG2_ID }), code("42501"), "this org's contact through another org");
  await assert.rejects(read("admin", ownerContact), code("42501"), "non-tenant contact");
  await assert.rejects(read("admin", randomUUID()), code("42501"), "missing contact");
  await assert.rejects(read("admin", tenant, { pin: ORG2_ID }), code("42501"), "wrong org pin");
  await assert.rejects(read("admin", tenant, { pin: null }), code("42501"), "no org pin");
  for (const [who, role] of [["accountant", "accountant"], ["maintenance", "maintenance"]] as const)
    assert.deepEqual(await phoneHistory(session(who, role), tenant, {}, { v3 }), { state: "forbidden" }, who);
  assert.deepEqual(await phoneHistory({ ...session("admin", "admin"), sessionId: sid.revoked }, tenant, {}, { v3 }), { state: "forbidden" });
  assert.deepEqual(await phoneHistory(session("admin", "admin"), ownerContact, {}, { v3 }), { state: "forbidden" });
  assert.deepEqual(await phoneHistory(session("admin", "admin"), tenant, {}, { v3: async () => false }), { state: "off" });
  // No writes: every read above (allowed or denied) left audit, commands and contacts as they were.
  await read("admin"); await read("admin", tenant, { limit: 1 });
  assert.deepEqual(await snapshot(), before);
  // Flag off: platform off, or the org flag off with the platform on. (Toggling flags itself is audited,
  // so the no-write snapshot above is taken around the reads only.)
  for (const [platform, org] of [[false, false], [false, true], [true, false]] as const) {
    await flag(platform, org);
    const off = await snapshot();
    assert.equal(await read("admin"), null, `platform ${platform} org ${org}`);
    assert.deepEqual(await phoneHistory(session("admin", "admin"), tenant, {}, { v3 }), { state: "off" });
    assert.deepEqual(await snapshot(), off);
  }
  await flag(true);
});
