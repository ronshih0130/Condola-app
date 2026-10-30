import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  acceptInvite,
  describeInvite,
  describeReset,
  inviteMember,
  requestPasswordReset,
  resetPassword,
  revokeAllSessions,
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
  const previous = process.env.TEAM_INVITES_ORG_ALLOWLIST;
  try {
    process.env.TEAM_INVITES_ORG_ALLOWLIST = ORG_ID;
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
    assert.equal(again.state, "invalid");
    const acceptedAgain = await acceptInvite(invited.token, "新人", "Fresh1234", "Fresh1234", meta, "", "", true);
    assert.equal(acceptedAgain.ok, false);
    if (!acceptedAgain.ok) assert.equal(acceptedAgain.error, "invalid");
  } finally {
    setEnv("TEAM_INVITES_ORG_ALLOWLIST", previous);
  }
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

test("hosted session revocation migration and application integration", async (t) => {
  const databaseUrl: string = process.env.DATABASE_URL ?? "";
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const migrations = path.join(process.cwd(), "supabase", "migrations");
  const oldMigration = "20261022160000_end_auth_sessions.sql";
  const fixedMigration = "20261030151100_end_auth_sessions_varchar_fix.sql";
  let createdSessions = false;
  let createdTokens = false;
  const triggerFunction = `end_auth_sessions_test_${randomUUID().replaceAll("-", "")}`;
  const localSessionIds: string[] = [];

  function applyMigration(filename: string) {
    // Pass the throwaway test DB URL directly to psql; capture stderr for failures.
    execFileSync(
      "psql",
      [
        databaseUrl,
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "--single-transaction",
        "-f",
        path.join(migrations, filename),
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  }
  async function createTokens(type: "varchar(255)" | "uuid") {
    await query(`
      CREATE TABLE auth.refresh_tokens (
        id bigserial PRIMARY KEY,
        token varchar(255),
        user_id ${type},
        session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE,
        revoked bool DEFAULT false
      )
    `);
    createdTokens = true;
  }

  async function seedHosted(userId = randomUUID()) {
    const first = randomUUID();
    const second = randomUUID();
    await query(
      `INSERT INTO auth.sessions (id, user_id) VALUES ($1, $3), ($2, $3)`,
      [first, second, userId],
    );
    await query(
      `INSERT INTO auth.refresh_tokens (token, user_id, session_id)
       VALUES ($1, $4, $5), ($2, $4, $6), ($3, $4, NULL)`,
      [randomUUID(), randomUUID(), randomUUID(), userId, first, second],
    );
    return userId;
  }

  async function counts(userId: string) {
    const sessions = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth.sessions WHERE user_id = $1::uuid`,
      [userId],
    );
    // Test assertions support both fixture column types.
    const tokens = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth.refresh_tokens WHERE user_id::text = $1::text`,
      [userId],
    );
    return { sessions: sessions.rows[0].n, tokens: tokens.rows[0].n };
  }

  async function seedLocal() {
    const id = randomUUID();
    await query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [id, USERS.admin, randomUUID()],
    );
    localSessionIds.push(id);
    return id;
  }

  async function assertLocalRevoked(id: string) {
    const result = await query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = $1`,
      [id],
    );
    assert.equal(result.rows[0]?.revoked, true);
    const active = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_sessions
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [USERS.admin],
    );
    assert.equal(active.rows[0].n, 0);
  }

  async function installFailure() {
    await query(`
      CREATE FUNCTION auth.${triggerFunction}()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'test refresh token deletion failure';
      END
      $$;
      CREATE TRIGGER end_auth_sessions_test_failure
        BEFORE DELETE ON auth.refresh_tokens
        FOR EACH ROW EXECUTE FUNCTION auth.${triggerFunction}();
    `);
  }

  async function removeFailure() {
    if (createdTokens) {
      await query(`DROP TRIGGER IF EXISTS end_auth_sessions_test_failure ON auth.refresh_tokens`);
    }
    await query(`DROP FUNCTION IF EXISTS auth.${triggerFunction}()`);
  }

  function codedFailure(error: unknown) {
    assert.ok(error instanceof Error);
    const pgError = error as Error & { code?: string; detail?: string };
    assert.equal(pgError.code, "CA401");
    assert.match(pgError.message, /^END_AUTH_SESSIONS_FAILED/);
    assert.equal(pgError.detail, "original_sqlstate=P0001");
    return true;
  }

  const existing = await query<{ sessions: string | null; tokens: string | null }>(
    `SELECT to_regclass('auth.sessions')::text AS sessions,
            to_regclass('auth.refresh_tokens')::text AS tokens`,
  );
  // This suite owns its DDL only in the specified fresh stub lane.
  // Refuse to alter or drop pre-existing hosted tables.
  assert.equal(existing.rows[0].sessions, null, "requires fresh stub lane without auth.sessions");
  assert.equal(existing.rows[0].tokens, null, "requires fresh stub lane without auth.refresh_tokens");

  t.after(async () => {
    try {
      await removeFailure();
    } finally {
      try {
        if (createdTokens) await query(`DROP TABLE IF EXISTS auth.refresh_tokens`);
      } finally {
        try {
          if (createdSessions) await query(`DROP TABLE IF EXISTS auth.sessions`);
        } finally {
          try {
            if (localSessionIds.length) {
              await query(`DELETE FROM auth_sessions WHERE id = ANY($1::uuid[])`, [localSessionIds]);
            }
          } finally {
            applyMigration(fixedMigration);
          }
        }
      }
    }
  });

  await query(`
    CREATE TABLE auth.sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      created_at timestamptz DEFAULT now()
    )
  `);
  createdSessions = true;
  await query(`CREATE INDEX auth_sessions_hosted_test_user_idx ON auth.sessions(user_id)`);
  await createTokens("varchar(255)");

  applyMigration(oldMigration);
  applyMigration(fixedMigration);
  applyMigration(fixedMigration);

  await t.test("varchar revocation isolates users and is idempotent", async () => {
    applyMigration(fixedMigration);
    const userA = await seedHosted();
    const userB = await seedHosted();
    await query(`SELECT app.end_auth_sessions($1::uuid)`, [userA]);
    assert.deepEqual(await counts(userA), { sessions: 0, tokens: 0 });
    assert.deepEqual(await counts(userB), { sessions: 2, tokens: 3 });
    await query(`SELECT app.end_auth_sessions($1::uuid)`, [userA]);
    assert.deepEqual(await counts(userA), { sessions: 0, tokens: 0 });
    assert.deepEqual(await counts(userB), { sessions: 2, tokens: 3 });
  });

  await t.test("old definition raises 42883 and rolls back session deletion", async () => {
    const userA = await seedHosted();
    const userB = await seedHosted();
    try {
      applyMigration(oldMigration);
      await assert.rejects(
        () => query(`SELECT app.end_auth_sessions($1::uuid)`, [userA]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as Error & { code?: string }).code, "42883");
          return true;
        },
      );
      assert.deepEqual(await counts(userA), { sessions: 2, tokens: 3 });
      assert.deepEqual(await counts(userB), { sessions: 2, tokens: 3 });
    } finally {
      applyMigration(fixedMigration);
    }
    await query(`SELECT app.end_auth_sessions($1::uuid)`, [userA]);
    assert.deepEqual(await counts(userA), { sessions: 0, tokens: 0 });
  });

  await t.test("uuid refresh token user IDs also revoke both tables", async () => {
    applyMigration(fixedMigration);
    try {
      await query(`DROP TABLE auth.refresh_tokens`);
      createdTokens = false;
      await createTokens("uuid");
      const userA = await seedHosted();
      const userB = await seedHosted();
      await query(`SELECT app.end_auth_sessions($1::uuid)`, [userA]);
      assert.deepEqual(await counts(userA), { sessions: 0, tokens: 0 });
      assert.deepEqual(await counts(userB), { sessions: 2, tokens: 3 });
      await query(`SELECT app.end_auth_sessions($1::uuid)`, [userA]);
      assert.deepEqual(await counts(userA), { sessions: 0, tokens: 0 });
    } finally {
      if (createdTokens) await query(`DROP TABLE auth.refresh_tokens`);
      createdTokens = false;
      await createTokens("varchar(255)");
    }
  });

  await t.test("refresh token deletion failure is coded and atomic", async () => {
    applyMigration(fixedMigration);
    const userA = await seedHosted();
    const userB = await seedHosted();
    try {
      await installFailure();
      await query(`
        DROP TRIGGER end_auth_sessions_test_failure ON auth.refresh_tokens;
        CREATE TRIGGER end_auth_sessions_test_failure
          BEFORE DELETE ON auth.refresh_tokens
          FOR EACH ROW WHEN (OLD.session_id IS NULL)
          EXECUTE FUNCTION auth.${triggerFunction}();
      `);
      await assert.rejects(
        () => query(`SELECT app.end_auth_sessions($1::uuid)`, [userA]),
        (error: unknown) => {
          codedFailure(error);
          assert.ok(error instanceof Error);
          assert.equal(error.message, "END_AUTH_SESSIONS_FAILED");
          return true;
        },
      );
      assert.deepEqual(await counts(userA), { sessions: 2, tokens: 3 });
      assert.deepEqual(await counts(userB), { sessions: 2, tokens: 3 });
    } finally {
      await removeFailure();
    }
  });

  await t.test("revokeAllSessions commits local and hosted revocation", async (st) => {
    applyMigration(fixedMigration);
    const localId = await seedLocal();
    await seedHosted(USERS.admin);
    const logged = st.mock.method(console, "error", () => {});
    try {
      await revokeAllSessions(USERS.admin);
      await assertLocalRevoked(localId);
      assert.deepEqual(await counts(USERS.admin), { sessions: 0, tokens: 0 });
      assert.equal(logged.mock.callCount(), 0);
    } finally {
      logged.mock.restore();
    }
  });

  await t.test("hosted failure preserves local revocation and logs only a code", async (st) => {
    applyMigration(fixedMigration);
    const localId = await seedLocal();
    await seedHosted(USERS.admin);
    const userB = await seedHosted();
    const logged = st.mock.method(console, "error", () => {});
    try {
      await installFailure();
      await query(`
        DROP TRIGGER end_auth_sessions_test_failure ON auth.refresh_tokens;
        CREATE TRIGGER end_auth_sessions_test_failure
          BEFORE DELETE ON auth.refresh_tokens
          FOR EACH ROW WHEN (OLD.session_id IS NULL)
          EXECUTE FUNCTION auth.${triggerFunction}();
      `);
      await assert.doesNotReject(() => revokeAllSessions(USERS.admin));
      await assertLocalRevoked(localId);
      assert.deepEqual(await counts(USERS.admin), { sessions: 2, tokens: 3 });
      assert.deepEqual(await counts(userB), { sessions: 2, tokens: 3 });
      assert.equal(logged.mock.callCount(), 1);
      assert.deepEqual(logged.mock.calls[0].arguments, [
        "AUTH_HOSTED_REVOKE_FAILED",
        { code: "CA401" },
      ]);
    } finally {
      logged.mock.restore();
      await removeFailure();
    }
  });

  await t.test("execute ACL, security definer and search path remain restricted", async () => {
    applyMigration(fixedMigration);
    const result = await query<{
      service: boolean;
      anon: boolean;
      authenticated: boolean;
      public_execute: boolean;
      prosecdef: boolean;
      proconfig: string[];
    }>(`
      SELECT
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(
            coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
          ) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS public_execute,
        p.prosecdef,
        p.proconfig
      FROM pg_catalog.pg_proc AS p
      WHERE p.oid = 'app.end_auth_sessions(uuid)'::regprocedure
    `);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], {
      service: true,
      anon: false,
      authenticated: false,
      public_execute: false,
      prosecdef: true,
      proconfig: ["search_path=auth, public, pg_temp"],
    });
  });
});
