import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ownerPrivacy } from "./auth";
import { ownerViewRead, saveOwnerView } from "./b073-owner-view";
import { disposableDbUrl } from "./test-disposable-db";
import type { OrgRole, Session } from "./types";

// B-073 / R5-OWNVIEW (MGT-138-AC1…AC3) against a disposable local database. Synthetic data only; nothing outbound.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
test.before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
test.after(async () => { await db?.end(); });

async function makeOrg() {
  const tag = `b073.${randomUUID()}`;
  const settings = { show_tenant_phone: false, require_2fa: false, b073_fixture: "kept" };
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations(name,tax_id,country_code,default_currency,plan_tier,settings)
     VALUES ($1,'04595257','TW','TWD','beta',$2::jsonb) RETURNING id`, [tag, JSON.stringify(settings)])).rows[0].id;
  const sessions: Record<string, Session> = {};
  for (const role of ["admin", "manager", "accountant", "maintenance"] as OrgRole[]) {
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at,role,aud)
       VALUES (gen_random_uuid(), $1, '{}'::jsonb, now(), 'authenticated', 'authenticated') RETURNING id`, [`${tag}.${role}@example.com`])).rows[0].id;
    await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,$3,'active')", [orgId, userId, role]);
    sessions[role] = { userId, orgId, liveOrgId: orgId, role, sessionId: randomUUID(), kind: "staff", environment: "live", locale: "zh-TW",
      calendar: "gregorian", leaseId: null, name: "Synthetic", email: `${tag}.${role}@example.com` };
  }
  return { orgId, tag, sessions };
}
const orgRow = async (orgId: string) => (await db.query<{ settings: Record<string, unknown>; name: string; feature_flags: unknown }>(
  "SELECT settings, name, feature_flags FROM organizations WHERE id=$1", [orgId])).rows[0];
const audits = async (orgId: string) => (await db.query<{ action: string; n: number }>(
  "SELECT table_name || ':' || row_id AS action, count(*)::int AS n FROM audit_log WHERE org_id=$1 GROUP BY 1 ORDER BY 1", [orgId])).rows;

test("MGT-138-AC3: manager, accountant and maintenance are refused (403) and nothing changes", async () => {
  const { orgId, sessions } = await makeOrg();
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  for (const role of ["manager", "accountant", "maintenance"]) {
    assert.deepEqual(await saveOwnerView(sessions[role], { field: "showPhone", value: true }), { ok: false, status: 403 }, role);
    assert.deepEqual(await ownerViewRead(sessions[role]), { state: "forbidden" }, role);
  }
  assert.deepEqual(await orgRow(orgId), before);
  assert.deepEqual(await audits(orgId), auditBefore);
});

test("MGT-138-AC1/AC2: admin reads and saves; only the two privacy keys change, plus the owner_privacy audit row", async () => {
  const { orgId, tag, sessions } = await makeOrg();
  assert.deepEqual(await ownerViewRead(sessions.admin), { state: "ready", privacy: { showName: true, showPhone: false }, company: { name: tag, taxId: "04595257" } });
  const before = await orgRow(orgId), auditBefore = await audits(orgId);
  assert.deepEqual(await saveOwnerView(sessions.admin, { field: "showPhone", value: true }), { ok: true, privacy: { showName: true, showPhone: true } });
  assert.deepEqual(await saveOwnerView(sessions.admin, { field: "showName", value: false }), { ok: true, privacy: { showName: false, showPhone: true } });
  const after = await orgRow(orgId);
  assert.deepEqual(after.settings, { ...before.settings, show_tenant_name: false, show_tenant_phone: true });
  assert.equal(after.name, before.name); assert.deepEqual(after.feature_flags, before.feature_flags);
  // Same company-wide value the owner pages read today.
  assert.deepEqual(await ownerPrivacy(orgId), { showName: false, showPhone: true, name: tag });
  const added = (await audits(orgId)).map(row => ({ ...row, n: row.n - (auditBefore.find(b => b.action === row.action)?.n ?? 0) })).filter(row => row.n);
  assert.deepEqual(added, [{ action: "auth_events:owner_privacy", n: 2 }]);
});
