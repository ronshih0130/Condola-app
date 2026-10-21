import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptInvite, describeInvite, signIn } from "./auth";
import { query, tx } from "./db";
import { createProperty } from "./domain";
import { FlowError } from "./errors";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { hashInviteToken, inviteStoredEmail, inviteTokenBytes, issuePortalInvite } from "./portal-invite";
import { resetAndSeed } from "./seed";
import type { Session } from "./types";

const meta = { ua: "test", ip: "203.0.113.10" };

function staff(userId: string, role: Session["role"], orgId = ORG_ID): Session {
  return {
    userId,
    sessionId: "portal-invite",
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

test.before(async () => {
  await resetAndSeed();
});

test.beforeEach(async () => {
  await query(`DELETE FROM portal_invite_attempts`);
});

test("a manager copies a one-time tenant link and an expired or used link cannot set a password", async () => {
  const lease = await query<{ lease_id: string; contact_id: string }>(
    `SELECT l.id::text AS lease_id, c.id::text AS contact_id
       FROM contacts c
       JOIN lease_parties lp ON lp.contact_id = c.id AND lp.role = 'primary'
       JOIN leases l ON l.id = lp.lease_id
      WHERE c.org_id = $1 AND c.display_name = '李愛玲'`,
    [ORG_ID],
  );
  const row = lease.rows[0];
  const manager = staff(USERS.manager, "manager");
  const issued = await issuePortalInvite(manager, { kind: "tenant", contactId: row.contact_id, leaseId: row.lease_id }, "https://condola-staging.condola.workers.dev");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  assert.ok(inviteTokenBytes(issued.token) >= 32);
  assert.match(issued.url, /^https:\/\/condola-staging\.condola\.workers\.dev\/accept\//);
  assert.equal(issued.email, "ailing.li@tenant.demo");
  const stored = await query<{ code_hash: string; expires_at: Date; raw: string | null }>(
    `SELECT code_hash, expires_at, NULL::text AS raw FROM invitations WHERE contact_id = $1 AND status = 'pending'`,
    [row.contact_id],
  );
  assert.equal(stored.rows[0].code_hash, hashInviteToken(issued.token));
  assert.equal(stored.rows[0].code_hash.includes(issued.token), false);
  const days = (stored.rows[0].expires_at.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6 && days < 8);

  const audit = await query<{ body: string }>(
    `SELECT new_row::text AS body FROM audit_log
      WHERE org_id = $1 AND event_type = 'portal_invite'
      ORDER BY occurred_at DESC LIMIT 1`,
    [ORG_ID],
  );
  assert.equal(audit.rows[0].body.includes(issued.token), false);
  assert.match(audit.rows[0].body, /tenant/);

  const replaced = await issuePortalInvite(manager, { kind: "tenant", contactId: row.contact_id, leaseId: row.lease_id }, "http://127.0.0.1:43123");
  assert.equal(replaced.activated, false);
  if (replaced.activated) return;
  assert.equal((await describeInvite(issued.token, meta)).state, "revoked");
  assert.notEqual(replaced.token, issued.token);

  await query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, [hashInviteToken(replaced.token)]);
  assert.equal((await describeInvite(replaced.token, meta)).state, "expired");
  const expired = await acceptInvite(replaced.token, "", "Fresh1234", "Fresh1234", meta);
  assert.equal(expired.ok, false);
  const stillEmpty = await query<{ ready: boolean }>(
    `SELECT (encrypted_password IS NOT NULL AND btrim(encrypted_password) <> '') AS ready
       FROM auth.users u JOIN contacts c ON c.user_id = u.id WHERE c.id = $1`,
    [row.contact_id],
  );
  assert.equal(stillEmpty.rows[0].ready, false);

  const live = await issuePortalInvite(manager, { kind: "tenant", contactId: row.contact_id, leaseId: row.lease_id }, "https://app.condola.app");
  assert.equal(live.activated, false);
  if (live.activated) return;
  const weak = await acceptInvite(live.token, "", "short", "short", meta);
  assert.equal(weak.ok, false);
  if (!weak.ok) assert.equal(weak.error, "weak");
  const accepted = await acceptInvite(live.token, "", "Fresh1234", "Fresh1234", meta);
  assert.equal(accepted.ok, true);
  if (accepted.ok && accepted.kind !== "team_member") assert.equal(accepted.destination, "/t");
  const again = await acceptInvite(live.token, "", "Fresh1234", "Fresh1234", meta);
  assert.equal(again.ok, false);
  const signedIn = await signIn("ailing.li@tenant.demo", "Fresh1234", false, meta);
  assert.equal(signedIn.ok, true);
  const usedAudit = await query<{ body: string }>(
    `SELECT new_row::text AS body FROM audit_log WHERE event_type = 'portal_invite_accept' AND new_row->>'contactId' = $1`,
    [row.contact_id],
  );
  assert.equal(usedAudit.rows[0].body.includes(live.token), false);
});

test("an owner without a password gets a login on the link, including a minted address", async () => {
  const morgan = await query<{ id: string }>(
    `SELECT id::text FROM contacts WHERE org_id = $1 AND display_name = 'Morgan Lee'`,
    [ORG_ID],
  );
  const issued = await issuePortalInvite(staff(USERS.admin, "admin"), { kind: "owner", contactId: morgan.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  assert.equal(issued.email, "morgan.lee@owner.demo");
  const morganView = await describeInvite(issued.token, meta);
  assert.equal(morganView.state, "ready");
  if (morganView.state === "ready" && morganView.kind !== "team_member") {
    assert.equal(morganView.collectEmail, false);
    assert.equal(morganView.email, "morgan.lee@owner.demo");
  }
  const accepted = await acceptInvite(issued.token, "", "Owner1234", "Owner1234", meta, "other.person@example.com");
  assert.equal(accepted.ok, true);
  if (accepted.ok && accepted.kind !== "team_member") assert.equal(accepted.destination, "/o/statements");
  const signedIn = await signIn("morgan.lee@owner.demo", "Owner1234", false, meta);
  assert.equal(signedIn.ok, true);
  const unchanged = await signIn("other.person@example.com", "Owner1234", false, meta);
  assert.equal(unchanged.ok, false);

  const minted = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, locale)
     VALUES ($1, true, '無信箱屋主', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const link = await issuePortalInvite(staff(USERS.admin, "admin"), { kind: "owner", contactId: minted.rows[0].id }, "http://127.0.0.1:43123");
  assert.equal(link.activated, false);
  if (link.activated) return;
  assert.match(link.email, /^portal-[0-9a-f-]{36}@demo\.condola\.local$/);
  const view = await describeInvite(link.token, meta);
  assert.equal(view.state, "ready");
  if (view.state === "ready" && view.kind !== "team_member") {
    assert.equal(view.collectEmail, true);
    assert.equal(view.email, "");
    assert.equal(JSON.stringify(view).includes("demo.condola.local"), false);
  }
  const existing = await query<{ id: string; encrypted_password: string | null }>(
    `SELECT id::text, encrypted_password FROM auth.users WHERE lower(email) = lower($1)`,
    ["jianhong.chen@owner.demo"],
  );
  const ours = await query<{ user_id: string }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [minted.rows[0].id]);
  const missing = await acceptInvite(link.token, "", "Owner1234", "Owner1234", meta, "");
  const taken = await acceptInvite(link.token, "", "Owner1234", "Owner1234", meta, "jianhong.chen@owner.demo");
  assert.deepEqual(missing, taken);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, "email");
  const after = await query<{ id: string; encrypted_password: string | null }>(
    `SELECT id::text, encrypted_password FROM auth.users WHERE lower(email) = lower($1)`,
    ["jianhong.chen@owner.demo"],
  );
  assert.equal(after.rows[0].id, existing.rows[0].id);
  assert.equal(after.rows[0].encrypted_password, existing.rows[0].encrypted_password);
  const stillOurs = await query<{ user_id: string }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [minted.rows[0].id]);
  assert.equal(stillOurs.rows[0].user_id, ours.rows[0].user_id);
  assert.notEqual(stillOurs.rows[0].user_id, existing.rows[0].id);
  const chosen = `owner.${Date.now().toString(36)}@example.com`;
  const acceptedMint = await acceptInvite(link.token, "", "Owner1234", "Owner1234", meta, chosen);
  assert.equal(acceptedMint.ok, true);
  if (acceptedMint.ok && acceptedMint.kind !== "team_member") assert.equal(acceptedMint.destination, "/o/statements");
  const mintedSignIn = await signIn(chosen, "Owner1234", false, meta);
  assert.equal(mintedSignIn.ok, true);
  const leftover = await query(`SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, [link.email]);
  assert.equal(leftover.rowCount, 0);
  const stored = await query<{ email: string }>(
    `SELECT email::text AS email FROM contacts WHERE id = $1`,
    [minted.rows[0].id],
  );
  assert.equal(stored.rows[0].email, chosen);
});

test("five typed emails lock that link and that address, without saying which emails exist", async () => {
  const ip = "198.51.100.77";
  const otherIp = "198.51.100.78";
  const first = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, locale)
     VALUES ($1, true, '次數屋主', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const issued = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: first.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const attempt = { ua: "test", ip };
  const emails = ["bad-0", "jianhong.chen@owner.demo", "bad-2", "jianhong.chen@owner.demo", "still-bad"];
  const results = [];
  for (const email of emails) {
    results.push(await acceptInvite(issued.token, "", "Owner1234", "Owner1234", attempt, email));
  }
  for (const result of results) assert.deepEqual(result, { ok: false, error: "email", kind: "owner" });
  assert.equal((await describeInvite(issued.token, { ip: otherIp })).state, "invalid");
  const blocked = await acceptInvite(issued.token, "", "Owner1234", "Owner1234", { ua: "test", ip: otherIp }, "fresh.lock@example.com");
  assert.deepEqual(blocked, { ok: false, error: "invalid", kind: "unknown" });
  const parked = await query(`SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, ["fresh.lock@example.com"]);
  assert.equal(parked.rowCount, 0);

  const second = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, locale)
     VALUES ($1, true, '另一連結屋主', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const other = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: second.rows[0].id }, "https://app.condola.app");
  assert.equal(other.activated, false);
  if (other.activated) return;
  assert.equal((await describeInvite(other.token, { ip })).state, "invalid");
  assert.equal((await describeInvite(other.token, { ip: otherIp })).state, "ready");
  if ((await describeInvite(other.token, { ip: otherIp })).state === "ready") {
    const view = await describeInvite(other.token, { ip: otherIp });
    if (view.state === "ready" && view.kind !== "team_member") assert.equal(view.email, "");
  }

  await query(`DELETE FROM portal_invite_attempts WHERE ip LIKE 'token:%'`);
  assert.equal((await describeInvite(issued.token, { ip })).state, "invalid");
  assert.equal((await describeInvite(issued.token, { ip: otherIp })).state, "ready");
});

test("another firm cannot read the invited contact through the token", async () => {
  const secretPhone = "+886900111222";
  const contact = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, phone_e164, locale)
     VALUES ($1, true, '隔離電話屋主', $2, 'zh-TW') RETURNING id::text`,
    [ORG_ID, secretPhone],
  );
  const issued = await issuePortalInvite(staff(USERS.admin, "admin"), { kind: "owner", contactId: contact.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const coast = await tx(USERS.coastAdmin, async (client) => {
    const invites = await client.query(`SELECT email::text, contact_id::text FROM invitations WHERE code_hash = $1`, [hashInviteToken(issued.token)]);
    const people = await client.query(`SELECT display_name, phone_e164, email::text FROM contacts WHERE id = $1`, [contact.rows[0].id]);
    return { invites: invites.rowCount, people: people.rowCount };
  });
  assert.equal(coast.invites, 0);
  assert.equal(coast.people, 0);
  const view = await describeInvite(issued.token, { ip: "203.0.113.60" });
  const body = JSON.stringify(view);
  assert.equal(body.includes(secretPhone), false);
  assert.equal(body.includes("demo.condola.local"), false);
  assert.equal(body.includes(issued.token), false);
  if (view.state === "ready" && view.kind !== "team_member") {
    assert.deepEqual(Object.keys(view).sort(), ["collectEmail", "email", "firm", "kind", "state"]);
    assert.equal(view.email, "");
    assert.equal(view.firm, "松信住宅管理");
  }
});

test("another firm and an accountant cannot issue a portal link", async () => {
  const owner = await query<{ id: string }>(
    `SELECT id::text FROM contacts WHERE org_id = $1 AND display_name = '林秀英'`,
    [ORG_ID],
  );
  await assert.rejects(
    () => issuePortalInvite(staff(USERS.accountant, "accountant"), { kind: "owner", contactId: owner.rows[0].id }, "https://app.condola.app"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
  await assert.rejects(
    () => issuePortalInvite(staff(USERS.coastAdmin, "admin", ORG2_ID), { kind: "owner", contactId: owner.rows[0].id }, "https://app.condola.app"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
  );
});

test("repeated bad tokens lock that address", async () => {
  const ip = "198.51.100.40";
  const owner = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '鎖定測試屋主', 'lock.owner@example.com', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const issued = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: owner.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await describeInvite(`missing-${i}`, { ip })).state, "invalid");
  }
  assert.equal((await describeInvite(issued.token, { ip })).state, "invalid");
  await query(`DELETE FROM portal_invite_attempts WHERE ip = $1`, [ip]);
  assert.equal((await describeInvite(issued.token, { ip })).state, "ready");
});

test("a new property stores a 7-day owner invite hash and drops the raw token", async () => {
  const stamp = Date.now().toString(36);
  const created = await createProperty(staff(USERS.admin, "admin"), {
    name: `邀請物件 ${stamp}`,
    city: "台北市",
    district: "中山區",
    street: "測試路9號",
    currency: "TWD",
    ownerMode: "new",
    ownerName: "連結屋主",
    ownerPhone: "0912000111",
    ownerEmail: `link.${stamp}@example.com`,
    canViewTenantPhone: false,
    unitLabel: "2F",
    floor: "2",
    rentalMode: "whole_unit",
    rooms: [],
  });
  assert.equal(created.inviteCode, null);
  const invite = await query<{ code_hash: string; expires_at: Date }>(
    `SELECT code_hash, expires_at FROM invitations WHERE contact_id = $1 AND kind = 'owner'`,
    [created.ownerContactId],
  );
  assert.match(invite.rows[0].code_hash, /^[0-9a-f]{64}$/);
  const days = (invite.rows[0].expires_at.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6 && days < 8);
});

test("a sandbox owner keeps a stored email, including owner1.demo@example.com", async () => {
  assert.equal(inviteStoredEmail("owner1.demo@example.com"), "owner1.demo@example.com");
  const orgId = randomUUID();
  const email = `owner1.demo.${Date.now().toString(36)}@example.com`;
  await query(
    `INSERT INTO organizations (
       id, name, country_code, jurisdiction_id, default_currency, timezone, environment, live_org_id, created_by
     )
     SELECT $1, '北岸管理', country_code, jurisdiction_id, default_currency, timezone, 'sandbox', id, $2
       FROM organizations WHERE id = $3`,
    [orgId, USERS.admin, ORG_ID],
  );
  await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [orgId, USERS.admin]);
  const contact = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '範屋主甲', $2, 'zh-TW') RETURNING id::text`,
    [orgId, email],
  );
  let userId: string | null = null;
  try {
    const issued = await issuePortalInvite(
      { ...staff(USERS.admin, "admin", orgId), environment: "sandbox" },
      { kind: "owner", contactId: contact.rows[0].id },
      "https://app.condola.app",
    );
    assert.equal(issued.activated, false);
    if (issued.activated) return;
    assert.equal(issued.email, email);
    const login = await query<{ id: string }>(`SELECT id::text FROM auth.users WHERE lower(email) = lower($1)`, [email]);
    userId = login.rows[0].id;
    await query(
      `UPDATE auth.users SET email = 'portal-' || id::text || '@demo.condola.local' WHERE id = $1`,
      [userId],
    );
    await query(
      `UPDATE invitations SET email = 'portal-' || $2 || '@demo.condola.local' WHERE code_hash = $1`,
      [hashInviteToken(issued.token), userId],
    );
    const view = await describeInvite(issued.token, { ip: "203.0.113.90" });
    assert.equal(view.state, "ready");
    if (view.state === "ready" && view.kind !== "team_member") {
      assert.equal(view.collectEmail, false);
      assert.equal(view.email, email);
    }
    assert.equal(JSON.stringify(view).includes("demo.condola.local"), false);
  } finally {
    await query(`DELETE FROM invitations WHERE org_id = $1`, [orgId]);
    await query(`UPDATE contacts SET user_id = NULL WHERE org_id = $1`, [orgId]);
    await query(`DELETE FROM contacts WHERE org_id = $1`, [orgId]);
    await query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    if (userId) {
      await query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
    }
    await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  }
});

test("a second submit cannot accept the same link twice", async () => {
  const email = `once.${Date.now().toString(36)}@example.com`;
  const contact = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '重複送出屋主', $2, 'zh-TW') RETURNING id::text`,
    [ORG_ID, email],
  );
  const issued = await issuePortalInvite(
    staff(USERS.manager, "manager"),
    { kind: "owner", contactId: contact.rows[0].id },
    "https://app.condola.app",
  );
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const [first, second] = await Promise.all([
    acceptInvite(issued.token, "", "Owner1234", "Owner1234", { ua: "test", ip: "198.51.100.90" }),
    acceptInvite(issued.token, "", "Owner1234", "Owner1234", { ua: "test", ip: "198.51.100.91" }),
  ]);
  const results = [first, second];
  assert.equal(results.filter((result) => result.ok).length, 1);
  const failed = results.find((result) => !result.ok);
  assert.equal(failed?.ok, false);
  if (failed && !failed.ok) assert.ok(failed.error === "used" || failed.error === "invalid");
  const users = await query<{ n: string }>(`SELECT count(*)::text AS n FROM auth.users WHERE lower(email) = lower($1)`, [email]);
  assert.equal(users.rows[0].n, "1");
});
