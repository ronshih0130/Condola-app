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
} from "./auth";
import { pool } from "./db";
import { DEMO_PASSWORD } from "./demo-password";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
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
  await pool.query(`DELETE FROM auth_login_attempts WHERE email = 'lock@example.com'`);
  let last: Awaited<ReturnType<typeof signIn>> = { ok: false, error: "invalid" };
  for (let i = 0; i < 5; i += 1) last = await signIn("lock@example.com", "Wrongpass1", false, meta);
  assert.equal(last.ok, false);
  if (!last.ok && "error" in last) assert.equal(last.error, "locked");
  const row = await pool.query<{ locked_until: Date }>(
    `SELECT locked_until FROM auth_login_attempts WHERE email = 'lock@example.com'`,
  );
  const remaining = row.rows[0].locked_until.getTime() - Date.now();
  assert.ok(remaining > 14 * 60 * 1000);
  assert.ok(remaining <= 15 * 60 * 1000 + 5000);
});

test("a correct password signs the admin in", async () => {
  await pool.query(`DELETE FROM auth_login_attempts WHERE email = 'yating.lin@songxin.demo'`);
  const result = await signIn("yating.lin@songxin.demo", DEMO_PASSWORD, false, meta);
  assert.equal(result.ok, true);
});

test("deactivated members cannot sign in", async () => {
  const member = await pool.query<{ id: string }>(
    `SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [ORG_ID, USERS.manager],
  );
  await setMemberActive(admin(), member.rows[0].id, false);
  const result = await signIn("zhiming.huang@songxin.demo", DEMO_PASSWORD, false, meta);
  assert.deepEqual(result, { ok: false, error: "disabled" });
  await setMemberActive(admin(), member.rows[0].id, true);
});

test("the last admin cannot be demoted", async () => {
  const member = await pool.query<{ id: string }>(
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
  const weak = await acceptInvite(invited.token, "新人", "short", "short", meta);
  assert.equal(weak.ok, false);
  const accepted = await acceptInvite(invited.token, "新人", "Fresh1234", "Fresh1234", meta);
  assert.equal(accepted.ok, true);
  const again = await describeInvite(invited.token);
  assert.equal(again.state, "used");
});

test("password reset expires, and a valid reset signs out every session", async () => {
  const issued = await requestPasswordReset("yating.lin@songxin.demo");
  assert.ok(issued.token);
  await pool.query(
    `UPDATE auth_password_resets SET expires_at = now() - interval '1 minute'
      WHERE user_id = $1 AND used_at IS NULL`,
    [USERS.admin],
  );
  assert.equal(await describeReset(issued.token!), "expired");
  const fresh = await requestPasswordReset("nobody-reset@example.com");
  assert.equal(fresh.token, null);
  const live = await requestPasswordReset("meiling.zhou@songxin.demo");
  const mismatch = await resetPassword(live.token!, "Fresh1234", "Fresh1235");
  assert.deepEqual(mismatch, { ok: false, error: "mismatch" });
  const weak = await resetPassword(live.token!, "password1", "password1");
  assert.deepEqual(weak, { ok: false, error: "weak" });
  await pool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, 'stale-token', now() + interval '1 day')`,
    [USERS.accountant],
  );
  const saved = await resetPassword(live.token!, "Fresh1234", "Fresh1234");
  assert.equal(saved.ok, true);
  const sessions = await pool.query(
    `SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [USERS.accountant],
  );
  assert.equal(sessions.rows[0].n, 0);
  const reused = await resetPassword(live.token!, "Fresh1234", "Fresh1234");
  assert.deepEqual(reused, { ok: false, error: "expired" });
});
