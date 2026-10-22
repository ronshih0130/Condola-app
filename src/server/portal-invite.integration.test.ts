import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptInvite, describeInvite, signIn } from "./auth";
import { query, tx, withClient } from "./db";
import { createProperty } from "./domain";
import { FlowError } from "./errors";
import { DEMO_PASSWORD } from "./demo-password";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { hashInviteToken, inviteStoredEmail, inviteTokenBytes, issuePortalInvite, noteBadInvite, portalLoginReady } from "./portal-invite";
import { ownerEditor, ownerPropertyNames } from "./queries";
import { resetAndSeed } from "./seed";
import type { Session } from "./types";

const meta = { ua: "test", ip: "203.0.113.10" };

async function secretCount(token: string) {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM portal_invite_secrets s
       JOIN invitations i ON i.id = s.invitation_id
      WHERE i.code_hash = $1`,
    [hashInviteToken(token)],
  );
  return Number(rows.rows[0].n);
}

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
  const previousSite = process.env.CONDOLA_SITE_URL;
  process.env.CONDOLA_SITE_URL = "https://staging.condola.app";
  const issued = await issuePortalInvite(manager, { kind: "tenant", contactId: row.contact_id, leaseId: row.lease_id, pageId: row.lease_id }, "https://condola-staging.condola.workers.dev");
  if (previousSite === undefined) delete process.env.CONDOLA_SITE_URL;
  else process.env.CONDOLA_SITE_URL = previousSite;
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  assert.ok(inviteTokenBytes(issued.token) >= 32);
  assert.match(issued.url, /^https:\/\/staging\.condola\.app\/accept\//);
  assert.equal(issued.url.includes("workers.dev"), false);
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
  const secret = await query<{ token: string }>(
    `SELECT s.token
       FROM portal_invite_secrets s
       JOIN invitations i ON i.id = s.invitation_id
      WHERE i.contact_id = $1 AND i.status = 'pending'`,
    [row.contact_id],
  );
  assert.equal(secret.rows[0].token, issued.token);
  await assert.rejects(() => tx(USERS.manager, (client) => client.query(`SELECT token FROM portal_invite_secrets`)));

  const reused = await issuePortalInvite(
    manager,
    { kind: "tenant", contactId: row.contact_id, leaseId: row.lease_id, pageId: row.lease_id },
    "http://127.0.0.1:43123",
  );
  assert.equal(reused.activated, false);
  if (reused.activated) return;
  assert.equal(reused.token, issued.token);
  assert.equal(reused.name, "李愛玲");
  assert.equal(reused.email, "ailing.li@tenant.demo");

  const replaced = await issuePortalInvite(
    manager,
    { kind: "tenant", contactId: row.contact_id, leaseId: row.lease_id, pageId: row.lease_id, rotate: true },
    "http://127.0.0.1:43123",
  );
  assert.equal(replaced.activated, false);
  if (replaced.activated) return;
  assert.equal(await secretCount(issued.token), 0);
  assert.equal(await secretCount(replaced.token), 1);
  assert.equal((await describeInvite(issued.token, meta)).state, "revoked");
  assert.notEqual(replaced.token, issued.token);

  await query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, [hashInviteToken(replaced.token)]);
  assert.equal(await secretCount(replaced.token), 0);
  assert.equal((await describeInvite(replaced.token, meta)).state, "expired");
  const expired = await acceptInvite(replaced.token, "", "Fresh1234", "Fresh1234", meta);
  assert.equal(expired.ok, false);
  const stillEmpty = await query<{ user_id: string | null }>(
    `SELECT user_id::text AS user_id FROM contacts WHERE id = $1`,
    [row.contact_id],
  );
  assert.equal(stillEmpty.rows[0].user_id, null);

  const live = await issuePortalInvite(manager, { kind: "tenant", contactId: row.contact_id, leaseId: row.lease_id, pageId: row.lease_id }, "https://app.condola.app");
  assert.equal(live.activated, false);
  if (live.activated) return;
  const weak = await acceptInvite(live.token, "", "short", "short", meta);
  assert.equal(weak.ok, false);
  if (!weak.ok) assert.equal(weak.error, "weak");
  const accepted = await acceptInvite(live.token, "", "Fresh1234", "Fresh1234", meta);
  assert.equal(accepted.ok, true);
  assert.equal(await secretCount(live.token), 0);
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
  const issued = await issuePortalInvite(staff(USERS.admin, "admin"), { kind: "owner", contactId: morgan.rows[0].id, pageId: morgan.rows[0].id }, "https://app.condola.app");
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
  const link = await issuePortalInvite(staff(USERS.admin, "admin"), { kind: "owner", contactId: minted.rows[0].id, pageId: minted.rows[0].id }, "http://127.0.0.1:43123");
  assert.equal(link.activated, false);
  if (link.activated) return;
  assert.equal(link.email, "");
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
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, "email");
  assert.equal(taken.ok, false);
  if (!taken.ok) assert.equal(taken.error, "auth");
  const after = await query<{ id: string; encrypted_password: string | null }>(
    `SELECT id::text, encrypted_password FROM auth.users WHERE lower(email) = lower($1)`,
    ["jianhong.chen@owner.demo"],
  );
  assert.equal(after.rows[0].id, existing.rows[0].id);
  assert.equal(after.rows[0].encrypted_password, existing.rows[0].encrypted_password);
  const stillOurs = await query<{ user_id: string | null }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [minted.rows[0].id]);
  assert.equal(stillOurs.rows[0].user_id, null);
  assert.equal(ours.rows[0].user_id, null);
  assert.notEqual(stillOurs.rows[0].user_id, existing.rows[0].id);
  const chosen = `owner.${Date.now().toString(36)}@example.com`;
  const acceptedMint = await acceptInvite(link.token, "", "Owner1234", "Owner1234", meta, chosen);
  assert.equal(acceptedMint.ok, true);
  if (acceptedMint.ok && acceptedMint.kind !== "team_member") assert.equal(acceptedMint.destination, "/o/statements");
  const mintedSignIn = await signIn(chosen, "Owner1234", false, meta);
  assert.equal(mintedSignIn.ok, true);
  const createdLogins = await query(`SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, [chosen]);
  assert.equal(createdLogins.rowCount, 1);
  const stored = await query<{ email: string }>(
    `SELECT email::text AS email FROM contacts WHERE id = $1`,
    [minted.rows[0].id],
  );
  assert.equal(stored.rows[0].email, chosen);
});

test("five typed emails lock that link and leave the shared office address usable", async () => {
  const ip = "198.51.100.77";
  const otherIp = "198.51.100.78";
  const first = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, locale)
     VALUES ($1, true, '次數屋主', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const issued = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: first.rows[0].id, pageId: first.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const attempt = { ua: "test", ip };
  const beforeChen = await query<{ encrypted_password: string | null }>(
    `SELECT encrypted_password FROM auth.users WHERE lower(email) = lower('jianhong.chen@owner.demo')`,
  );
  const emails = ["bad-0", "jianhong.chen@owner.demo", "bad-2", "jianhong.chen@owner.demo", "still-bad"];
  const results = [];
  for (const email of emails) {
    results.push(await acceptInvite(issued.token, "", "Owner1234", "Owner1234", attempt, email));
  }
  const expectedErrors = ["email", "auth", "email", "auth", "email"];
  results.forEach((result, index) => {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, expectedErrors[index]);
  });
  const afterChen = await query<{ encrypted_password: string | null }>(
    `SELECT encrypted_password FROM auth.users WHERE lower(email) = lower('jianhong.chen@owner.demo')`,
  );
  assert.equal(afterChen.rows[0].encrypted_password, beforeChen.rows[0].encrypted_password);
  assert.equal((await describeInvite(issued.token, { ip: otherIp })).state, "locked");
  const blocked = await acceptInvite(issued.token, "", "Owner1234", "Owner1234", { ua: "test", ip: otherIp }, "fresh.lock@example.com");
  assert.deepEqual(blocked, { ok: false, error: "locked", kind: "unknown" });
  const parked = await query(`SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, ["fresh.lock@example.com"]);
  assert.equal(parked.rowCount, 0);

  const second = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, locale)
     VALUES ($1, true, '另一連結屋主', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const other = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: second.rows[0].id, pageId: second.rows[0].id }, "https://app.condola.app");
  assert.equal(other.activated, false);
  if (other.activated) return;
  assert.equal((await describeInvite(other.token, { ip })).state, "ready");
  assert.equal((await describeInvite(other.token, { ip: otherIp })).state, "ready");
  if ((await describeInvite(other.token, { ip: otherIp })).state === "ready") {
    const view = await describeInvite(other.token, { ip: otherIp });
    if (view.state === "ready" && view.kind !== "team_member") assert.equal(view.email, "");
  }

  await query(`DELETE FROM portal_invite_attempts WHERE ip LIKE 'token:%'`);
  assert.equal((await describeInvite(issued.token, { ip })).state, "ready");
  assert.equal((await describeInvite(issued.token, { ip: otherIp })).state, "ready");
});

test("another firm cannot read the invited contact through the token", async () => {
  const secretPhone = "+886900111222";
  const contact = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, phone_e164, locale)
     VALUES ($1, true, '隔離電話屋主', $2, 'zh-TW') RETURNING id::text`,
    [ORG_ID, secretPhone],
  );
  const issued = await issuePortalInvite(staff(USERS.admin, "admin"), { kind: "owner", contactId: contact.rows[0].id, pageId: contact.rows[0].id }, "https://app.condola.app");
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
    () => issuePortalInvite(staff(USERS.accountant, "accountant"), { kind: "owner", contactId: owner.rows[0].id, pageId: owner.rows[0].id }, "https://app.condola.app"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
  await assert.rejects(
    () => issuePortalInvite(staff(USERS.coastAdmin, "admin", ORG2_ID), { kind: "owner", contactId: owner.rows[0].id, pageId: owner.rows[0].id }, "https://app.condola.app"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
  );
});

test("opening dead links does not lock a valid invite", async () => {
  const ip = "198.51.100.40";
  const owner = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '鎖定測試屋主', 'lock.owner@example.com', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const issued = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: owner.rows[0].id, pageId: owner.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await describeInvite(`missing-${i}`, { ip })).state, "invalid");
  }
  await query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, [hashInviteToken(issued.token)]);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await describeInvite(issued.token, { ip })).state, "expired");
  }
  const fresh = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, locale)
     VALUES ($1, true, '仍可用屋主', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const live = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: fresh.rows[0].id, pageId: fresh.rows[0].id }, "https://app.condola.app");
  assert.equal(live.activated, false);
  if (live.activated) return;
  assert.equal((await describeInvite(live.token, { ip })).state, "ready");
});

test("an office address locks on the 20th email rejection", async () => {
  const ip = "198.51.100.79";
  const contact = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, locale)
     VALUES ($1, true, '辦公室次數屋主', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const issued = await issuePortalInvite(staff(USERS.manager, "manager"), { kind: "owner", contactId: contact.rows[0].id, pageId: contact.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  for (let i = 0; i < 19; i += 1) await noteBadInvite(ip);
  assert.equal((await describeInvite(issued.token, { ip })).state, "ready");
  await noteBadInvite(ip);
  assert.equal((await describeInvite(issued.token, { ip })).state, "locked");
  assert.equal((await describeInvite(issued.token, { ip: "198.51.100.80" })).state, "ready");
});

test("two registered emails leave the link usable, and a new email then consumes it", async () => {
  const contact = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, locale)
     VALUES ($1, true, '連續拒絕屋主', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const issued = await issuePortalInvite(staff(USERS.admin, "admin"), { kind: "owner", contactId: contact.rows[0].id, pageId: contact.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const takenUsers = await query<{ id: string; email: string; encrypted_password: string | null }>(
    `SELECT id::text, email::text AS email, encrypted_password
       FROM auth.users
      WHERE lower(email) IN ('jianhong.chen@owner.demo', 'xiuying.lin@owner.demo')
      ORDER BY email`,
  );
  const attempt = { ua: "test", ip: "198.51.100.41" };
  const first = await acceptInvite(issued.token, "", "Owner1234", "Owner1234", attempt, "jianhong.chen@owner.demo");
  const second = await acceptInvite(issued.token, "", "Owner1234", "Owner1234", attempt, "xiuying.lin@owner.demo");
  assert.deepEqual(first, second);
  assert.deepEqual(first, { ok: false, error: "auth", kind: "owner" });
  const stillTaken = await query<{ id: string; email: string; encrypted_password: string | null }>(
    `SELECT id::text, email::text AS email, encrypted_password
       FROM auth.users
      WHERE lower(email) IN ('jianhong.chen@owner.demo', 'xiuying.lin@owner.demo')
      ORDER BY email`,
  );
  assert.deepEqual(stillTaken.rows, takenUsers.rows);
  const pending = await query<{ status: string }>(
    `SELECT status::text FROM invitations WHERE code_hash = $1`,
    [hashInviteToken(issued.token)],
  );
  assert.equal(pending.rows[0].status, "pending");
  assert.equal((await describeInvite(issued.token, attempt)).state, "ready");
  const chosen = `fresh.${Date.now().toString(36)}@example.com`;
  const accepted = await acceptInvite(issued.token, "", "Owner1234", "Owner1234", attempt, chosen);
  assert.equal(accepted.ok, true);
  const consumed = await query<{ status: string; email: string }>(
    `SELECT status::text, email::text AS email FROM invitations WHERE code_hash = $1`,
    [hashInviteToken(issued.token)],
  );
  assert.equal(consumed.rows[0].status, "accepted");
  assert.equal(consumed.rows[0].email, chosen);
  const created = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth.users WHERE lower(email) = lower($1)`,
    [chosen],
  );
  assert.equal(created.rows[0].n, "1");
  assert.equal((await describeInvite(issued.token, { ip: "198.51.100.42" })).state, "used");
  const signedIn = await signIn(chosen, "Owner1234", false, attempt);
  assert.equal(signedIn.ok, true);
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
  const invite = await query<{ code_hash: string; expires_at: Date; token: string }>(
    `SELECT i.code_hash, i.expires_at, s.token
       FROM invitations i
       JOIN portal_invite_secrets s ON s.invitation_id = i.id
      WHERE i.contact_id = $1 AND i.kind = 'owner'`,
    [created.ownerContactId],
  );
  assert.match(invite.rows[0].code_hash, /^[0-9a-f]{64}$/);
  assert.equal(invite.rows[0].code_hash.includes(invite.rows[0].token), false);
  const days = (invite.rows[0].expires_at.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6 && days < 8);
  const contact = await query<{ user_id: string | null }>(
    `SELECT user_id::text AS user_id FROM contacts WHERE id = $1`,
    [created.ownerContactId],
  );
  assert.equal(contact.rows[0].user_id, null);
  const login = await query(`SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, [`link.${stamp}@example.com`]);
  assert.equal(login.rowCount, 0);
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
  try {
    const issued = await issuePortalInvite(
      { ...staff(USERS.admin, "admin", orgId), environment: "sandbox" },
      { kind: "owner", contactId: contact.rows[0].id, pageId: contact.rows[0].id },
      "https://app.condola.app",
    );
    assert.equal(issued.activated, false);
    if (issued.activated) return;
    assert.equal(issued.email, email);
    const login = await query<{ id: string }>(`SELECT id::text FROM auth.users WHERE lower(email) = lower($1)`, [email]);
    assert.equal(login.rowCount, 0);
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
    { kind: "owner", contactId: contact.rows[0].id, pageId: contact.rows[0].id },
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

test("each owner invite shows only that owner's email and binds only that owner", async () => {
  const stamp = Date.now().toString(36);
  const emailA = `owner.a.${stamp}@example.com`;
  const emailB = `owner.b.${stamp}@example.com`;
  const inserted = await query<{ id: string; email: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '隔離屋主甲', $2, 'zh-TW'), ($1, true, '隔離屋主乙', $3, 'zh-TW')
     RETURNING id::text, email::text AS email`,
    [ORG_ID, emailA, emailB],
  );
  const ownerA = inserted.rows.find((row) => row.email === emailA);
  const ownerB = inserted.rows.find((row) => row.email === emailB);
  assert.ok(ownerA && ownerB);
  const manager = staff(USERS.manager, "manager");
  const issuedA = await issuePortalInvite(manager, { kind: "owner", contactId: ownerA.id, pageId: ownerA.id }, "https://staging.condola.app");
  const issuedB = await issuePortalInvite(manager, { kind: "owner", contactId: ownerB.id, pageId: ownerB.id }, "https://app.condola.app");
  assert.equal(issuedA.activated, false);
  assert.equal(issuedB.activated, false);
  if (issuedA.activated || issuedB.activated) return;
  assert.equal(issuedA.contactId, ownerA.id);
  assert.equal(issuedB.contactId, ownerB.id);
  assert.notEqual(issuedA.url, issuedB.url);
  assert.equal(issuedA.email, emailA);
  assert.equal(issuedB.email, emailB);
  const viewA = await describeInvite(issuedA.token, meta);
  const viewB = await describeInvite(issuedB.token, meta);
  assert.equal(viewA.state, "ready");
  assert.equal(viewB.state, "ready");
  if (viewA.state !== "ready" || viewA.kind === "team_member" || viewB.state !== "ready" || viewB.kind === "team_member") return;
  assert.equal(viewA.email, emailA);
  assert.equal(viewB.email, emailB);
  assert.equal(JSON.stringify(viewA).includes(emailB), false);
  assert.equal(JSON.stringify(viewB).includes(emailA), false);
  const accepted = await acceptInvite(issuedB.token, "", "Owner1234", "", meta);
  assert.equal(accepted.ok, true);
  const bound = await query<{ id: string; user_id: string | null; login: string | null }>(
    `SELECT c.id::text, c.user_id::text AS user_id, u.email::text AS login
       FROM contacts c
       LEFT JOIN auth.users u ON u.id = c.user_id
      WHERE c.id = ANY($1::uuid[])`,
    [[ownerA.id, ownerB.id]],
  );
  const rowA = bound.rows.find((row) => row.id === ownerA.id);
  const rowB = bound.rows.find((row) => row.id === ownerB.id);
  assert.equal(rowA?.user_id, null);
  assert.equal(rowB?.login, emailB);
  assert.notEqual(rowB?.user_id, null);
  const stillA = await describeInvite(issuedA.token, meta);
  assert.equal(stillA.state, "ready");
  if (stillA.state === "ready" && stillA.kind !== "team_member") assert.equal(stillA.email, emailA);
});

test("reissuing after activation gives each owner only their own email", async () => {
  const stamp = Date.now().toString(36);
  const emailA = `reissue.a.${stamp}@example.com`;
  const emailB = `reissue.b.${stamp}@example.com`;
  const inserted = await query<{ id: string; email: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '重發屋主甲', $2, 'zh-TW'), ($1, true, '重發屋主乙', $3, 'zh-TW')
     RETURNING id::text, email::text AS email`,
    [ORG_ID, emailA, emailB],
  );
  const ownerA = inserted.rows.find((row) => row.email === emailA);
  const ownerB = inserted.rows.find((row) => row.email === emailB);
  assert.ok(ownerA && ownerB);
  const manager = staff(USERS.manager, "manager");
  const issuedA = await issuePortalInvite(manager, { kind: "owner", contactId: ownerA.id, pageId: ownerA.id }, "https://staging.condola.app");
  const issuedB = await issuePortalInvite(manager, { kind: "owner", contactId: ownerB.id, pageId: ownerB.id }, "https://staging.condola.app");
  assert.equal(issuedA.activated, false);
  assert.equal(issuedB.activated, false);
  if (issuedA.activated || issuedB.activated) return;
  assert.equal((await acceptInvite(issuedA.token, "", "Owner1234", "", meta)).ok, true);
  assert.equal((await acceptInvite(issuedB.token, "", "Owner1234", "", meta)).ok, true);
  const idle = await issuePortalInvite(manager, { kind: "owner", contactId: ownerA.id, pageId: ownerA.id }, "https://staging.condola.app");
  assert.equal(idle.activated, true);
  await assert.rejects(
    () => issuePortalInvite(manager, { kind: "owner", contactId: ownerA.id, pageId: ownerB.id, rotate: true }, "https://staging.condola.app"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.portalMismatch",
  );
  const reA = await issuePortalInvite(manager, { kind: "owner", contactId: ownerA.id, pageId: ownerA.id, rotate: true }, "https://staging.condola.app");
  const reB = await issuePortalInvite(manager, { kind: "owner", contactId: ownerB.id, pageId: ownerB.id, rotate: true }, "https://staging.condola.app");
  assert.equal(reA.activated, false);
  assert.equal(reB.activated, false);
  if (reA.activated || reB.activated) return;
  assert.notEqual(reA.token, issuedA.token);
  assert.notEqual(reB.token, issuedB.token);
  assert.notEqual(reA.url, reB.url);
  assert.equal(reA.email, emailA);
  assert.equal(reB.email, emailB);
  assert.equal(reA.contactId, ownerA.id);
  assert.equal(reB.contactId, ownerB.id);
  const viewA = await describeInvite(reA.token, meta);
  const viewB = await describeInvite(reB.token, meta);
  assert.equal(viewA.state, "ready");
  assert.equal(viewB.state, "ready");
  if (viewA.state !== "ready" || viewA.kind === "team_member" || viewB.state !== "ready" || viewB.kind === "team_member") return;
  assert.equal(viewA.email, emailA);
  assert.equal(viewB.email, emailB);
  assert.equal(JSON.stringify(viewA).includes(emailB), false);
  assert.equal(JSON.stringify(viewB).includes(emailA), false);
  assert.equal((await describeInvite(issuedA.token, meta)).state, "used");
  assert.equal((await describeInvite(issuedB.token, meta)).state, "used");
  const before = await query<{ encrypted_password: string }>(
    `SELECT encrypted_password FROM auth.users WHERE lower(email) = lower($1)`,
    [emailA],
  );
  const wrong = await acceptInvite(reA.token, "", "Wrong1234", "", meta);
  assert.deepEqual(wrong, { ok: false, error: "auth", kind: "owner" });
  const after = await query<{ encrypted_password: string }>(
    `SELECT encrypted_password FROM auth.users WHERE lower(email) = lower($1)`,
    [emailA],
  );
  assert.equal(after.rows[0].encrypted_password, before.rows[0].encrypted_password);
  const stillB = await describeInvite(reB.token, meta);
  assert.equal(stillB.state, "ready");
  if (stillB.state === "ready" && stillB.kind !== "team_member") assert.equal(stillB.email, emailB);
  const audits = await query<{ body: string }>(
    `SELECT new_row::text AS body FROM audit_log
      WHERE org_id = $1 AND event_type = 'portal_invite_reissue' AND new_row->>'contactId' = ANY($2::text[])`,
    [ORG_ID, [ownerA.id, ownerB.id]],
  );
  assert.equal(audits.rows.length, 2);
  for (const row of audits.rows) {
    assert.equal(row.body.includes(reA.token), false);
    assert.equal(row.body.includes(reB.token), false);
    assert.equal(row.body.includes(reA.url), false);
    assert.equal(row.body.includes(reB.url), false);
  }
  const stored = await query<{ contact_id: string; email: string }>(
    `SELECT contact_id::text, email::text AS email FROM invitations WHERE code_hash = ANY($1::text[])`,
    [[hashInviteToken(reA.token), hashInviteToken(reB.token)]],
  );
  assert.equal(stored.rows.find((row) => row.contact_id === ownerA.id)?.email, emailA);
  assert.equal(stored.rows.find((row) => row.contact_id === ownerB.id)?.email, emailB);
});

test("a tenant password adds the owner role without taking the tenant contact", async () => {
  const email = "yawen.zhang@tenant.demo";
  const before = await query<{ id: string; user_id: string; encrypted_password: string }>(
    `SELECT c.id::text, c.user_id::text AS user_id, u.encrypted_password
       FROM contacts c
       JOIN auth.users u ON u.id = c.user_id
      WHERE c.org_id = $1 AND c.is_tenant AND lower(c.email::text) = lower($2)`,
    [ORG_ID, email],
  );
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].user_id, USERS.tenant);
  const owner = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '雙身分屋主', $2, 'zh-TW') RETURNING id::text`,
    [ORG_ID, email],
  );
  const issued = await issuePortalInvite(
    staff(USERS.manager, "manager"),
    { kind: "owner", contactId: owner.rows[0].id, pageId: owner.rows[0].id },
    "https://app.condola.app",
  );
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const view = await describeInvite(issued.token, meta);
  assert.equal(view.state, "ready");
  if (view.state === "ready" && view.kind !== "team_member") assert.equal(view.email, email);
  const wrongStarted = Date.now();
  const wrong = await acceptInvite(issued.token, "", "Wrong1234", "", meta);
  assert.ok(Date.now() - wrongStarted < 10_000);
  assert.deepEqual(wrong, { ok: false, error: "auth", kind: "owner" });
  const blocked = await acceptInvite(issued.token, "", DEMO_PASSWORD, "", meta, "", "yating.lin@songxin.demo");
  assert.deepEqual(blocked, { ok: false, error: "account", kind: "owner" });
  const untouched = await query<{ user_id: string | null }>(
    `SELECT user_id::text AS user_id FROM contacts WHERE id = $1`,
    [owner.rows[0].id],
  );
  assert.equal(untouched.rows[0].user_id, null);
  const started = Date.now();
  const accepted = await acceptInvite(issued.token, "", DEMO_PASSWORD, "", meta, "", email);
  assert.ok(Date.now() - started < 10_000);
  assert.equal(accepted.ok, true);
  if (accepted.ok && "destination" in accepted) assert.equal(accepted.destination, "/o/statements");
  const bound = await query<{ user_id: string | null }>(
    `SELECT user_id::text AS user_id FROM contacts WHERE id = $1`,
    [owner.rows[0].id],
  );
  assert.equal(bound.rows[0].user_id, USERS.tenant);
  const tenantStill = await query<{ user_id: string; encrypted_password: string }>(
    `SELECT c.user_id::text AS user_id, u.encrypted_password
       FROM contacts c
       JOIN auth.users u ON u.id = c.user_id
      WHERE c.id = $1`,
    [before.rows[0].id],
  );
  assert.equal(tenantStill.rows[0].user_id, USERS.tenant);
  assert.equal(tenantStill.rows[0].encrypted_password, before.rows[0].encrypted_password);
  const signedIn = await signIn(email, DEMO_PASSWORD, false, meta);
  assert.equal(signedIn.ok, true);
});

test("copying owner B does not revoke owner A, and the bound login sees only its property", async () => {
  const stamp = Date.now().toString(36);
  const emailA = `prop.a.${stamp}@example.com`;
  const emailB = `prop.b.${stamp}@example.com`;
  const inserted = await query<{ id: string; email: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '物件屋主甲', $2, 'zh-TW'), ($1, true, '物件屋主乙', $3, 'zh-TW')
     RETURNING id::text, email::text AS email`,
    [ORG_ID, emailA, emailB],
  );
  const ownerA = inserted.rows.find((row) => row.email === emailA);
  const ownerB = inserted.rows.find((row) => row.email === emailB);
  assert.ok(ownerA && ownerB);
  const propertyA = await query<{ id: string }>(
    `INSERT INTO properties (org_id, name, country_code, currency, timezone, default_rental_mode)
     VALUES ($1, '物件甲', 'TW', 'TWD', 'Asia/Taipei', 'whole_unit') RETURNING id::text`,
    [ORG_ID],
  );
  const propertyB = await query<{ id: string }>(
    `INSERT INTO properties (org_id, name, country_code, currency, timezone, default_rental_mode)
     VALUES ($1, '物件乙', 'TW', 'TWD', 'Asia/Taipei', 'whole_unit') RETURNING id::text`,
    [ORG_ID],
  );
  await query(
    `INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary)
     VALUES ($1, $2, $3, true), ($1, $4, $5, true)`,
    [ORG_ID, propertyA.rows[0].id, ownerA.id, propertyB.rows[0].id, ownerB.id],
  );
  const manager = staff(USERS.manager, "manager");
  const issuedA = await issuePortalInvite(manager, { kind: "owner", contactId: ownerA.id, pageId: ownerA.id }, "https://app.condola.app");
  assert.equal(issuedA.activated, false);
  if (issuedA.activated) return;
  const copiedAgain = await issuePortalInvite(manager, { kind: "owner", contactId: ownerA.id, pageId: ownerA.id }, "https://app.condola.app");
  assert.equal(copiedAgain.activated, false);
  if (copiedAgain.activated) return;
  assert.equal(copiedAgain.token, issuedA.token);
  assert.equal(copiedAgain.name, "物件屋主甲");
  assert.equal(copiedAgain.email, emailA);
  await assert.rejects(
    () => issuePortalInvite(manager, { kind: "owner", contactId: ownerA.id, pageId: ownerB.id }, "https://app.condola.app"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.portalMismatch",
  );
  assert.equal((await describeInvite(issuedA.token, meta)).state, "ready");
  const issuedB = await issuePortalInvite(manager, { kind: "owner", contactId: ownerB.id, pageId: ownerB.id }, "https://app.condola.app");
  assert.equal(issuedB.activated, false);
  if (issuedB.activated) return;
  assert.notEqual(issuedB.token, issuedA.token);
  assert.equal(issuedB.name, "物件屋主乙");
  assert.equal((await describeInvite(issuedA.token, meta)).state, "ready");
  const rotatedB = await issuePortalInvite(
    manager,
    { kind: "owner", contactId: ownerB.id, pageId: ownerB.id, rotate: true },
    "https://app.condola.app",
  );
  assert.equal(rotatedB.activated, false);
  if (rotatedB.activated) return;
  assert.notEqual(rotatedB.token, issuedB.token);
  assert.equal((await describeInvite(issuedB.token, meta)).state, "revoked");
  assert.equal((await describeInvite(issuedA.token, meta)).state, "ready");
  const accepted = await acceptInvite(rotatedB.token, "", "Owner1234", "", meta);
  assert.equal(accepted.ok, true);
  const bound = await query<{ user_id: string }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [ownerB.id]);
  const userId = bound.rows[0].user_id;
  assert.ok(userId);
  const seen = await tx(userId, (client) =>
    client.query<{ name: string }>(`SELECT name FROM properties WHERE archived_at IS NULL ORDER BY name`),
  );
  assert.deepEqual(
    seen.rows.map((row) => row.name),
    ["物件乙"],
  );
  const portal = await ownerPropertyNames({ ...staff(userId, "admin"), userId, kind: "owner" });
  assert.deepEqual(
    portal.map((row) => row.name),
    ["物件乙"],
  );
  const untouched = await query<{ user_id: string | null }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [ownerA.id]);
  assert.equal(untouched.rows[0].user_id, null);
  assert.equal(await secretCount(rotatedB.token), 0);
  assert.equal(await secretCount(issuedB.token), 0);
  assert.equal(await secretCount(issuedA.token), 1);
});

test("portal invite secrets stay on service_role and disappear when the link expires without an update", async () => {
  const guard = await query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string }>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*)::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'portal_invite_secrets'`,
  );
  assert.equal(guard.rows[0].relrowsecurity, true);
  assert.equal(guard.rows[0].relforcerowsecurity, true);
  assert.equal(guard.rows[0].policies, "0");
  const grants = await query<{ grantee: string }>(
    `SELECT DISTINCT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'portal_invite_secrets'`,
  );
  assert.deepEqual(grants.rows.map((row) => row.grantee).sort(), ["service_role"]);
  const exposed = await query<{ grantee: string }>(
    `SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_schema = 'app'
        AND routine_name IN ('drop_portal_invite_secret', 'purge_portal_invite_secrets')
        AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
  );
  assert.equal(exposed.rows.length, 0);

  const contact = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '到期屋主', 'expired.secret@example.com', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const manager = staff(USERS.manager, "manager");
  const issued = await issuePortalInvite(manager, { kind: "owner", contactId: contact.rows[0].id, pageId: contact.rows[0].id }, "https://app.condola.app");
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  const invitation = await query<{ id: string }>(
    `SELECT id::text FROM invitations WHERE code_hash = $1`,
    [hashInviteToken(issued.token)],
  );
  await withClient(async (client) => {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE service_role`);
    const secret = await client.query<{ token: string }>(
      `SELECT token FROM portal_invite_secrets WHERE invitation_id = $1`,
      [invitation.rows[0].id],
    );
    assert.equal(secret.rows[0].token, issued.token);
    await client.query("ROLLBACK");
  });
  await withClient(async (client) => {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE anon`);
    await assert.rejects(() => client.query(`SELECT token FROM portal_invite_secrets`), /permission denied/i);
    await client.query("ROLLBACK");
  });
  await withClient(async (client) => {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE authenticated`);
    await assert.rejects(() => client.query(`SELECT token FROM portal_invite_secrets`), /permission denied/i);
    await client.query("ROLLBACK");
  });
  await withClient(async (client) => {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE authenticated`);
    await assert.rejects(() => client.query(`SELECT app.purge_portal_invite_secrets()`), /permission denied/i);
    await client.query("ROLLBACK");
  });

  await query(`ALTER TABLE invitations DISABLE TRIGGER portal_invite_secrets_drop`);
  try {
    await query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, [hashInviteToken(issued.token)]);
  } finally {
    await query(`ALTER TABLE invitations ENABLE TRIGGER portal_invite_secrets_drop`);
  }
  assert.equal(await secretCount(issued.token), 1);
  const other = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '另一屋主', 'other.secret@example.com', 'zh-TW') RETURNING id::text`,
    [ORG_ID],
  );
  const issuedOther = await issuePortalInvite(manager, { kind: "owner", contactId: other.rows[0].id, pageId: other.rows[0].id }, "https://app.condola.app");
  assert.equal(issuedOther.activated, false);
  assert.equal(await secretCount(issued.token), 0);
  const stillPending = await query<{ status: string }>(
    `SELECT status::text FROM invitations WHERE code_hash = $1`,
    [hashInviteToken(issued.token)],
  );
  assert.equal(stillPending.rows[0].status, "pending");
  assert.equal((await describeInvite(issued.token, meta)).state, "expired");
});

test("a pending invite stored before the secret table is replaced and copied", async () => {
  const stamp = Date.now().toString(36);
  const email = `old.invite.${stamp}@example.com`;
  const contact = await query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
     VALUES ($1, true, '舊連結屋主', $2, 'zh-TW') RETURNING id::text`,
    [ORG_ID, email],
  );
  const user = await query<{ id: string }>(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, role, aud)
     VALUES (gen_random_uuid(), $1, crypt('Owner1234', gen_salt('bf')), now(), '{}'::jsonb, 'authenticated', 'authenticated')
     RETURNING id::text`,
    [email],
  );
  await query(`INSERT INTO profiles (id, display_name, email) VALUES ($1, '舊連結屋主', $2)`, [user.rows[0].id, email]);
  await query(`UPDATE contacts SET user_id = $2 WHERE id = $1`, [contact.rows[0].id, user.rows[0].id]);
  const oldHash = hashInviteToken(`old-format-${stamp}`);
  await query(
    `INSERT INTO invitations (org_id, kind, contact_id, email, code_hash, status, expires_at, invited_by)
     VALUES ($1, 'owner', $2, $3, $4, 'pending', now() + interval '7 days', $5)`,
    [ORG_ID, contact.rows[0].id, email, oldHash, USERS.manager],
  );
  const stored = await query(
    `SELECT 1 FROM portal_invite_secrets s JOIN invitations i ON i.id = s.invitation_id WHERE i.code_hash = $1`,
    [oldHash],
  );
  assert.equal(stored.rowCount, 0);
  const manager = staff(USERS.manager, "manager");
  const editor = await ownerEditor(manager, contact.rows[0].id);
  assert.equal(editor?.invitePending, true);
  assert.equal(await portalLoginReady(user.rows[0].id), true);
  const issued = await issuePortalInvite(
    manager,
    { kind: "owner", contactId: contact.rows[0].id, pageId: contact.rows[0].id },
    "https://app.condola.app",
  );
  assert.equal(issued.activated, false);
  if (issued.activated) return;
  assert.equal(issued.name, "舊連結屋主");
  assert.equal(issued.email, email);
  assert.match(issued.url, /\/accept\//);
  const old = await query<{ status: string }>(`SELECT status::text FROM invitations WHERE code_hash = $1`, [oldHash]);
  assert.equal(old.rows[0].status, "revoked");
  assert.equal(await secretCount(issued.token), 1);
  assert.equal((await describeInvite(issued.token, meta)).state, "ready");
});
