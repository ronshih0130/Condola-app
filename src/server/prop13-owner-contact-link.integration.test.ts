import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { tx } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { requireOrgScope } from "./org-guard";
import { linkOwnerContactPortal } from "./owner-contact-link";
import { acceptInvite } from "./auth";
import { issuePortalInvite } from "./portal-invite";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
test.before(async () => {
  clone = await cloneTestDatabase(); await resetAndSeed();
  db = new Client({ connectionString: clone.url }); await db.connect();
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });

function staff(userId: string, role: Session["role"], orgId = ORG_ID): Session {
  return { userId, role, orgId, liveOrgId: orgId, environment: "live", kind: "staff", sessionId: randomUUID(),
    email: "synthetic@example.test", name: "Synthetic", locale: "en", calendar: "gregorian", leaseId: null };
}
const admin = staff(USERS.admin, "admin"), manager = staff(USERS.manager, "manager"), accountant = staff(USERS.accountant, "accountant");
const foreignAdmin = staff(USERS.coastAdmin, "admin", ORG2_ID);
const denied = (error: unknown) => (error as { code?: string; key?: string }).code === "42501" || (error as { key?: string }).key === "errors.forbidden";

// Runs one API-role statement; returns "ok" or the raw SQLSTATE (savepoint keeps the probe exact).
async function asStaff(session: Session, sql: string, values: unknown[]) {
  return tx(session.userId, async (client) => {
    await client.query("SAVEPOINT prop13_probe");
    try { await client.query(sql, values); return "ok"; }
    catch (error) { await client.query("ROLLBACK TO SAVEPOINT prop13_probe"); return { code: (error as { code?: string }).code }; }
  }, requireOrgScope(session));
}
async function contact(opts: { owner?: boolean; tenant?: boolean; userId?: string | null; orgId?: string } = {}) {
  return (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_owner,is_tenant,display_name,email,user_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
    [opts.orgId ?? ORG_ID, opts.owner ?? false, opts.tenant ?? !opts.owner, `PROP13 ${randomUUID()}`, `prop13-${randomUUID()}@example.invalid`, opts.userId ?? null])).rows[0].id;
}
async function provision() {
  return (await db.query<{ id: string }>(`SELECT app.provision_portal_user($1,'PROP13 fresh',NULL)::text AS id`, [`prop13-fresh-${randomUUID()}@example.invalid`])).rows[0].id;
}
async function userOf(id: string) { return (await db.query<{ user_id: string | null; is_owner: boolean }>(`SELECT user_id::text,is_owner FROM contacts WHERE id=$1`, [id])).rows[0]; }
async function flag(on: boolean, orgOn = on) {
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text)) WHERE key='owner_contact_linking'`, [on, ORG_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('owner_contact_linking',$2::boolean) WHERE id=$1`, [ORG_ID, orgOn]);
}

test("PROP-13 guard: staff API-role writes cannot bind, rebind or clear contact logins", async () => {
  const owner = await contact({ owner: true });
  const tenant = await contact({ tenant: true });
  const existingTenantUser = (await db.query<{ user_id: string }>(`SELECT user_id::text FROM contacts WHERE org_id=$1 AND is_tenant AND user_id IS NOT NULL LIMIT 1`, [ORG_ID])).rows[0].user_id;
  for (const session of [admin, manager, accountant]) {
    // Self-binding an owner contact (the BLK-MAC-04 attack) and a tenant contact.
    assert.ok(denied(await asStaff(session, `UPDATE contacts SET user_id=auth.uid() WHERE id=$1`, [owner])), session.role!);
    assert.ok(denied(await asStaff(session, `UPDATE contacts SET user_id=auth.uid() WHERE id=$1`, [tenant])));
    // Binding an owner contact to a fresh login, an existing tenant login or a staff login.
    assert.ok(denied(await asStaff(session, `UPDATE contacts SET user_id=$2 WHERE id=$1`, [owner, await provision()])));
    assert.ok(denied(await asStaff(session, `UPDATE contacts SET user_id=$2 WHERE id=$1`, [tenant, existingTenantUser])));
    assert.ok(denied(await asStaff(session, `UPDATE contacts SET user_id=$2 WHERE id=$1`, [tenant, USERS.maintenance])));
    // Inserting a pre-bound owner contact.
    assert.ok(denied(await asStaff(session, `INSERT INTO contacts(org_id,is_owner,display_name,user_id) VALUES($1,true,'x',auth.uid())`, [ORG_ID])));
  }
  assert.deepEqual(await userOf(owner), { user_id: null, is_owner: true });
  assert.deepEqual(await userOf(tenant), { user_id: null, is_owner: false });
  // Rebinding/clearing an existing binding and promoting a bound contact to owner.
  const bound = await contact({ tenant: true, userId: await provision() });
  const before = await userOf(bound);
  assert.ok(denied(await asStaff(manager, `UPDATE contacts SET user_id=$2 WHERE id=$1`, [bound, await provision()])));
  assert.ok(denied(await asStaff(manager, `UPDATE contacts SET user_id=NULL WHERE id=$1`, [bound])));
  assert.ok(denied(await asStaff(manager, `UPDATE contacts SET is_owner=true WHERE id=$1`, [bound])));
  assert.deepEqual(await userOf(bound), before);
  // Unrelated staff edits of a bound contact still work.
  assert.equal(await asStaff(manager, `UPDATE contacts SET display_name='PROP13 renamed' WHERE id=$1`, [bound]), "ok");
});

// Fresh login provisioned inside the probe transaction (so only the check under test can reject).
async function freshProbe(session: Session, body: (client: import("pg").Client, user: string) => Promise<void>, scoped = true) {
  return tx(session.userId, async (client) => {
    await client.query(`SET LOCAL ROLE service_role`);
    const user = (await client.query<{ id: string }>(`SELECT app.provision_portal_user($1,'PROP13 probe',NULL)::text AS id`, [`prop13-probe-${randomUUID()}@example.invalid`])).rows[0].id;
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query("SAVEPOINT probe");
    try { await body(client, user); return "ok"; }
    catch (error) { await client.query("ROLLBACK TO SAVEPOINT probe"); return (error as { code?: string }).code ?? String(error); }
  }, scoped ? requireOrgScope(session) : undefined);
}

test("PROP-13 guard: each eligibility rule rejects on its own (fresh login otherwise valid)", async () => {
  const control = await contact({ tenant: true });
  assert.equal(await freshProbe(manager, async (client, user) => { await client.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`, [control, user]); }), "ok", "positive control");
  // Membership anywhere (here: a foreign org, invisible to this org's RLS).
  const member = await contact({ tenant: true });
  assert.equal(await freshProbe(manager, async (client, user) => {
    await client.query(`SET LOCAL ROLE service_role`);
    await client.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')`, [ORG2_ID, user]);
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`, [member, user]);
  }), "42501");
  // Already bound to another contact.
  const first = await contact({ tenant: true }), second = await contact({ tenant: true });
  assert.equal(await freshProbe(manager, async (client, user) => {
    await client.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`, [first, user]);
    await client.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`, [second, user]);
  }), "42501");
  // Not fresh: an existing unbound login created in an earlier transaction.
  const stale = await contact({ tenant: true });
  assert.ok(denied(await asStaff(manager, `UPDATE contacts SET user_id=$2 WHERE id=$1`, [stale, await provision()])));
  assert.equal((await userOf(member)).user_id, null);
  assert.equal((await userOf(second)).user_id, null);
});

// Unpinned API-role statement (no app.active_org_id / app.env), always rolled back.
async function unpinned(userId: string, sql: string, values: unknown[]) {
  const client = new Client({ connectionString: clone.url }); await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)`, [userId]);
    await client.query("SET LOCAL ROLE authenticated");
    try { const r = await client.query(sql, values); return { ok: r.rowCount }; }
    catch (error) { return { code: (error as { code?: string }).code }; }
  } finally { await client.query("ROLLBACK").catch(() => undefined); await client.end(); }
}

test("PROP-13 guard: bound contacts cannot change org even for an unpinned dual-org admin", async () => {
  const bound = await contact({ owner: true, userId: await provision() });
  const unbound = await contact({ tenant: true });
  await db.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT DO NOTHING`, [ORG2_ID, USERS.admin]);
  try {
    // Positive control: RLS lets this unpinned dual-org admin move an unbound contact.
    assert.deepEqual(await unpinned(USERS.admin, `UPDATE contacts SET org_id=$2 WHERE id=$1`, [unbound, ORG2_ID]), { ok: 1 });
    // Only the PROP-13 guard rejects the same move for a bound contact.
    assert.deepEqual(await unpinned(USERS.admin, `UPDATE contacts SET org_id=$2 WHERE id=$1`, [bound, ORG2_ID]), { code: "42501" });
  } finally {
    await db.query(`DELETE FROM org_members WHERE org_id=$1 AND user_id=$2`, [ORG2_ID, USERS.admin]);
  }
  assert.equal((await db.query<{ org_id: string }>(`SELECT org_id::text FROM contacts WHERE id=$1`, [bound])).rows[0].org_id, ORG_ID);
});

test("PROP-13 invitation acceptance never binds a staff login", async () => {
  const email = `prop13-staff-${randomUUID()}@example.invalid`;
  const staffUser = (await db.query<{ id: string }>(`INSERT INTO auth.users (id,email,encrypted_password,email_confirmed_at,raw_user_meta_data,role,aud)
    VALUES (gen_random_uuid(),$1,crypt('Owner1234',gen_salt('bf')),now(),'{}'::jsonb,'authenticated','authenticated') RETURNING id::text`, [email])).rows[0].id;
  await db.query(`INSERT INTO profiles (id,display_name,email) VALUES ($1,'PROP13 staff',$2)`, [staffUser, email]);
  await db.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')`, [ORG2_ID, staffUser]);
  const owner = (await db.query<{ id: string }>(`INSERT INTO contacts (org_id,is_owner,display_name,email,locale) VALUES ($1,true,'PROP13 owner',$2,'zh-TW') RETURNING id::text`, [ORG_ID, email])).rows[0].id;
  const issued = await issuePortalInvite(admin, { kind: "owner", contactId: owner, pageId: owner }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const accepted = await acceptInvite(issued.token, "", "Owner1234", "", { ip: "127.0.0.1", ua: "prop13" });
  assert.equal(accepted.ok, false);
  assert.equal((await userOf(owner)).user_id, null, "staff login not bound");
});

test("PROP-13 guard: owner references must point at owner contacts", async () => {
  const tenantBound = await contact({ tenant: true, userId: await provision() });
  const owner = await contact({ owner: true });
  const ownership = (await db.query<{ id: string; property_id: string; owner_contact_id: string }>(
    `SELECT id::text,property_id::text,owner_contact_id::text FROM property_owners WHERE org_id=$1 LIMIT 1`, [ORG_ID])).rows[0];
  assert.ok(ownership);
  assert.ok(denied(await asStaff(admin, `UPDATE property_owners SET owner_contact_id=$2 WHERE id=$1`, [ownership.id, tenantBound])));
  assert.ok(denied(await asStaff(admin, `INSERT INTO property_owners(org_id,property_id,owner_contact_id,ownership_bp,is_primary) VALUES($1,$2,$3,1,false)`, [ORG_ID, ownership.property_id, tenantBound])));
  assert.equal(await asStaff(admin, `INSERT INTO property_owners(org_id,property_id,owner_contact_id,ownership_bp,is_primary) VALUES($1,$2,$3,1,false)`, [ORG_ID, ownership.property_id, owner]), "ok");
  for (const table of ["owner_statements", "management_agreements", "bank_accounts"]) {
    const row = (await db.query<{ id: string }>(`SELECT id::text FROM ${table} WHERE org_id=$1 LIMIT 1`, [ORG_ID])).rows[0];
    assert.ok(row, `${table} fixture`);
    assert.ok(denied(await asStaff(admin, `UPDATE ${table} SET owner_contact_id=$2 WHERE id=$1`, [row.id, tenantBound])), table);
    assert.equal(await asStaff(admin, `UPDATE ${table} SET owner_contact_id=$2 WHERE id=$1`, [row.id, owner]), "ok", `${table} owner control`);
  }
  // bank_accounts.owner_contact_id is nullable (management accounts): clearing stays allowed.
  const account = (await db.query<{ id: string }>(`SELECT id::text FROM bank_accounts WHERE org_id=$1 LIMIT 1`, [ORG_ID])).rows[0];
  assert.equal(await asStaff(admin, `UPDATE bank_accounts SET owner_contact_id=NULL WHERE id=$1`, [account.id]), "ok");
  // The definer helper answers nothing for a non-member caller.
  const oracle = await tx(foreignAdmin.userId, (client) => client.query<{ ok: boolean }>(`SELECT app.prop13_is_owner_contact($1,$2) AS ok`, [ORG_ID, owner]), requireOrgScope(foreignAdmin));
  assert.equal(oracle.rows[0].ok, false);
  assert.equal((await db.query(`SELECT 1 FROM property_owners WHERE owner_contact_id=$1`, [tenantBound])).rowCount, 0);
});

test("PROP-13 guard: tenant onboarding still binds a freshly provisioned login (tenant and dual-role)", async () => {
  // Owner identity is never granted by freshness alone: a tenant+owner (dual-role)
  // contact is bound only through the trusted linking RPC (documented behaviour change).
  const dual = await contact({ tenant: true, owner: true });
  const dualCode = await tx(manager.userId, async (client) => {
    await client.query(`SET LOCAL ROLE service_role`);
    const user = (await client.query<{ id: string }>(`SELECT app.provision_portal_user($1,'PROP13 dual',NULL)::text AS id`, [`prop13-dual-${randomUUID()}@example.invalid`])).rows[0].id;
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query("SAVEPOINT dual");
    try { await client.query(`UPDATE contacts SET user_id=$2 WHERE id=$1 AND user_id IS NULL`, [dual, user]); return "ok"; }
    catch (error) { await client.query("ROLLBACK TO SAVEPOINT dual"); return (error as { code?: string }).code; }
  }, requireOrgScope(manager));
  assert.equal(dualCode, "42501");
  assert.equal((await userOf(dual)).user_id, null);
  const tenant = await contact({ tenant: true });
  // Mirrors domain.ts attachPortalUser: provision as service_role, bind as the API role.
  const result = await tx(manager.userId, async (client) => {
    await client.query(`SET LOCAL ROLE service_role`);
    const user = (await client.query<{ id: string }>(`SELECT app.provision_portal_user($1,'PROP13 tenant',NULL)::text AS id`, [`prop13-tenant-${randomUUID()}@example.invalid`])).rows[0].id;
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query(`UPDATE contacts SET user_id=$2 WHERE id=$1 AND user_id IS NULL`, [tenant, user]);
    return user;
  }, requireOrgScope(manager));
  assert.equal((await userOf(tenant)).user_id, result);
});

test("PROP-13 trusted linking RPC: OFF writes nothing; ON lets only an org admin bind a NEW login", async () => {
  const owner = await contact({ owner: true });
  const users = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth.users`)).rows[0].n;
  await flag(false);
  const beforeUsers = await users();
  for (const [on, orgOn] of [[false, false], [true, false], [false, true]] as const) {
    await flag(on, orgOn);
    await assert.rejects(linkOwnerContactPortal(admin, { contactId: owner, email: `o-${randomUUID()}@example.invalid` }), denied);
  }
  assert.equal(await users(), beforeUsers);
  assert.equal((await userOf(owner)).user_id, null);
  await flag(true);
  try {
    await assert.rejects(linkOwnerContactPortal(manager, { contactId: owner, email: `o-${randomUUID()}@example.invalid` }), denied);
    await assert.rejects(tx(manager.userId, (client) => client.query(`SELECT app.prop13_link_owner_contact($1,$2,$3)`, [ORG_ID, owner, `o-${randomUUID()}@example.invalid`]), requireOrgScope(manager)));
    await assert.rejects(linkOwnerContactPortal(foreignAdmin, { contactId: owner, email: `o-${randomUUID()}@example.invalid` }), denied);
    const tenant = await contact({ tenant: true });
    await assert.rejects(linkOwnerContactPortal(admin, { contactId: tenant, email: `o-${randomUUID()}@example.invalid` }), denied);
    assert.equal(await users(), beforeUsers);
    const linked = await linkOwnerContactPortal(admin, { contactId: owner, email: `o-${randomUUID()}@example.invalid` });
    assert.equal((await userOf(owner)).user_id, linked.userId);
    assert.notEqual(linked.userId, USERS.admin);
    assert.equal((await db.query(`SELECT 1 FROM org_members WHERE user_id=$1`, [linked.userId])).rowCount, 0);
    assert.equal(await users(), beforeUsers + 1);
    // Already linked: a second link is denied and the binding is unchanged.
    await assert.rejects(linkOwnerContactPortal(admin, { contactId: owner, email: `o-${randomUUID()}@example.invalid` }), denied);
    assert.equal((await userOf(owner)).user_id, linked.userId);
  } finally { await flag(false); }
  const fn = (await db.query(`SELECT p.prosecdef AS definer, p.proconfig AS config,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public
      FROM pg_proc p WHERE p.oid='app.prop13_link_owner_contact(uuid,uuid,text)'::regprocedure`)).rows[0];
  assert.deepEqual(fn, { definer: true, config: ["search_path=pg_catalog, public, app"], anon: false, authenticated: true, public: false });
  assert.equal((await db.query(`SELECT value FROM platform_settings WHERE key='owner_contact_linking'`)).rows[0].value.enabled, false);
});
