import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { insertTestAuthSession } from "./test-auth-session";
import { readSetupStep, readSetupStepOn } from "./onboarding-progress";
import type { Session, OrgRole } from "./types";

let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let db: Client;
test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: clone.url }); await db.connect();
  // B-040 and the existing B-005 protection migration must already be installed in the template.
  const prerequisites = (await db.query(`SELECT to_regclass('app.unit_bindings') IS NOT NULL AS bindings,
    to_regprocedure('app.b005_protect_onboarding_progress()') IS NOT NULL AS protection`)).rows[0];
  assert.equal(prerequisites.bindings, true); assert.equal(prerequisites.protection, true);
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });

async function fixture() {
  const org = randomUUID();
  await db.query(`INSERT INTO organizations(id,name,country_code,default_currency,feature_flags,settings)
    VALUES($1,'B046','TW','TWD','{"onboarding_progress":true}','{"other":42}')`, [org]);
  async function staff(role: OrgRole): Promise<Session> {
    const user = randomUUID();
    await db.query(`INSERT INTO auth.users(id,email,encrypted_password) VALUES($1,$2,'synthetic')`, [user, `${user}@example.test`]);
    await db.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,$3,'active')`, [org, user, role]);
    const sid = await insertTestAuthSession(db, user);
    return { userId: user, sessionId: sid, orgId: org, liveOrgId: org, environment: "live", kind: "staff", role,
      locale: "zh-TW", calendar: "gregorian", leaseId: null, email: `${user}@example.test`, name: "B046" } as Session;
  }
  const admin = await staff("admin");
  async function allow(on = true) {
    await db.query(`INSERT INTO platform_settings(key,value) VALUES('onboarding_progress',jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text)))
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [org, on]);
  }
  async function company() { await db.query(`UPDATE organizations SET contact_phone='+12025550123' WHERE id=$1`, [org]); }
  async function unit() {
    const property = randomUUID(), unit = randomUUID();
    await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'B046','TW','TWD','Asia/Taipei')`, [property, org]);
    await db.query(`INSERT INTO units(id,org_id,property_id,label) VALUES($1,$2,$3,'B046')`, [unit, org, property]);
    return { property, unit };
  }
  async function tenant(space: Awaited<ReturnType<typeof unit>>, status = "active") {
    const user = randomUUID(), contact = randomUUID(), lease = randomUUID(), invitation = randomUUID();
    await db.query(`INSERT INTO auth.users(id,email) VALUES($1,$2)`, [user, `${user}@example.test`]);
    await db.query(`INSERT INTO contacts(id,org_id,user_id,is_tenant,display_name) VALUES($1,$2,$3,true,'B046')`, [contact, org, user]);
    await db.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor)
      VALUES($1,$2,$3,$4,$4,$5::lease_status,'2026-01-01','TWD',100)`, [lease, org, space.property, space.unit, status]);
    const party = (await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary') RETURNING id`, [org, lease, contact])).rows[0].id as string;
    await db.query(`INSERT INTO invitations(id,org_id,kind,contact_id,lease_id,code_hash,expires_at)
      VALUES($1,$2,'tenant',$3,$4,$5,now()+interval '1 day')`, [invitation, org, contact, lease, randomUUID()]);
    async function join() {
      await db.query(`UPDATE auth.users SET encrypted_password='synthetic' WHERE id=$1`, [user]);
      await db.query(`UPDATE invitations SET status='accepted',accepted_by=$2,accepted_at=now() WHERE id=$1`, [invitation, user]);
    }
    return { user, contact, lease, invitation, party, join };
  }
  return { org, admin, staff, allow, company, unit, tenant, read: (session = admin) => readSetupStepOn(db, session) };
}

test("MGT-54-AC1/AC2: each step, legacy account readiness, audited persistent collapse", async () => {
  const f = await fixture(); await f.allow();
  let p = await f.read(); assert.equal(p.step, 0); assert.equal(p.checklist?.total, 4);
  await f.company(); p = await f.read(); assert.equal(p.step, 1);
  const space = await f.unit(); p = await f.read(); assert.equal(p.step, 2);
  const tenant = await f.tenant(space); p = await f.read(); assert.equal(p.step, 3);
  await tenant.join(); p = await f.read(); assert.equal(p.step, 4); assert.ok(p.checklist?.completedAt);
  const at = p.checklist.completedAt;
  await db.query(`UPDATE contacts SET is_tenant=false WHERE id=$1`, [tenant.contact]);
  p = await f.read(); assert.equal(p.tenantJoined, false); assert.equal(p.checklist?.completedAt, at);
  await f.read();
  const settings = (await db.query(`SELECT settings FROM organizations WHERE id=$1`, [f.org])).rows[0].settings;
  assert.equal(settings.other, 42);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND event_type='onboarding_setup_completed'`, [f.org])).rows[0].n, 1);
});

test("MGT-54-AC1: a read needing no completion returns within 2 s while the organization is write-locked", async () => {
  const f = await fixture(); await f.allow();
  const locker = new Client({ connectionString: clone.url });
  await locker.connect();
  let pending: ReturnType<typeof readSetupStep> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [f.org]);
    const started = performance.now();
    pending = readSetupStep(f.admin);
    const p = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("readSetupStep waited on the organization lock for 2 s")), 2000);
      }),
    ]);
    assert.ok(performance.now() - started < 2000);
    assert.equal(p.checklistOn, true);
    assert.equal(p.tenantJoined, false);
    assert.equal(p.checklist?.completedAt, null);
  } finally {
    clearTimeout(timer);
    await locker.query("ROLLBACK");
    await locker.end();
    // Drain a blocked reader after releasing the lock, including on timeout.
    await pending?.catch(() => {});
  }
});

test("MGT-54-AC2: sample company, unit, invitation, contact, party and binding never complete steps", async () => {
  const f = await fixture(); await f.allow(); await f.company();
  const space = await f.unit(), tenant = await f.tenant(space); await tenant.join();
  const binding = randomUUID();
  await db.query(`INSERT INTO app.unit_bindings(id,org_id,unit_id,user_id,contact_id,line_identity_hash,status)
    VALUES($1,$2,$3,$4,$5,'synthetic','pending')`, [binding, f.org, space.unit, tenant.user, tenant.contact]);
  for (const [table, id] of [["organizations", f.org], ["properties", space.property], ["units", space.unit], ["contacts", tenant.contact], ["leases", tenant.lease], ["lease_parties", tenant.party], ["invitations", tenant.invitation], ["unit_bindings", binding]]) {
    await db.query(`INSERT INTO sample_marks(org_id,entity_table,entity_id) VALUES($1,$2,$3)`, [f.org, table, id]);
  }
  const p = await f.read();
  assert.equal(p.step, 0); assert.deepEqual(p.checklist?.steps.map(s => s.done), [false, false, false, false]);
  assert.equal(p.checklist?.completedAt, null);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND event_type='onboarding_setup_completed'`, [f.org])).rows[0].n, 0);
});

test("MGT-54-AC3/AC4/AC5 MGT-56-AC8: flags, allowlist, roles, native session validation", async () => {
  const f = await fixture();
  assert.equal((await f.read()).checklist, null);
  await f.allow();
  for (const role of ["accountant", "maintenance"] as const) assert.equal((await f.read(await f.staff(role))).checklist, null);
  const manager = await f.staff("manager");
  let p = await f.read(manager); assert.equal(p.checklist?.total, 3); assert.equal(p.checklist?.completed, 0);
  await f.company(); await f.unit();
  p = await f.read(manager); assert.equal(p.checklist?.completed, 1); assert.equal((await f.read()).checklist?.completed, 2);
  await db.query(`UPDATE organizations SET feature_flags='{}' WHERE id=$1`, [f.org]);
  p = await f.read(); assert.equal(p.step, 2); assert.equal(p.checklistOn, false); assert.equal(p.checklist, null);
  await db.query(`UPDATE organizations SET feature_flags='{"onboarding_progress":"true"}' WHERE id=$1`, [f.org]);
  assert.equal((await f.read()).checklist, null);
  await db.query(`UPDATE organizations SET feature_flags='{"onboarding_progress":true}' WHERE id=$1`, [f.org]);
  await f.allow(false); assert.equal((await f.read()).checklist, null);
  await f.allow();
  await db.query(`UPDATE platform_settings SET value='{"enabled":true,"allowed_org_ids":"invalid"}' WHERE key='onboarding_progress'`);
  assert.equal((await f.read()).checklist, null);
  await assert.rejects(f.read({ ...f.admin, orgId: randomUUID() }));
  await assert.rejects(f.read({ ...manager, role: "admin" }));
  await db.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`, [f.admin.sessionId]);
  await assert.rejects(f.read());
});

test("MGT-54-AC6/AC7 MGT-55-AC4/AC5 MGT-56-AC9/AC10: invitation routes and B-040 binding fallback", async () => {
  const f = await fixture(); await f.allow(); await f.company();
  const space = await f.unit();
  let p = await f.read(); assert.equal(p.inviteMode, "no_lease"); assert.equal(p.inviteHref, "/m/leases/new");
  const tenant = await f.tenant(space);
  p = await f.read(); assert.equal(p.inviteMode, "lease"); assert.equal(p.inviteHref, `/m/leases/${tenant.lease}`);
  await f.tenant(space, "draft"); assert.equal((await f.read()).inviteHref, "/m/leases");
  await db.query(`INSERT INTO platform_settings(key,value) VALUES('unit_line_invite',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [f.org]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"unit_line_invite":true}'::jsonb WHERE id=$1`, [f.org]);
  p = await f.read(); assert.equal(p.inviteMode, "m4"); assert.equal(p.inviteHref, `/m/units?invite=${space.unit}`);
  await f.unit(); assert.equal((await f.read()).inviteHref, "/m/units");
  await db.query(`UPDATE invitations SET status='revoked' WHERE org_id=$1`, [f.org]);
  assert.equal((await f.read()).step, 2);
  // A secret alone does not count as a share; the fallback deliberately ignores it.
  await db.query(`INSERT INTO app.unit_invite_secrets(org_id,unit_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [f.org, space.unit, randomUUID()]);
  assert.equal((await f.read()).step, 2);
  await db.query(`INSERT INTO app.unit_bindings(org_id,unit_id,user_id,contact_id,line_identity_hash,status)
    VALUES($1,$2,$3,$4,'synthetic','pending')`, [f.org, space.unit, tenant.user, tenant.contact]);
  p = await f.read(); assert.equal(p.step, 4); assert.ok(p.checklist?.completedAt);
  const manager = await f.staff("manager"); assert.equal((await f.read(manager)).checklist?.completedAt, p.checklist.completedAt);
});

test("MGT-54-AC2/AC3: binding out of order collapses; flag OFF does not persist completion", async () => {
  const f = await fixture(), space = await f.unit(), tenant = await f.tenant(space);
  await tenant.join();
  let p = await f.read(); assert.equal(p.step, 0); assert.equal(p.checklist, null);
  assert.equal((await db.query(`SELECT settings->'onboarding_progress' AS progress FROM organizations WHERE id=$1`, [f.org])).rows[0].progress, null);
  await f.allow(); p = await f.read(); assert.equal(p.step, 0); assert.ok(p.checklist?.completedAt);
});

test("MGT-54-AC2/AC5: manager can record first completion; sandbox never receives a checklist", async () => {
  const f = await fixture(); await f.allow(); await f.company();
  const manager = await f.staff("manager"), space = await f.unit(), tenant = await f.tenant(space);
  await db.query(`UPDATE organizations SET settings=settings || '{"onboarding_progress":null}'::jsonb WHERE id=$1`, [f.org]);
  const binding = randomUUID();
  await db.query(`INSERT INTO app.unit_bindings(id,org_id,unit_id,user_id,contact_id,line_identity_hash,status)
    VALUES($1,$2,$3,$4,$5,'synthetic','pending')`, [binding, f.org, space.unit, tenant.user, tenant.contact]);
  const p = await f.read(manager); assert.equal(p.checklist?.total, 3); assert.ok(p.checklist?.completedAt);
  assert.equal((await db.query(`SELECT actor_user_id::text AS actor FROM audit_log WHERE org_id=$1 AND event_type='onboarding_setup_completed'`, [f.org])).rows[0].actor, manager.userId);
  await db.query(`UPDATE app.unit_bindings SET status='unlinked',unbound_at=now() WHERE id=$1`, [binding]);
  assert.equal((await f.read()).checklist?.completedAt, p.checklist.completedAt);
  const sandbox = randomUUID();
  await db.query(`INSERT INTO organizations(id,name,country_code,default_currency,environment,live_org_id,feature_flags)
    VALUES($1,'B046 sample','TW','TWD','sandbox',$2,'{"onboarding_progress":true}')`, [sandbox, f.org]);
  assert.equal((await f.read({ ...f.admin, orgId: sandbox, environment: "sandbox" })).checklist, null);
});
