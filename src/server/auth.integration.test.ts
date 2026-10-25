import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptInvite,
  describeInvite,
  describeReset,
  inviteMember,
  requestPasswordReset,
  resetPassword,
  setMemberActive,
  setMemberRole,
  signIn,
  signInWithLine,
} from "./auth";
import { query } from "./db";
import { lineLoginEnabled } from "./demo";
import { DEMO_PASSWORD } from "./demo-password";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { updateTicket } from "./domain";
import { resetAndSeed } from "./seed";
import type { Session } from "./types";

const meta = { ua: "test", ip: "127.0.0.1" };

function admin(): Session {
  return {
    userId: USERS.admin,
    sessionId: "test",
    email: "yating.lin@songxin.demo",
    name: "林雅婷",
    kind: "staff",
    role: "admin",
    orgId: ORG_ID,
    liveOrgId: ORG_ID,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

test.before(async () => {
  await resetAndSeed();
});

test("unknown email and wrong password share one error; the fifth failure locks for 15 minutes", async () => {
  const unknown = await signIn("nobody@example.com", "Wrongpass1", false, meta);
  const wrong = await signIn("yating.lin@songxin.demo", "Wrongpass1", false, meta);
  assert.deepEqual(unknown, { ok: false, error: "invalid" });
  assert.deepEqual(wrong, { ok: false, error: "invalid" });
  await query(`DELETE FROM auth_login_attempts WHERE email = 'lock@example.com'`);
  let last: Awaited<ReturnType<typeof signIn>> = { ok: false, error: "invalid" };
  for (let i = 0; i < 5; i += 1) last = await signIn("lock@example.com", "Wrongpass1", false, meta);
  assert.equal(last.ok, false);
  if (!last.ok && "error" in last) assert.equal(last.error, "locked");
  const row = await query<{ locked_until: Date }>(
    `SELECT locked_until FROM auth_login_attempts WHERE email = 'lock@example.com'`,
  );
  const remaining = row.rows[0].locked_until.getTime() - Date.now();
  assert.ok(remaining > 14 * 60 * 1000);
  assert.ok(remaining <= 15 * 60 * 1000 + 5000);
});

test("a correct password signs the admin in", async () => {
  await query(`DELETE FROM auth_login_attempts WHERE email = 'yating.lin@songxin.demo'`);
  const result = await signIn("yating.lin@songxin.demo", DEMO_PASSWORD, false, meta);
  assert.equal(result.ok, true);
});

test("deactivated members cannot sign in", async () => {
  const member = await query<{ id: string }>(
    `SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [ORG_ID, USERS.manager],
  );
  await setMemberActive(admin(), member.rows[0].id, false, true);
  const result = await signIn("zhiming.huang@songxin.demo", DEMO_PASSWORD, false, meta);
  assert.deepEqual(result, { ok: false, error: "disabled" });
  await setMemberActive(admin(), member.rows[0].id, true);
});

test("the last admin cannot be demoted", async () => {
  const member = await query<{ id: string }>(
    `SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [ORG_ID, USERS.admin],
  );
  await assert.rejects(() => setMemberRole(admin(), member.rows[0].id, "manager"), (error: unknown) => {
    assert.ok(error instanceof FlowError);
    assert.equal(error.key, "errors.lastAdmin");
    return true;
  });
});

test("invite rejects a duplicate and accept signs the member in once", async () => {
  await assert.rejects(() => inviteMember(admin(), { email: "yating.lin@songxin.demo", name: "林", role: "manager" }), (error: unknown) => {
    return error instanceof FlowError && error.key === "errors.emailTaken";
  });
  const invited = await inviteMember(admin(), { email: "new.hire@songxin.demo", name: "新人", role: "accountant" });
  const weak = await acceptInvite(invited.token, "新人", "short", "short", meta, "", "", true);
  assert.equal(weak.ok, false);
  if (!weak.ok) assert.equal(weak.error, "weak");
  const accepted = await acceptInvite(invited.token, "新人", "Fresh1234", "Fresh1234", meta, "", "", true);
  assert.equal(accepted.ok, true);
  const again = await describeInvite(invited.token);
  assert.equal(again.state, "used");
});

test("deactivating a member without confirmation is rejected", async () => {
  const member = await query<{ id: string; status: string }>(
    `SELECT id::text, status::text FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [ORG_ID, USERS.maintenance],
  );
  await assert.rejects(() => setMemberActive(admin(), member.rows[0].id, false), (error: unknown) => {
    assert.ok(error instanceof FlowError);
    assert.equal(error.key, "errors.confirm");
    return true;
  });
  const after = await query<{ status: string }>(`SELECT status::text FROM org_members WHERE id = $1`, [member.rows[0].id]);
  assert.equal(after.rows[0].status, "active");
});

test("an accountant can open tickets but cannot update one", async () => {
  await assert.rejects(
    () => updateTicket({ ...admin(), userId: USERS.accountant, role: "accountant", email: "meiling.zhou@songxin.demo" }, "00000000-0000-0000-0000-000000000000", { status: "closed" }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
});

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("demo LINE sign-in does nothing when the environment is production", async () => {
  const previousNode = process.env.NODE_ENV;
  const previousLine = process.env.LINE_LOGIN_ENABLED;
  const previousCondola = process.env.CONDOLA_ENV;
  try {
    setEnv("CONDOLA_ENV", undefined);
    setEnv("LINE_LOGIN_ENABLED", "true");
    setEnv("NODE_ENV", "production");
    assert.equal(lineLoginEnabled(), false);
    const result = await signInWithLine(meta);
    assert.deepEqual(result, { ok: false, error: "invalid" });
  } finally {
    setEnv("NODE_ENV", previousNode);
    setEnv("LINE_LOGIN_ENABLED", previousLine);
    setEnv("CONDOLA_ENV", previousCondola);
  }
});

test("password reset expires, and a valid reset signs out every session", async () => {
  await query(
    `DELETE FROM password_reset_attempts WHERE email_key IN (
       'yating.lin@songxin.demo', 'nobody-reset@example.com', 'meiling.zhou@songxin.demo'
     )`,
  );
  const issued = await requestPasswordReset("yating.lin@songxin.demo");
  assert.ok(issued.token);
  await query(
    `UPDATE auth_password_resets SET expires_at = now() - interval '1 minute'
      WHERE user_id = $1 AND used_at IS NULL`,
    [USERS.admin],
  );
  assert.equal(await describeReset(issued.token!), "expired");
  const fresh = await requestPasswordReset("nobody-reset@example.com");
  assert.equal(fresh.token, null);
  const older = await requestPasswordReset("meiling.zhou@songxin.demo");
  const live = await requestPasswordReset("meiling.zhou@songxin.demo");
  await query(
    `INSERT INTO auth_login_attempts (email, failed_count, locked_until)
     VALUES ('meiling.zhou@songxin.demo', 5, now() + interval '15 minutes')
     ON CONFLICT (email) DO UPDATE SET failed_count = 5, locked_until = now() + interval '15 minutes'`,
  );
  const mismatch = await resetPassword(live.token!, "Fresh1234", "Fresh1235");
  assert.deepEqual(mismatch, { ok: false, error: "mismatch" });
  const weak = await resetPassword(live.token!, "password1", "password1");
  assert.deepEqual(weak, { ok: false, error: "weak" });
  await query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, 'stale-token', now() + interval '1 day')`,
    [USERS.accountant],
  );
  const saved = await resetPassword(live.token!, "Fresh1234", "Fresh1234");
  assert.equal(saved.ok, true);
  const sessions = await query(
    `SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [USERS.accountant],
  );
  assert.equal(sessions.rows[0].n, 0);
  const reused = await resetPassword(live.token!, "Fresh1234", "Fresh1234");
  assert.deepEqual(reused, { ok: false, error: "expired" });
  assert.equal(await describeReset(older.token!), "expired");
  const lock = await query(`SELECT 1 FROM auth_login_attempts WHERE email = 'meiling.zhou@songxin.demo'`);
  assert.equal(lock.rows.length, 0);
});

test("a plus-addressed email signs in, including when the form turned + into a space", async () => {
  const stamp = Date.now().toString(36);
  const email = `plus.tag+qa.${stamp}@example.com`;
  const unconfirmed = `plus.tag+wait.${stamp}@example.com`;
  const noFirm = `plus.tag+firm.${stamp}@example.com`;
  const inserted = await query<{ id: string }>(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, role, aud)
     VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), '{}'::jsonb, now(), 'authenticated', 'authenticated'),
            (gen_random_uuid(), $3, crypt($2, gen_salt('bf')), '{}'::jsonb, NULL, 'authenticated', 'authenticated'),
            (gen_random_uuid(), $4, crypt($2, gen_salt('bf')), '{}'::jsonb, now(), 'authenticated', 'authenticated')
     RETURNING id::text`,
    [email, DEMO_PASSWORD, unconfirmed, noFirm],
  );
  const ids = inserted.rows.map((row) => row.id);
  try {
    await query(`INSERT INTO profiles (id, display_name, email) VALUES ($1, 'Plus', $2), ($3, 'Firm', $4)`, [
      ids[0],
      email,
      ids[2],
      noFirm,
    ]);
    await query(
      `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status) VALUES ($1, $2, 'admin', false, 'active')`,
      [ORG_ID, ids[0]],
    );
    const fromSpace = await signIn(email.replace("+", " "), DEMO_PASSWORD, false, meta);
    assert.equal(fromSpace.ok, true);
    const direct = await signIn(email.toUpperCase(), DEMO_PASSWORD, false, meta);
    assert.equal(direct.ok, true);
    const wrong = await signIn(email, "Wrongpass1", false, meta);
    assert.deepEqual(wrong, { ok: false, error: "invalid" });
    const waiting = await signIn(unconfirmed.replace("+", " "), DEMO_PASSWORD, false, meta);
    assert.deepEqual(waiting, { ok: false, error: "unconfirmed" });
    const confirmedNoFirm = await signIn(`  ${noFirm.replace("+", " ").toUpperCase()}  `, DEMO_PASSWORD, false, meta);
    assert.equal(confirmedNoFirm.ok, true);
    if (confirmedNoFirm.ok) assert.equal(confirmedNoFirm.destination, "firm");
  } finally {
    await query(`DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM org_members WHERE user_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM profiles WHERE id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM auth_login_attempts WHERE email = ANY($1::text[])`, [[email, unconfirmed, noFirm]]);
    await query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [ids]);
  }
});
