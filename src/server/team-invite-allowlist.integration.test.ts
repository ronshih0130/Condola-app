import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Client } from "pg";
import {
  acceptInvite, acceptTeamInvite, describeInvite, hashInviteToken,
  inviteMember, resendInvite, signIn,
} from "./auth";
import { query, withClient } from "./db";
import { inviteTeammate } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import type { Session } from "./types";

const meta = { ua: "allowlist-integration", ip: "127.0.0.1" };
const password = "Fresh1234";
const prefix = `allowlist-${randomUUID()}`;
const emails: string[] = [];
const keys = [
  "TEAM_INVITES_ORG_ALLOWLIST", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
let previous: Array<string | undefined>;

function admin(orgId = ORG_ID): Session {
  return {
    userId: orgId === ORG_ID ? USERS.admin : USERS.coastAdmin,
    sessionId: "test", email: "yating.lin@songxin.demo", name: "林雅婷",
    kind: "staff", role: "admin", orgId, liveOrgId: orgId,
    environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null,
  };
}

function email(label: string) {
  const value = `${prefix}-${label}@example.com`;
  emails.push(value);
  return value;
}

function soon(error: unknown) {
  return error instanceof FlowError && error.key === "errors.teamInvitesSoon";
}

async function issue(label: string) {
  const target = email(label);
  const invited = await inviteMember(admin(), { email: target, name: "Hire", role: "accountant" });
  return { ...invited, email: target };
}

async function accept(token: string, pw = password) {
  return acceptInvite(token, "Hire", pw, pw, meta, "", "", true);
}

async function membership(target: string) {
  return query<{ status: string; role: string }>(
    `SELECT m.status::text, m.role::text
       FROM org_members m JOIN auth.users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND lower(u.email) = lower($2)`,
    [ORG_ID, target],
  );
}

async function invitationState(target: string) {
  const result = await query<{ status: string }>(
    `SELECT status::text FROM invitations WHERE lower(email::text) = lower($1)`,
    [target],
  );
  return result.rows[0]?.status;
}

test.before(async () => {
  previous = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  process.env.TEAM_INVITES_ORG_ALLOWLIST = ORG_ID;
  await resetAndSeed();
});

test.after(async () => {
  try {
    // Invitations and audit records can reference the provisioned users.
    await query(`DELETE FROM invitations WHERE email::text = ANY($1::text[])`, [emails]);
    const users = await query<{ id: string }>(
      `SELECT id::text FROM auth.users WHERE email::text = ANY($1::text[])`, [emails],
    );
    const ids = users.rows.map((row) => row.id);
    await query(`DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM org_members WHERE user_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM auth_login_attempts WHERE email = ANY($1::text[])`, [emails]);
    // Seed reset removes associated consent/audit rows using the application's
    // established reset order, including any foreign-key dependencies.
    await resetAndSeed();
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});

test("allowlisted accountant invite, description, acceptance and password sign-in", async () => {
  const invited = await issue("accountant");
  const view = await describeInvite(invited.token);
  assert.equal(view.state, "ready");
  assert.equal(view.kind, "team_member");
  if (view.state !== "ready" || view.kind !== "team_member") assert.fail("Expected ready team invite");
  assert.equal(view.orgId, ORG_ID);
  const result = await accept(invited.token);
  if (!result.ok) assert.fail(JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.role, "accountant");
  assert.deepEqual((await membership(invited.email)).rows, [{ status: "active", role: "accountant" }]);
  assert.equal((await signIn(invited.email, password, false, meta)).ok, true);
});

test("allowlisted resend rotates the token and preserves invitation org", async () => {
  const invited = await issue("resend");
  const row = await query<{ id: string }>(
    `SELECT id::text FROM invitations WHERE code_hash = $1`, [hashInviteToken(invited.token)],
  );
  const resent = await resendInvite(admin(), row.rows[0].id);
  assert.notEqual(resent.token, invited.token);
  const view = await describeInvite(resent.token);
  assert.equal(view.state, "ready");
  assert.equal(view.kind, "team_member");
  if (view.state === "ready" && view.kind === "team_member") assert.equal(view.orgId, ORG_ID);
  else assert.fail("Expected ready team invite");
  assert.equal((await describeInvite(invited.token)).state, "invalid");
});

test("other org is refused by all server entry points without inserting invitations", async () => {
  const target = email("coast");
  const before = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invitations WHERE org_id = $1`, [ORG2_ID],
  );
  await assert.rejects(
    () => inviteMember(admin(ORG2_ID), { email: target, name: "Hire", role: "accountant" }), soon,
  );
  await assert.rejects(() => resendInvite(admin(ORG2_ID), randomUUID()), soon);
  await assert.rejects(
    () => inviteTeammate(admin(ORG2_ID), { email: target, role: "accountant" }), soon,
  );
  const after = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invitations WHERE org_id = $1`, [ORG2_ID],
  );
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("acceptance checks the invitation org and creates no refused login", async () => {
  const target = email("refused-accept");
  const token = `refused-${randomUUID()}`;
  await query(
    `INSERT INTO invitations (org_id, kind, role, email, code_hash, expires_at, invited_by)
     VALUES ($1, 'team_member', 'accountant', $2, $3, now() + interval '1 day', $4)`,
    [ORG2_ID, target, hashInviteToken(token), USERS.coastAdmin],
  );
  assert.deepEqual(await accept(token), { ok: false, error: "soon", kind: "team_member" });
  assert.equal(await invitationState(target), "pending");
  const users = await query(`SELECT id FROM auth.users WHERE lower(email) = lower($1)`, [target]);
  assert.equal(users.rows.length, 0);

  await query(`UPDATE invitations SET status = 'revoked' WHERE code_hash = $1`, [hashInviteToken(token)]);
  const view = await describeInvite(token);
  assert.equal(view.state, "revoked");
  assert.equal(view.kind, "team_member");
  if (view.kind === "team_member") assert.equal(view.orgId, ORG2_ID);
});

test("empty and malformed config refuse even the otherwise allowed org", async () => {
  try {
    for (const raw of ["", `not-a-uuid,${ORG_ID}`]) {
      process.env.TEAM_INVITES_ORG_ALLOWLIST = raw;
      await assert.rejects(
        () => inviteMember(admin(), { email: email("malformed"), name: "Hire", role: "accountant" }),
        soon,
      );
    }
  } finally {
    process.env.TEAM_INVITES_ORG_ALLOWLIST = ORG_ID;
  }
});

test("I-11(c): session failure after COMMIT preserves membership and permits normal sign-in", async () => {
  const invited = await issue("post-commit");
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `test_invite_session_${suffix}`;
  const triggerName = `test_invite_session_${suffix}`;
  let functionCreated = false;
  let triggerCreated = false;
  try {
    await query(
      `CREATE FUNCTION public.${functionName}() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM auth.users
            WHERE id = NEW.user_id AND email::text = TG_ARGV[0]
         ) THEN
           RAISE EXCEPTION 'injected invite session failure';
         END IF;
         RETURN NEW;
       END
       $$`,
    );
    functionCreated = true;
    // The generated address contains only UUID hex, hyphens and fixed literals.
    assert.match(invited.email, /^[a-z0-9@.-]+$/);
    await query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON auth_sessions
       FOR EACH ROW EXECUTE FUNCTION public.${functionName}('${invited.email}')`,
    );
    triggerCreated = true;
    await assert.rejects(() => accept(invited.token), /injected invite session failure/);
    assert.deepEqual((await membership(invited.email)).rows, [{ status: "active", role: "accountant" }]);
    assert.equal(await invitationState(invited.email), "accepted");
  } finally {
    if (triggerCreated) await query(`DROP TRIGGER ${triggerName} ON auth_sessions`);
    if (functionCreated) await query(`DROP FUNCTION public.${functionName}()`);
  }
  assert.equal((await signIn(invited.email, password, false, meta)).ok, true);
});

test("I-11(d): DB rollback after independent provisioning supports same-password retry", async () => {
  const invited = await issue("db-rollback");
  const savedFetch = global.fetch;
  const savedUrl = process.env.SUPABASE_URL;
  const savedService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let creates = 0;
  try {
    // Model GoTrue's independent transaction using the real local auth schema.
    // The ordinary integration paths above use the local provisioning stub.
    process.env.SUPABASE_URL = "http://gotrue.integration.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "integration-service";
    global.fetch = async (input, init) => {
      assert.equal(String(input), "http://gotrue.integration.test/auth/v1/admin/users");
      assert.equal(init?.method, "POST");
      creates++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.email, invited.email);
      const created = await query<{ id: string }>(
        `INSERT INTO auth.users
           (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, role, aud)
         VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), now(), '{}'::jsonb,
                 'authenticated', 'authenticated')
         RETURNING id::text`,
        [body.email, body.password],
      );
      return Response.json({ id: created.rows[0].id });
    };

    const statements: string[] = [];
    await assert.rejects(
      () => withClient(async (client) => {
        const wrapped = {
          async query(sql: string, values?: unknown[]) {
            statements.push(sql);
            if (sql.includes("INSERT INTO org_members")) throw new Error("injected membership failure");
            return client.query(sql, values);
          },
        } as unknown as Client;
        return acceptTeamInvite(wrapped, invited.token, "Hire", password, meta);
      }),
      /injected membership failure/,
    );
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.equal(statements.includes("COMMIT"), false);
    assert.equal(await invitationState(invited.email), "pending");
    assert.equal((await membership(invited.email)).rows.length, 0);
    assert.equal(creates, 1);

    assert.deepEqual(
      await accept(invited.token, "Different1234"),
      { ok: false, error: "auth", kind: "team_member" },
    );
    assert.equal(creates, 1);
    assert.equal(await invitationState(invited.email), "pending");
    const result = await accept(invited.token);
    if (!result.ok) assert.fail(JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.role, "accountant");
    assert.equal(creates, 1);
    assert.deepEqual((await membership(invited.email)).rows, [{ status: "active", role: "accountant" }]);
    assert.equal(await invitationState(invited.email), "accepted");
  } finally {
    global.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedUrl;
    if (savedService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedService;
  }
  assert.equal((await signIn(invited.email, password, false, meta)).ok, true);
});
