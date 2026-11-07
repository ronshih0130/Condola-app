import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptInvite, signIn } from "./auth";
import { query, withClient } from "./db";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { hashInviteToken, issuePortalInvite } from "./portal-invite";
import { createOwner, updateOwner } from "./portfolio";
import { resetAndSeed } from "./seed";
import type { Session } from "./types";

// S3: an owner portal invite must not set a password on, or bind, a login that
// belongs to someone else. Staff can point an owner contact at any email and
// hold the raw invite token, so the invite alone proves nothing about that login.

const meta = { ua: "test", ip: "203.0.113.30" };
const ATTACKER_PASSWORD = "Attack1234";

function staff(userId: string, role: Session["role"], orgId = ORG_ID): Session {
  return {
    userId,
    sessionId: "s3-portal-invite",
    email: "staff@example.com",
    name: "Staff",
    kind: "staff",
    role,
    orgId,
    liveOrgId: orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

function stamp() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** The same call createLease makes: a login with no password yet. */
async function passwordlessLogin(email: string, name: string) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE service_role`);
    const user = await client.query<{ id: string }>(`SELECT app.provision_portal_user($1, $2, NULL)::text AS id`, [email, name]);
    await client.query("COMMIT");
    return user.rows[0].id;
  });
}

async function tenantContact(orgId: string, userId: string, name: string, email: string | null) {
  const row = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, locale)
     VALUES ($1, $2, true, $3, $4, 'zh-TW') RETURNING id::text`,
    [orgId, userId, name, email],
  );
  return row.rows[0].id;
}

async function loginState(userId: string) {
  const row = await query<{ email: string; encrypted_password: string | null; sessions: string }>(
    `SELECT u.email::text AS email, u.encrypted_password,
            (SELECT count(*)::text FROM auth_sessions s WHERE s.user_id = u.id) AS sessions
       FROM auth.users u WHERE u.id = $1`,
    [userId],
  );
  return row.rows[0];
}

async function contactUser(contactId: string) {
  const row = await query<{ user_id: string | null }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [contactId]);
  return row.rows[0].user_id;
}

async function inviteStatus(contactId: string) {
  const row = await query<{ status: string }>(
    `SELECT status::text FROM invitations WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [contactId],
  );
  return row.rows[0]?.status ?? null;
}

/** The attacker path: a manager creates an owner, repoints its email at the victim, and copies the link. */
async function ownerInviteFor(email: string, session = staff(USERS.manager, "manager")) {
  const ownerId = await createOwner(session, { name: "誘餌屋主", email: `decoy.${stamp()}@example.com`, phone: "", propertyIds: [] });
  await updateOwner(session, ownerId, { name: "誘餌屋主", email, phone: "", propertyIds: [] });
  const issued = await issuePortalInvite(session, { kind: "owner", contactId: ownerId, pageId: ownerId }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) throw new Error("unexpected activated owner");
  assert.equal(issued.email, email);
  return { ownerId, token: issued.token };
}

type Victim = { userId: string; contactId: string; email: string; before: Awaited<ReturnType<typeof loginState>> };

/** Everything a takeover would change, gathered first so a failure shows the whole effect at once. */
async function takeoverFacts(result: Awaited<ReturnType<typeof acceptInvite>>, victim: Victim, ownerId: string, signInEmail = victim.email) {
  const after = await loginState(victim.userId);
  return {
    result: { ok: result.ok, error: result.ok ? null : result.error, sessionToken: "token" in result },
    passwordHashChanged: after.encrypted_password !== victim.before.encrypted_password,
    loginEmailChanged: after.email !== victim.before.email,
    sessionsAdded: Number(after.sessions) - Number(victim.before.sessions),
    ownerContactUser: (await contactUser(ownerId)) === victim.userId ? "victim" : await contactUser(ownerId),
    victimContactStillBound: (await contactUser(victim.contactId)) === victim.userId,
    inviteStatus: await inviteStatus(ownerId),
    attackerPasswordSignsIn: (await signIn(signInEmail, ATTACKER_PASSWORD, false, meta)).ok,
  };
}

const REFUSED = {
  result: { ok: false, error: "auth", sessionToken: false },
  passwordHashChanged: false,
  loginEmailChanged: false,
  sessionsAdded: 0,
  ownerContactUser: null,
  victimContactStillBound: true,
  inviteStatus: "pending",
  attackerPasswordSignsIn: false,
};

async function assertRefused(result: Awaited<ReturnType<typeof acceptInvite>>, victim: Victim, ownerId: string) {
  assert.deepEqual(await takeoverFacts(result, victim, ownerId), REFUSED);
  assert.deepEqual(result, { ok: false, error: "auth", kind: "owner" });
}

test.before(async () => {
  await resetAndSeed();
});

test.beforeEach(async () => {
  await query(`DELETE FROM portal_invite_attempts`);
});

test("cross-org: an owner invite cannot set a password on another firm's unactivated tenant login", async () => {
  const email = `coast.tenant.${stamp()}@example.com`;
  const userId = await passwordlessLogin(email, "海岸租客");
  const contactId = await tenantContact(ORG2_ID, userId, "海岸租客", email);
  const before = await loginState(userId);
  assert.equal(before.encrypted_password ?? "", "");

  const { ownerId, token } = await ownerInviteFor(email);
  const result = await acceptInvite(token, "", ATTACKER_PASSWORD, "", meta);
  await assertRefused(result, { userId, contactId, email, before }, ownerId);
});

test("same-org: an owner invite cannot set a password on an unactivated tenant login of this firm", async () => {
  const email = `xinyi.tenant.${stamp()}@example.com`;
  const userId = await passwordlessLogin(email, "信義租客");
  // Staff later changed the tenant contact's email, so the owner editor accepts the login address.
  const contactId = await tenantContact(ORG_ID, userId, "信義租客", `xinyi.changed.${stamp()}@example.com`);
  const before = await loginState(userId);

  const { ownerId, token } = await ownerInviteFor(email, staff(USERS.admin, "admin"));
  const result = await acceptInvite(token, "", ATTACKER_PASSWORD, "", meta);
  await assertRefused(result, { userId, contactId, email, before }, ownerId);
});

test("a login already bound to another contact is not rewritten without its password", async () => {
  // Defence in depth: the owner contact's own login is shared with another firm's
  // tenant contact and its address is minted, so no account matches the shown email.
  const shown = `shared.owner.${stamp()}@example.com`;
  const minted = `portal-${randomUUID()}@demo.condola.local`;
  const user = await query<{ id: string }>(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, role, aud)
     VALUES (gen_random_uuid(), $1, crypt('Tenant1234', gen_salt('bf')), now(), '{}'::jsonb, 'authenticated', 'authenticated')
     RETURNING id::text`,
    [minted],
  );
  const userId = user.rows[0].id;
  await query(`INSERT INTO profiles (id, display_name, email) VALUES ($1, '共用登入', $2)`, [userId, minted]);
  const contactId = await tenantContact(ORG2_ID, userId, "共用登入", null);
  const owner = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, user_id, is_owner, display_name, email, locale)
     VALUES ($1, $2, true, '共用屋主', $3, 'zh-TW') RETURNING id::text`,
    [ORG_ID, userId, shown],
  );
  const ownerId = owner.rows[0].id;
  // A ready login with no live invite reads as activated, so leave an older pending link for staff to copy.
  await query(
    `INSERT INTO invitations (org_id, kind, contact_id, email, code_hash, status, expires_at, invited_by)
     VALUES ($1, 'owner', $2, $3, $4, 'pending', now() + interval '7 days', $5)`,
    [ORG_ID, ownerId, shown, hashInviteToken(`old-format-${stamp()}`), USERS.manager],
  );
  const before = await loginState(userId);
  const issued = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: ownerId, pageId: ownerId }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const result = await acceptInvite(issued.token, "", ATTACKER_PASSWORD, "", meta);
  // The owner contact was already on this login, so "bound" here means it stays on it.
  assert.deepEqual(await takeoverFacts(result, { userId, contactId, email: minted, before }, ownerId, shown), {
    ...REFUSED,
    ownerContactUser: "victim",
  });
  assert.deepEqual(result, { ok: false, error: "auth", kind: "owner" });
});

test("an activated tenant in another firm adds the owner role only with the correct password", async () => {
  const email = `dual.role.${stamp()}@example.com`;
  const password = "Tenant1234";
  const user = await query<{ id: string }>(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, role, aud)
     VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), now(), '{}'::jsonb, 'authenticated', 'authenticated')
     RETURNING id::text`,
    [email, password],
  );
  const userId = user.rows[0].id;
  await query(`INSERT INTO profiles (id, display_name, email) VALUES ($1, '雙身分', $2)`, [userId, email]);
  const contactId = await tenantContact(ORG2_ID, userId, "雙身分", email);
  const before = await loginState(userId);

  const { ownerId, token } = await ownerInviteFor(email);
  const wrong = await acceptInvite(token, "", ATTACKER_PASSWORD, "", meta);
  assert.deepEqual(wrong, { ok: false, error: "auth", kind: "owner" });
  assert.equal(await contactUser(ownerId), null);
  assert.equal((await loginState(userId)).encrypted_password, before.encrypted_password);

  const accepted = await acceptInvite(token, "", password, "", meta);
  assert.equal(accepted.ok, true);
  if (accepted.ok && "destination" in accepted) assert.equal(accepted.destination, "/o/statements");
  assert.equal(await contactUser(ownerId), userId);
  assert.equal(await contactUser(contactId), userId);
  assert.equal((await loginState(userId)).encrypted_password, before.encrypted_password);
  assert.equal(await inviteStatus(ownerId), "accepted");
  assert.equal((await signIn(email, password, false, meta)).ok, true);
});

test("an owner's own unactivated login still gets its first password from the link", async () => {
  const email = `own.login.${stamp()}@example.com`;
  const userId = await passwordlessLogin(email, "自有登入屋主");
  const owner = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, user_id, is_owner, display_name, email, locale)
     VALUES ($1, $2, true, '自有登入屋主', $3, 'zh-TW') RETURNING id::text`,
    [ORG_ID, userId, email],
  );
  const issued = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: owner.rows[0].id, pageId: owner.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const accepted = await acceptInvite(issued.token, "", "Owner1234", "", meta);
  assert.equal(accepted.ok, true);
  assert.equal(await contactUser(owner.rows[0].id), userId);
  assert.equal((await signIn(email, "Owner1234", false, meta)).ok, true);
});

test("a brand-new email creates a login, and replaying the used link changes nothing", async () => {
  const email = `new.owner.${stamp()}@example.com`;
  const { ownerId, token } = await ownerInviteFor(email);
  const none = await query(`SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, [email]);
  assert.equal(none.rowCount, 0);
  const accepted = await acceptInvite(token, "", "Owner1234", "", meta);
  assert.equal(accepted.ok, true);
  const created = await query<{ id: string }>(`SELECT id::text FROM auth.users WHERE lower(email) = lower($1)`, [email]);
  assert.equal(created.rowCount, 1);
  const userId = created.rows[0].id;
  assert.equal(await contactUser(ownerId), userId);
  assert.equal((await signIn(email, "Owner1234", false, meta)).ok, true);

  const before = await loginState(userId);
  const replay = await acceptInvite(token, "", ATTACKER_PASSWORD, "", meta);
  assert.deepEqual(replay, { ok: false, error: "used", kind: "owner" });
  const after = await loginState(userId);
  assert.equal(after.encrypted_password, before.encrypted_password);
  assert.equal(after.sessions, before.sessions);
  assert.equal((await signIn(email, ATTACKER_PASSWORD, false, meta)).ok, false);
});
