import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  acceptTeamInvite, hashInviteToken, inviteMember, resendInvite, revokeInvite,
} from "./auth";
import { query, withClient } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

const password = "Fresh1234";
const meta = { ua: "team-link-integration", ip: "127.0.0.1" };
const prefix = `team-link-${randomUUID()}`;
const emails: string[] = [];
const orgIds: string[] = [];
const admins = new Map<string, Session>();
const keys = [
  "TEAM_INVITES_ORG_ALLOWLIST", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
let previous: Array<string | undefined>;
let liveOrgId: string;
let sandboxOrgId: string;
let otherOrgId: string;

function admin(orgId = liveOrgId): Session {
  const session = admins.get(orgId);
  assert.ok(session, `Missing fixture admin for ${orgId}`);
  return { ...session };
}

function email(label: string) {
  const target = `${prefix}-${label}-${randomUUID()}@example.com`;
  emails.push(target);
  return target;
}

function hasKey(key: string) {
  return (error: unknown) => error instanceof FlowError && error.key === key;
}

async function createUser(label: string) {
  const target = email(label);
  const result = await query<{ id: string }>(
    `INSERT INTO auth.users
       (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, role, aud)
     VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), now(), '{}'::jsonb,
             'authenticated', 'authenticated')
     RETURNING id::text`,
    [target, password],
  );
  const id = result.rows[0].id;
  await query(
    `INSERT INTO profiles (id, email, display_name) VALUES ($1, $2, 'Fixture member')
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`,
    [id, target],
  );
  return { id, email: target };
}

async function createOrganization(label: string, parentOrgId: string | null = null) {
  const user = await createUser(`${label}-admin`);
  const id = randomUUID();
  const environment = parentOrgId === null ? "live" : "sandbox";

  await query(
    `INSERT INTO organizations
       (id, name, country_code, default_currency, environment, live_org_id,
        created_by, plan_tier, settings)
     VALUES ($1, $2, 'TW', 'TWD', $3, $4, $5, 'free',
             '{"plan":{"tier":"standard"}}'::jsonb)`,
    [id, `${prefix}-${label}`, environment, parentOrgId, user.id],
  );
  orgIds.push(id);

  await query(
    `INSERT INTO org_members (org_id, user_id, role, status)
     VALUES ($1, $2, 'admin', 'active')
     ON CONFLICT (org_id, user_id) DO UPDATE
       SET role = EXCLUDED.role, status = EXCLUDED.status`,
    [id, user.id],
  );
  admins.set(id, {
    userId: user.id,
    sessionId: "test", email: user.email, name: "Admin",
    kind: "staff", role: "admin", orgId: id, liveOrgId: parentOrgId ?? id,
    environment, locale: "zh-TW", calendar: "gregorian", leaseId: null,
  });
  return id;
}

async function issue(label: string) {
  return inviteMember(admin(), { email: email(label), name: "Hire", role: "accountant" });
}

async function accept(token: string, sessionEmail = "") {
  return withClient((client) =>
    acceptTeamInvite(client, token, "Hire", password, meta, sessionEmail));
}

async function row(id: string) {
  const result = await query<{ status: string; code_hash: string; role: string; expires_at: Date }>(
    `SELECT status::text, code_hash, role::text, expires_at FROM invitations WHERE id = $1`, [id],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function accountRows(target: string, orgId = liveOrgId) {
  const users = await query<{ id: string }>(
    `SELECT id::text FROM auth.users WHERE lower(email::text) = lower($1)`, [target],
  );
  const members = await query<{ role: string }>(
    `SELECT m.role::text FROM org_members m
       JOIN auth.users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND lower(u.email::text) = lower($2)`,
    [orgId, target],
  );
  return { users: users.rows, members: members.rows };
}

async function pending(orgId = liveOrgId) {
  const token = randomBytes(32).toString("base64url");
  const target = email("direct");
  const result = await query<{ id: string }>(
    `INSERT INTO invitations (org_id, kind, role, email, code_hash, expires_at, invited_by)
     VALUES ($1, 'team_member', 'accountant', $2, $3, now() + interval '1 day', $4)
     RETURNING id::text`,
    [orgId, target, hashInviteToken(token), admin(orgId).userId],
  );
  return { token, email: target, invitationId: result.rows[0].id };
}

async function emailLogCount() {
  const exists = await query<{ present: boolean }>(
    `SELECT to_regclass('public.email_log') IS NOT NULL AS present`,
  );
  if (!exists.rows[0].present) return null;
  const result = await query<{ n: number }>(`SELECT count(*)::int AS n FROM email_log`);
  return result.rows[0].n;
}

async function assertNoRawToken(token: string) {
  // to_jsonb covers every column, including future secret-bearing columns.
  for (const table of ["invitations", "audit_log"]) {
    const result = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} r
        WHERE strpos(to_jsonb(r)::text, $1) > 0`, [token],
    );
    assert.equal(result.rows[0].n, 0, `${table} contains a raw token`);
  }
  if (await emailLogCount() !== null) {
    const result = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM email_log r
        WHERE strpos(to_jsonb(r)::text, $1) > 0`, [token],
    );
    assert.equal(result.rows[0].n, 0, "email_log contains a raw token");
  }
}

test.before(async () => {
  previous = keys.map((key) => process.env[key]);
  // Use local auth provisioning for these fixtures.
  for (const key of keys) delete process.env[key];
});

test.beforeEach(async () => {
  liveOrgId = await createOrganization("live");
  sandboxOrgId = await createOrganization("sandbox", liveOrgId);
  otherOrgId = await createOrganization("other");
  // Include the sandbox so its environment, independently of the allowlist,
  // must prevent team invitation operations.
  process.env.TEAM_INVITES_ORG_ALLOWLIST = `${liveOrgId},${sandboxOrgId}`;
});

test.after(async () => {
  try {
    const users = await query<{ id: string }>(
      `SELECT id::text FROM auth.users WHERE email::text = ANY($1::text[])`, [emails],
    );
    const ids = users.rows.map(({ id }) => id);

    await query(`DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM invitations WHERE org_id = ANY($1::uuid[])`, [orgIds]);
    await query(`DELETE FROM org_members WHERE org_id = ANY($1::uuid[])`, [orgIds]);

    // Delete sandbox children before their live parents.
    for (const id of [...orgIds].reverse()) {
      await query(`DELETE FROM organizations WHERE id = $1`, [id]);
    }
    await query(`DELETE FROM auth_login_attempts WHERE email = ANY($1::text[])`, [emails]);
    await query(`DELETE FROM profiles WHERE id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [ids]);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("used, expired, revoked, rotated and unknown tokens have exactly the same error", async () => {
  const errors: string[] = [];
  async function unavailable(token: string) {
    const result = await accept(token);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("Unexpected acceptance");
    assert.equal(result.kind, "team_member");
    errors.push(result.error);
  }

  const used = await issue("used");
  assert.equal((await accept(used.token)).ok, true);
  await unavailable(used.token);

  const expired = await issue("expired");
  await query(`UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [expired.invitationId]);
  await unavailable(expired.token);

  const revoked = await issue("revoked");
  await revokeInvite(admin(), revoked.invitationId);
  await unavailable(revoked.token);

  const rotated = await issue("rotated");
  const replacement = await resendInvite(admin(), rotated.invitationId);
  await unavailable(rotated.token);
  assert.equal((await accept(replacement.token)).ok, true);

  await unavailable(randomBytes(32).toString("base64url"));
  assert.equal(errors.length, 5);
  for (const error of errors) assert.strictEqual(error, "errors.teamInviteUnavailable");
  assert.equal(new Set(errors).size, 1);
});

test("expired pending invitations cannot be reissued or mutated", async () => {
  const invited = await issue("expired-reissue");
  await query(
    `UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [invited.invitationId],
  );
  const before = await row(invited.invitationId);
  assert.equal(before.status, "pending");
  await assert.rejects(
    () => resendInvite(admin(), invited.invitationId),
    hasKey("errors.teamInviteUnavailable"),
  );
  assert.deepEqual(await row(invited.invitationId), before);
});

async function acceptConcurrently(firstToken: string, secondToken: string) {
  return withClient((first) => withClient(async (second) => {
    const firstBackend = await first.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
    const secondBackend = await second.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
    assert.notEqual(firstBackend.rows[0].pid, secondBackend.rows[0].pid);
    return Promise.all([
      acceptTeamInvite(first, firstToken, "Hire", password, meta),
      acceptTeamInvite(second, secondToken, "Hire", password, meta),
    ]);
  }));
}

test("concurrent double acceptance consumes the token exactly once", async () => {
  const invited = await issue("double-accept");
  const results = await acceptConcurrently(invited.token, invited.token);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.filter((result) => !result.ok), [{
    ok: false, error: "errors.teamInviteUnavailable", kind: "team_member",
  }]);
  assert.equal((await row(invited.invitationId)).status, "accepted");
  const accounts = await accountRows(invited.email);
  assert.equal(accounts.users.length, 1);
  assert.deepEqual(accounts.members, [{ role: "accountant" }]);
});

test("concurrent invitations competing for the last standard seat accept exactly one", async () => {
  for (let index = 0; index < 3; index++) {
    const user = await createUser(`competing-seat-${index}`);
    await query(
      `INSERT INTO org_members (org_id, user_id, role, status)
       VALUES ($1, $2, 'accountant', 'active')`,
      [liveOrgId, user.id],
    );
  }
  const first = await pending();
  const second = await pending();
  const results = await acceptConcurrently(first.token, second.token);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.filter((result) => !result.ok), [{
    ok: false, error: "errors.seatLimit", kind: "team_member",
  }]);
  const statuses = await Promise.all([
    row(first.invitationId), row(second.invitationId),
  ]);
  assert.deepEqual(statuses.map((invitation) => invitation.status).sort(), ["accepted", "pending"]);
  const accounts = await Promise.all([
    accountRows(first.email), accountRows(second.email),
  ]);
  assert.equal(accounts.reduce((count, account) => count + account.members.length, 0), 1);
  const active = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND status = 'active'`,
    [liveOrgId],
  );
  assert.equal(active.rows[0].n, 5);
});

test("wrong signed-in email cannot provision a user or consume the invitation", async () => {
  const invited = await issue("account");
  assert.deepEqual(await accountRows(invited.email), { users: [], members: [] });
  assert.deepEqual(await accept(invited.token, "different@example.com"), {
    ok: false, error: "account", kind: "team_member",
  });
  assert.deepEqual(await accountRows(invited.email), { users: [], members: [] });
  assert.equal((await row(invited.invitationId)).status, "pending");
});

test("acceptance ignores extra API role inputs and uses the invitation accountant role", async () => {
  const invited = await issue("role");
  const result = await withClient((client) => {
    // Model callers sending surplus runtime arguments without changing the API.
    const args: Parameters<typeof acceptTeamInvite> = [
      client, invited.token, "Hire", password, meta, "",
    ];
    return Reflect.apply(acceptTeamInvite, undefined, [
      ...args, { role: "admin", userId: admin().userId }, "admin",
    ]) as ReturnType<typeof acceptTeamInvite>;
  });
  if (!result.ok) assert.fail(JSON.stringify(result));
  assert.equal(result.role, "accountant");
  assert.equal((await row(invited.invitationId)).role, "accountant");
  assert.deepEqual((await accountRows(invited.email)).members, [{ role: "accountant" }]);
});

test("manager invite and rotation are forbidden and leave invitation data unchanged", async () => {
  const invited = await issue("manager");
  const before = await row(invited.invitationId);
  const count = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invitations WHERE org_id = $1`, [liveOrgId],
  );
  const manager: Session = { ...admin(), role: "manager" };
  await assert.rejects(
    () => inviteMember(manager, { email: email("forbidden"), name: "Hire", role: "accountant" }),
    hasKey("errors.forbidden"),
  );
  await assert.rejects(
    () => resendInvite(manager, invited.invitationId), hasKey("errors.forbidden"),
  );
  assert.deepEqual(await row(invited.invitationId), before);
  const after = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invitations WHERE org_id = $1`, [liveOrgId],
  );
  assert.deepEqual(after.rows, count.rows);
});

test("issue, rotate and accept store hashes only and never add email_log rows", async () => {
  const beforeMail = await emailLogCount();
  const invited = await issue("storage");
  assert.equal((await row(invited.invitationId)).code_hash, hashInviteToken(invited.token));
  await assertNoRawToken(invited.token);

  const rotated = await resendInvite(admin(), invited.invitationId);
  assert.notEqual(rotated.token, invited.token);
  assert.equal((await row(invited.invitationId)).code_hash, hashInviteToken(rotated.token));
  assert.equal((await accept(rotated.token)).ok, true);
  const accepted = await row(invited.invitationId);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.code_hash, hashInviteToken(rotated.token));
  await assertNoRawToken(invited.token);
  await assertNoRawToken(rotated.token);
  assert.equal(await emailLogCount(), beforeMail);
});

test("non-allowlisted and sandbox organizations refuse issuance, rotation and acceptance", async () => {
  const other = await pending(otherOrgId);
  await assert.rejects(
    () => inviteMember(admin(otherOrgId), { email: email("other"), name: "Hire", role: "accountant" }),
    hasKey("errors.teamInvitesSoon"),
  );
  const otherBefore = await row(other.invitationId);
  await assert.rejects(
    () => resendInvite(admin(otherOrgId), other.invitationId), hasKey("errors.teamInvitesSoon"),
  );
  assert.deepEqual(await accept(other.token), {
    ok: false, error: "errors.teamInviteUnavailable", kind: "team_member",
  });
  assert.deepEqual(await row(other.invitationId), otherBefore);
  assert.deepEqual(await accountRows(other.email, otherOrgId), { users: [], members: [] });

  const sandbox = await pending(sandboxOrgId);
  const sandboxBefore = await row(sandbox.invitationId);
  const sandboxSession = admin(sandboxOrgId);
  await assert.rejects(
    () => inviteMember(sandboxSession, { email: email("sandbox"), name: "Hire", role: "accountant" }),
    hasKey("errors.teamInvitesSoon"),
  );
  await assert.rejects(
    () => resendInvite(sandboxSession, sandbox.invitationId), hasKey("errors.teamInvitesSoon"),
  );
  // A stale live session cannot bypass the organization's stored environment.
  const staleLiveSession: Session = {
    ...sandboxSession, environment: "live", liveOrgId: sandboxOrgId,
  };
  await assert.rejects(
    () => resendInvite(staleLiveSession, sandbox.invitationId), hasKey("errors.teamInvitesSoon"),
  );
  assert.deepEqual(await accept(sandbox.token), {
    ok: false, error: "errors.teamInviteUnavailable", kind: "team_member",
  });
  assert.deepEqual(await row(sandbox.invitationId), sandboxBefore);
  assert.deepEqual(await accountRows(sandbox.email, sandboxOrgId), { users: [], members: [] });
});

test("free tier with one active admin refuses acceptance and leaves the invitation pending", async () => {
  await query(
    `UPDATE organizations SET plan_tier = 'free',
       settings = '{"plan":{"tier":"free"}}'::jsonb WHERE id = $1`,
    [liveOrgId],
  );
  const invited = await pending();
  assert.deepEqual(await accept(invited.token), {
    ok: false, error: "errors.seatLimit", kind: "team_member",
  });
  assert.equal((await row(invited.invitationId)).status, "pending");
  assert.deepEqual(await accountRows(invited.email), { users: [], members: [] });
});

test("standard sequential acceptance fills three available seats and refuses a fourth", async () => {
  const member = await createUser("sequential-seat");
  await query(
    `INSERT INTO org_members (org_id, user_id, role, status)
     VALUES ($1, $2, 'accountant', 'active')`,
    [liveOrgId, member.id],
  );
  const initial = await query<{ active: number; pending: number }>(
    `SELECT
       (SELECT count(*)::int FROM org_members WHERE org_id = $1 AND status = 'active') AS active,
       (SELECT count(*)::int FROM invitations WHERE org_id = $1
         AND kind = 'team_member' AND status = 'pending') AS pending`,
    [liveOrgId],
  );
  assert.deepEqual(initial.rows, [{ active: 2, pending: 0 }]);

  const invitations = [];
  for (let index = 0; index < 3; index++) {
    invitations.push(await issue(`sequential-${index}`));
  }
  // Issuance reserves pending seats. Seed an additional outstanding invitation
  // with the existing fixture, as in the competing-last-seat test.
  const fourth = await pending();
  const fourthBefore = await row(fourth.invitationId);
  const accountsBefore = await accountRows(fourth.email);
  assert.deepEqual(accountsBefore, { users: [], members: [] });

  for (const [index, invited] of invitations.entries()) {
    const result = await accept(invited.token);
    if (!result.ok) assert.fail(JSON.stringify(result));
    assert.equal((await row(invited.invitationId)).status, "accepted");
    assert.deepEqual((await accountRows(invited.email)).members, [{ role: "accountant" }]);
    const active = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND status = 'active'`,
      [liveOrgId],
    );
    assert.equal(active.rows[0].n, 3 + index);
  }

  const membersBefore = await query(
    `SELECT to_jsonb(m) AS data FROM org_members m WHERE org_id = $1 ORDER BY id`,
    [liveOrgId],
  );
  assert.deepEqual(await accept(fourth.token), {
    ok: false, error: "errors.seatLimit", kind: "team_member",
  });
  assert.deepEqual(await row(fourth.invitationId), fourthBefore);
  assert.equal((await row(fourth.invitationId)).status, "pending");
  assert.deepEqual(await accountRows(fourth.email), accountsBefore);
  const membersAfter = await query(
    `SELECT to_jsonb(m) AS data FROM org_members m WHERE org_id = $1 ORDER BY id`,
    [liveOrgId],
  );
  assert.deepEqual(membersAfter.rows, membersBefore.rows);
});

test("an existing registered user accepts with their password without replacing credentials", async () => {
  const user = await createUser("registered");
  const credentialsBefore = await query<{ encrypted_password: string }>(
    `SELECT encrypted_password FROM auth.users WHERE id = $1`, [user.id],
  );
  assert.equal(credentialsBefore.rows.length, 1);
  assert.ok(credentialsBefore.rows[0].encrypted_password);
  assert.deepEqual(await accountRows(user.email), {
    users: [{ id: user.id }], members: [],
  });

  const invited = await inviteMember(admin(), {
    email: user.email, name: "Hire", role: "accountant",
  });
  const result = await accept(invited.token);
  if (!result.ok) assert.fail(JSON.stringify(result));
  assert.equal(result.role, "accountant");
  assert.equal((await row(invited.invitationId)).status, "accepted");
  assert.deepEqual(await accountRows(user.email), {
    users: [{ id: user.id }], members: [{ role: "accountant" }],
  });
  const credentialsAfter = await query<{ encrypted_password: string }>(
    `SELECT encrypted_password FROM auth.users WHERE id = $1`, [user.id],
  );
  assert.deepEqual(credentialsAfter.rows, credentialsBefore.rows);
});

test("legacy actionAccept refuses a real team token without any account or invitation mutation", async () => {
  const invited = await issue("legacy-refusal");
  const before = await query(
    `SELECT to_jsonb(i) AS data FROM invitations i WHERE id = $1`, [invited.invitationId],
  );
  assert.deepEqual(await accountRows(invited.email), { users: [], members: [] });

  // Use the existing unit harness approach to execute the actual action body.
  // Only Next request metadata is substituted; describeInvite uses the real DB.
  const actions = readFileSync(new URL("./auth-actions.ts", import.meta.url), "utf8");
  const start = actions.indexOf("export async function actionAccept(");
  assert.ok(start >= 0);
  const end = actions.indexOf("\nfunction teamLinkFailure(", start);
  assert.ok(end > start);
  const declaration = actions.slice(start, end);
  const opening = declaration.indexOf(") {");
  assert.ok(opening >= 0);
  const body = declaration.slice(opening + 3, declaration.lastIndexOf("}"))
    .replace(/ as const\b/g, "");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const { describeInvite } = await import("./auth");
  let descriptions = 0;
  const run = new AsyncFunction(
    "formData", "text", "describeInvite", "meta", "readSession", "acceptInvite", body,
  );
  const form = new FormData();
  form.set("token", invited.token);
  form.set("name", "Hire");
  form.set("password", password);
  form.set("confirm", password);
  form.set("consent", "on");
  const unexpected = () => assert.fail("Legacy team refusal reached acceptance dependencies");
  const result = await run(
    form,
    (value: FormDataEntryValue | null) => String(value ?? ""),
    async (token: string, requestMeta: { ip: string | null }) => {
      descriptions++;
      const view = await describeInvite(token, requestMeta);
      assert.equal(view.state, "ready");
      assert.equal(view.kind, "team_member");
      return view;
    },
    async () => meta,
    unexpected,
    unexpected,
  );
  assert.equal(descriptions, 1);
  assert.deepEqual(result, { ok: false, error: "errors.teamInviteUnavailable" });
  const after = await query(
    `SELECT to_jsonb(i) AS data FROM invitations i WHERE id = $1`, [invited.invitationId],
  );
  // Includes status, code_hash and accepted_by.
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(await accountRows(invited.email), { users: [], members: [] });
});

test("accountant and maintenance members cannot create or issue team links", async () => {
  const invited = await issue("non-admin-link");
  for (const role of ["accountant", "maintenance"] as const) {
    const user = await createUser(`non-admin-${role}`);
    await query(
      `INSERT INTO org_members (org_id, user_id, role, status)
       VALUES ($1, $2, $3::org_role, 'active')`,
      [liveOrgId, user.id, role],
    );
    const session: Session = {
      ...admin(), userId: user.id, email: user.email, name: "Fixture member", role,
    };
    const before = await query(
      `SELECT to_jsonb(i) AS data FROM invitations i WHERE org_id = $1 ORDER BY id`,
      [liveOrgId],
    );
    await assert.rejects(
      () => inviteMember(session, {
        email: email(`forbidden-${role}`), name: "Hire", role: "accountant",
      }),
      hasKey("errors.forbidden"),
    );
    const afterCreate = await query(
      `SELECT to_jsonb(i) AS data FROM invitations i WHERE org_id = $1 ORDER BY id`,
      [liveOrgId],
    );
    assert.deepEqual(afterCreate.rows, before.rows);
    await assert.rejects(
      () => resendInvite(session, invited.invitationId),
      hasKey("errors.forbidden"),
    );
    const afterIssue = await query(
      `SELECT to_jsonb(i) AS data FROM invitations i WHERE org_id = $1 ORDER BY id`,
      [liveOrgId],
    );
    assert.deepEqual(afterIssue.rows, before.rows);
  }
});

test("standard accepts with four active members and one pending invitation", async () => {
  for (let index = 0; index < 3; index++) {
    const user = await createUser(`seat-${index}`);
    await query(
      `INSERT INTO org_members (org_id, user_id, role, status)
       VALUES ($1, $2, 'accountant', 'active')`,
      [liveOrgId, user.id],
    );
  }
  const invited = await pending();
  const before = await query<{ active: number; pending: number }>(
    `SELECT
       (SELECT count(*)::int FROM org_members WHERE org_id = $1 AND status = 'active') AS active,
       (SELECT count(*)::int FROM invitations WHERE org_id = $1 AND kind = 'team_member'
         AND status = 'pending' AND expires_at > now()) AS pending`,
    [liveOrgId],
  );
  assert.deepEqual(before.rows, [{ active: 4, pending: 1 }]);
  const result = await accept(invited.token);
  if (!result.ok) assert.fail(JSON.stringify(result));
  assert.equal(result.role, "accountant");
  assert.equal((await row(invited.invitationId)).status, "accepted");
  const after = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND status = 'active'`,
    [liveOrgId],
  );
  assert.equal(after.rows[0].n, 5);
});
