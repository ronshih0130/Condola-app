import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test, { mock } from "node:test";
import { Client, type QueryResult } from "pg";
import {
  acceptInvite, beginMfa, confirmMfa, signInWithLine, changePassword, completeSecondFactor, hashInviteToken, resetPassword, signIn, writeHardenedPassword,
} from "./auth";
import { query } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { beginCredentialChange, finishCredentialChange, credentialTransaction, withCredentialFence, captureCredentialEpoch, sessionHardeningEnabled } from "./session-hardening";
import { startSignup } from "./signup";
import { cloneTestDatabase } from "./test-database-clone";
import { totpCode } from "./totp";
import type { Session } from "./types";

const meta = { ua: "b031-local-test", ip: "127.0.0.1" };
const password = "Fixture1234";
const nextPassword = "Changed1234";
const secret = "JBSWY3DPEHPK3PXP";
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
const environment = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "TEAM_INVITES_ORG_ALLOWLIST", "LINE_LOGIN_ENABLED", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const previous = environment.map((key) => process.env[key]);

test.before(async () => {
  clone = await cloneTestDatabase(); // Validates local host + explicit disposable consent before access.
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.TEAM_INVITES_ORG_ALLOWLIST = ORG_ID;
  await resetAndSeed();
});
test.after(async () => {
  mock.restoreAll();
  for (const [index, key] of environment.entries()) {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }
  await clone?.cleanup();
});
test.beforeEach(async () => {
  await query(`INSERT INTO platform_settings (key, value) VALUES ('session_hardening', '{"enabled":true}')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await query(`UPDATE organizations SET settings = settings - 'require_2fa' WHERE id = $1`, [ORG_ID]);
});
test.afterEach(() => mock.restoreAll());

async function user(member = false) {
  const id = randomUUID();
  const email = `b031-${id}@example.test`;
  await query(`INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, role, aud)
    VALUES ($1, $2, crypt($3, gen_salt('bf')), now(), 'authenticated', 'authenticated')`, [id, email, password]);
  await query(`INSERT INTO profiles (id, email, display_name) VALUES ($1, $2, 'Fixture')
    ON CONFLICT (id) DO NOTHING`, [id, email]);
  if (member) await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'manager', 'active')`, [ORG_ID, id]);
  return { id, email };
}
function session(person: { id: string; email: string }, sessionId: string): Session {
  return { userId: person.id, sessionId, email: person.email, name: "Fixture", kind: "staff", role: "admin",
    orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
}
async function counts(id: string) {
  const result = await query<{ sessions: number; challenges: number; mfa: number }>(
    `SELECT (SELECT count(*)::int FROM auth_sessions WHERE user_id = $1) AS sessions,
      (SELECT count(*)::int FROM auth_challenges WHERE user_id = $1) AS challenges,
      (SELECT count(*)::int FROM user_mfa WHERE user_id = $1) AS mfa`, [id]);
  return result.rows[0];
}
async function factor(id: string, mode: "2fa" | "enroll") {
  if (mode === "enroll") {
    await query(`UPDATE organizations SET settings = settings || '{"require_2fa":true}'::jsonb WHERE id = $1`, [ORG_ID]);
  } else {
    await query(`INSERT INTO user_mfa (user_id, totp_secret, enabled, backup_code_hashes, confirmed_at)
      VALUES ($1, $2, true, ARRAY[$3], now())`, [id, secret, createHash("sha256").update("ABCD-EFGH").digest("hex")]);
  }
}

/** Intercept only the lock dispatch; a complete reset protocol commits on other connections.
 * This drives production entrypoints without a runtime test seam or timing sleeps. */
function resetBeforeFence(id: string) {
  const original = Client.prototype.query;
  let fired = false;
  const errors = mock.method(console, "error", () => {});
  const warnings = mock.method(console, "warn", () => {});
  mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
    if (!fired && typeof sql === "string" && sql.includes("SELECT app.b031_lock_credential_epoch(") && values?.[0] === id) {
      fired = true;
      const token = randomUUID();
      await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at)
        VALUES ($1, $2, now() + interval '1 hour')`, [id, createHash("sha256").update(token).digest("hex")]);
      assert.deepEqual(await resetPassword(token, nextPassword, nextPassword), { ok: true });
    }
    return (original as unknown as (this: Client, sql: string, values?: unknown[]) => Promise<QueryResult>).call(this, sql, values);
  }) as typeof original);
  return () => {
    assert.equal(fired, true, "real flow reached the epoch fence");
    // No rejection logs can expose tokens, password hashes, emails or challenge IDs.
    assert.equal(errors.mock.callCount(), 0);
    assert.equal(warnings.mock.callCount(), 0);
  };
}

for (const mode of ["direct", "firm", "2fa", "enroll"] as const) {
  test(`signIn ${mode}: password verified before concurrent reset protocol cannot create session/challenge`, async () => {
    const person = await user(mode !== "firm");
    if (mode === "2fa" || mode === "enroll") await factor(person.id, mode);
    const before = await counts(person.id);
    const checked = resetBeforeFence(person.id);
    assert.deepEqual(await signIn(person.email, password, false, meta), { ok: false, error: "invalid" });
    checked();
    assert.deepEqual(await counts(person.id), before);
    assert.equal((await query(`SELECT 1 FROM app.b031_challenge_epochs WHERE user_id = $1`, [person.id])).rowCount, 0);
  });
}

for (const mode of ["2fa", "enroll"] as const) {
  test(`completeSecondFactor ${mode}: concurrent reset protocol deletes challenge without MFA/session writes`, async () => {
    const person = await user(true);
    await factor(person.id, mode);
    const opened = await signIn(person.email, password, false, meta);
    assert.ok(!opened.ok && "step" in opened);
    assert.equal(opened.step, mode);
    const before = await query(`SELECT * FROM user_mfa WHERE user_id = $1`, [person.id]);
    const checked = resetBeforeFence(person.id);
    const result = await completeSecondFactor(opened.challengeId, mode === "2fa" ? "ABCD-EFGH" : totpCode(opened.secret!), meta);
    assert.deepEqual(result, { ok: false, error: "invalid" });
    checked();
    assert.deepEqual(await counts(person.id), { sessions: 0, challenges: 0, mfa: before.rowCount });
    assert.deepEqual((await query(`SELECT * FROM user_mfa WHERE user_id = $1`, [person.id])).rows, before.rows);
    assert.equal((await query(`SELECT 1 FROM app.b031_challenge_epochs WHERE user_id = $1`, [person.id])).rowCount, 0);
  });

  test(`completeSecondFactor ${mode}: current epoch commits MFA/session and consumes challenge once`, async () => {
    const person = await user(true);
    await factor(person.id, mode);
    const opened = await signIn(person.email, password, false, meta);
    assert.ok(!opened.ok && "step" in opened);
    const result = await completeSecondFactor(opened.challengeId, totpCode(opened.secret ?? secret), meta);
    assert.equal(result.ok, true);
    assert.deepEqual(await counts(person.id), { sessions: 1, challenges: 0, mfa: 1 });
    assert.deepEqual(await completeSecondFactor(opened.challengeId, totpCode(opened.secret ?? secret), meta), { ok: false, error: "invalid" });
  });
}

test("signup existing confirmed account rejects a stale password epoch", async () => {
  const person = await user();
  const checked = resetBeforeFence(person.id);
  const result = await startSignup({ email: person.email, password, confirm: password, partnerCode: "",
    origin: "http://127.0.0.1:3000", meta, consent: true });
  assert.deepEqual(result, { ok: false, error: "duplicate" });
  checked();
  assert.deepEqual(await counts(person.id), { sessions: 0, challenges: 0, mfa: 0 });
  assert.equal((await query(`SELECT 1 FROM public.consents WHERE user_id = $1`, [person.id])).rowCount, 0);
  assert.equal((await query(`SELECT raw_app_meta_data->'consent' AS consent FROM auth.users WHERE id = $1`, [person.id])).rows[0].consent, null);
});

for (const kind of ["team_member", "tenant"] as const) {
  test(`invitation ${kind} rejects stale epoch and leaves invitation pending`, async () => {
    const person = await user();
    const token = randomUUID();
    let contactId: string | null = null;
    if (kind === "tenant") {
      const contact = await query<{ id: string }>(`INSERT INTO contacts (org_id, user_id, email, display_name, is_tenant)
        VALUES ($1, $2, $3, 'Fixture', true) RETURNING id::text`, [ORG_ID, person.id, person.email]);
      contactId = contact.rows[0].id;
    }
    await query(`INSERT INTO invitations (org_id, email, role, kind, contact_id, code_hash, expires_at, invited_by)
      VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 day', $7)`,
    [ORG_ID, person.email, kind === "team_member" ? "manager" : null, kind, contactId, hashInviteToken(token), USERS.admin]);
    const checked = resetBeforeFence(person.id);
    const result = await acceptInvite(token, "Fixture", password, password, meta, "", "", true);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid");
    checked();
    assert.deepEqual(await counts(person.id), { sessions: 0, challenges: 0, mfa: 0 });
    assert.equal((await query(`SELECT status FROM invitations WHERE code_hash = $1`, [hashInviteToken(token)])).rows[0].status, "pending");
  });
}

test("FOR SHARE holds a bump until session creation commits; bump revocation then wins", async () => {
  const person = await user();
  await query(`INSERT INTO app.b031_credential_epochs (user_id) VALUES ($1)`, [person.id]);
  const holder = new Client({ connectionString: clone.url });
  const changer = new Client({ connectionString: clone.url });
  await holder.connect(); await changer.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT app.b031_lock_credential_epoch($1, 0)`, [person.id]);
    const pid = (await changer.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    let completed = false;
    pending = (async () => {
      await changer.query("BEGIN");
      await changer.query(`SELECT app.b031_bump_credential_epoch($1)`, [person.id]);
      await changer.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1`, [person.id]);
      await changer.query("COMMIT");
      completed = true;
    })();
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked = (await holder.query(`SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`, [pid])).rows[0].blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true);
    assert.equal(completed, false);
    await holder.query(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [person.id, randomUUID()]);
    await holder.query("COMMIT");
    await pending;
    assert.equal(await captureCredentialEpoch(person.id), "1");
    assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id])).rowCount, 0);
  } finally {
    await holder.query("ROLLBACK");
    await pending;
    await holder.end(); await changer.end();
  }
});

test("password change and reset each bump twice durably and revoke old sessions/challenges", async () => {
  const person = await user();
  assert.equal((await signIn(person.email, password, false, meta)).ok, true);
  const currentId = (await query(`SELECT id FROM auth_sessions WHERE user_id = $1`, [person.id])).rows[0].id;
  await query(`INSERT INTO auth_challenges (user_id, purpose, remember, expires_at) VALUES ($1, '2fa', false, now() + interval '1 hour')`, [person.id]);
  await changePassword(session(person, currentId), password, nextPassword, nextPassword);
  assert.equal(await captureCredentialEpoch(person.id), "2");
  assert.equal((await query(`SELECT 1 FROM auth_challenges WHERE user_id = $1`, [person.id])).rowCount, 0);
  const token = randomUUID();
  await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [person.id, createHash("sha256").update(token).digest("hex")]);
  assert.deepEqual(await resetPassword(token, password, password), { ok: true });
  assert.equal(await captureCredentialEpoch(person.id), "4");
  assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id])).rowCount, 0);
  assert.deepEqual(await resetPassword(token, nextPassword, nextPassword), { ok: false, error: "expired" });
  assert.equal(await captureCredentialEpoch(person.id), "4");
});

test("flag OFF sign-in, MFA and password change leave both private tables empty", async () => {
  await query(`UPDATE platform_settings SET value = '{"enabled":false}' WHERE key = 'session_hardening'`);
  await query(`DELETE FROM app.b031_credential_changes`);
  await query(`DELETE FROM app.b031_challenge_epochs`);
  await query(`DELETE FROM app.b031_credential_epochs`);
  const person = await user(true);
  const original = Client.prototype.query;
  const hardeningSql: string[] = [];
  mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("b031_")) hardeningSql.push(sql);
    return (original as unknown as (this: Client, sql: string, values?: unknown[]) => Promise<QueryResult>).call(this, sql, values);
  }) as typeof original);
  assert.equal((await signIn(person.email, password, false, meta)).ok, true);
  await factor(person.id, "enroll");
  const opened = await signIn(person.email, password, false, meta);
  assert.ok(!opened.ok && "step" in opened);
  assert.equal((await completeSecondFactor(opened.challengeId, totpCode(opened.secret!), meta)).ok, true);
  const currentId = (await query(`SELECT id FROM auth_sessions WHERE user_id = $1 LIMIT 1`, [person.id])).rows[0].id;
  await changePassword(session(person, currentId), password, nextPassword, nextPassword);
  assert.deepEqual(hardeningSql, Array(4).fill("SELECT app.b031_session_hardening_enabled() AS enabled"));
  assert.equal(await captureCredentialEpoch(person.id), null);
  for (const table of ["b031_credential_epochs", "b031_challenge_epochs", "b031_challenge_exempt", "b031_credential_changes"]) {
    assert.equal((await query(`SELECT 1 FROM app.${table}`)).rowCount, 0);
  }
});

test("strict flag, read-only capture, private RLS and server-only function privileges", async () => {
  const person = await user();
  for (const value of ['{}', '{"enabled":"true"}', '{"enabled":1}', '{"enabled":null}']) {
    await query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'session_hardening'`, [value]);
    assert.equal(await sessionHardeningEnabled(), false);
  }
  await query(`UPDATE platform_settings SET value = '{"enabled":true}' WHERE key = 'session_hardening'`);
  assert.equal(await captureCredentialEpoch(person.id), "0");
  assert.equal((await query(`SELECT 1 FROM app.b031_credential_epochs WHERE user_id = $1`, [person.id])).rowCount, 0);
  const functions = await query(`SELECT p.oid, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname IN ('b031_session_hardening_enabled', 'b031_credential_epoch', 'b031_bump_credential_epoch', 'b031_lock_credential_epoch', 'b031_begin_credential_change', 'b031_finish_credential_change', 'b031_reconcile_credential_change')`);
  assert.equal(functions.rowCount, 7);
  for (const fn of functions.rows) {
    assert.equal(fn.prosecdef, true);
    assert.ok(fn.proconfig.includes("search_path=pg_catalog, pg_temp"));
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await query(`SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS allowed`, [role, fn.oid])).rows[0].allowed, false);
    }
  }
  for (const table of ["b031_credential_epochs", "b031_challenge_epochs", "b031_challenge_exempt", "b031_credential_changes"]) {
    assert.equal((await query(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`app.${table}`])).rows[0].relrowsecurity, true);
    assert.equal((await query(`SELECT 1 FROM pg_policies WHERE schemaname = 'app' AND tablename = $1`, [table])).rowCount, 0);
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await query(`SELECT has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') AS allowed`, [role, `app.${table}`])).rows[0].allowed, false);
    }
  }
});

for (const flow of ["change", "reset"] as const) {
  test(`${flow} phase-1 failure rolls back before any password write`, async () => {
    const person = await user();
    assert.equal((await signIn(person.email, password, false, meta)).ok, true);
    const currentId = (await query(`SELECT id FROM auth_sessions WHERE user_id = $1`, [person.id])).rows[0].id;
    const token = randomUUID();
    await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [person.id, createHash("sha256").update(token).digest("hex")]);
    const original = Client.prototype.query;
    let injected = false;
    const interceptor = mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      if (typeof sql === "string" && sql.startsWith("UPDATE auth_sessions SET revoked_at") && values?.[0] === person.id) {
        injected = true;
        throw new Error("injected local revocation failure");
      }
      return (original as unknown as (this: Client, sql: string, values?: unknown[]) => Promise<QueryResult>).call(this, sql, values);
    }) as typeof original);
    try {
      await assert.rejects(() => flow === "change"
        ? changePassword(session(person, currentId), password, nextPassword, nextPassword)
        : resetPassword(token, nextPassword, nextPassword), /injected local revocation failure/);
    } finally { interceptor.mock.restore(); }
    assert.equal(injected, true);
    assert.equal(await captureCredentialEpoch(person.id), "0");
    assert.equal((await query(`SELECT encrypted_password = crypt($2, encrypted_password) AS matches FROM auth.users WHERE id = $1`, [person.id, password])).rows[0].matches, true);
    assert.equal((await query(`SELECT used_at FROM auth_password_resets WHERE user_id = $1`, [person.id])).rows[0].used_at, null);
    assert.equal((await query(`SELECT revoked_at FROM auth_sessions WHERE id = $1`, [currentId])).rows[0].revoked_at, null);
  });
}

for (const kind of ["team_member", "tenant"] as const) {
  for (const state of ["existing", "passwordless", "new"] as const) {
    test(`invitation ${kind}/${state} atomically provisions and creates a fenced session`, async () => {
      const person = state === "new" ? { id: null, email: `b031-new-${randomUUID()}@example.test` } : await user();
      if (state === "passwordless") await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
      const token = randomUUID();
      let contactId: string | null = null;
      if (kind === "tenant") {
        contactId = (await query<{ id: string }>(`INSERT INTO contacts (org_id, user_id, email, display_name, is_tenant)
          VALUES ($1, $2, $3, 'Fixture', true) RETURNING id::text`, [ORG_ID, person.id, person.email])).rows[0].id;
      }
      await query(`INSERT INTO invitations (org_id, email, role, kind, contact_id, code_hash, expires_at, invited_by)
        VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 day', $7)`,
      [ORG_ID, person.email, kind === "team_member" ? "manager" : null, kind, contactId, hashInviteToken(token), USERS.admin]);
      const result = await acceptInvite(token, "Fixture", password, password, meta, "", "", true);
      assert.equal(result.ok, true);
      const id = (await query(`SELECT id FROM auth.users WHERE email = $1`, [person.email])).rows[0].id;
      assert.deepEqual(await counts(id), { sessions: 1, challenges: 0, mfa: 0 });
      assert.equal(await captureCredentialEpoch(id), state !== "existing" ? "2" : "0");
      assert.equal((await query(`SELECT 1 FROM app.b031_credential_epochs WHERE user_id = $1`, [id])).rowCount, 1);
      assert.equal((await query(`SELECT status FROM invitations WHERE code_hash = $1`, [hashInviteToken(token)])).rows[0].status, "accepted");
      if (kind === "team_member") {
        const record = (await query(`SELECT accepted_at, terms_version, privacy_version, source FROM public.consents WHERE user_id = $1`, [id])).rows;
        assert.equal(record.length, 1);
        const mirror = (await query(`SELECT raw_app_meta_data->'consent' AS consent FROM auth.users WHERE id = $1`, [id])).rows[0].consent;
        assert.deepEqual({ ...record[0], accepted_at: record[0].accepted_at.toISOString() }, mirror);
        assert.equal(mirror.source, "invite");
      }
    });
  }
}

async function invitation(person: { id: string | null; email: string }, kind: "team_member" | "tenant", orgId = ORG_ID) {
  const token = randomUUID();
  const contactId = kind === "tenant" ? (await query(`INSERT INTO contacts (org_id, user_id, email, display_name, is_tenant)
    VALUES ($1, $2, $3, 'Fixture', true) RETURNING id`, [orgId, person.id, person.email])).rows[0].id : null;
  await query(`INSERT INTO invitations (org_id, email, role, kind, contact_id, code_hash, expires_at, invited_by)
    VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 day', $7)`,
  [orgId, person.email, kind === "team_member" ? "manager" : null, kind, contactId, hashInviteToken(token), USERS.admin]);
  return token;
}

for (const flow of ["change", "reset"] as const) {
  test(`settings enrollment: ${flow} after challenge capture prevents cached MFA secret/backup writes`, async () => {
    const person = await user();
    const current = session(person, randomUUID());
    const opened = await beginMfa(current);
    assert.equal((await query(`SELECT provenance FROM app.b031_challenge_epochs WHERE challenge_id = $1`, [opened.challengeId])).rows[0].provenance, "settings");
    const token = randomUUID();
    await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [person.id, createHash("sha256").update(token).digest("hex")]);
    const original = Client.prototype.query;
    let fired = false;
    mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      const result = await (original as QueryFn).call(this, sql, values);
      if (!fired && sql.includes("SELECT epoch::text FROM app.b031_challenge_epochs") && values?.[0] === opened.challengeId) {
        fired = true;
        assert.equal(result.rows.length, 1, "enrollment was captured before competing deletion");
        if (flow === "change") await changePassword(current, password, nextPassword, nextPassword);
        else assert.deepEqual(await resetPassword(token, nextPassword, nextPassword), { ok: true });
      }
      return result;
    }) as typeof original);
    await assert.rejects(() => confirmMfa(current, opened.challengeId, totpCode(opened.secret)), { key: "errors.authInvalid" });
    assert.equal(fired, true);
    assert.deepEqual(await counts(person.id), { sessions: 0, challenges: 0, mfa: 0 });
  });
}

test("settings enrollment commits MFA and consumes challenge once without creating a session", async () => {
  const person = await user();
  const current = session(person, randomUUID());
  const opened = await beginMfa(current);
  const codes = await confirmMfa(current, opened.challengeId, totpCode(opened.secret));
  assert.ok(codes.length > 0);
  assert.deepEqual(await counts(person.id), { sessions: 0, challenges: 0, mfa: 1 });
  await assert.rejects(() => confirmMfa(current, opened.challengeId, totpCode(opened.secret)), { key: "errors.authInvalid" });
});

for (const mode of ["2fa", "enroll"] as const) {
  test(`LINE demo ${mode}: explicit exemption preserves second-factor completion`, async () => {
    const person = await user(true);
    process.env.LINE_LOGIN_ENABLED = "true";
    await query(`UPDATE profiles SET line_linked = (id = $1)`, [person.id]);
    await factor(person.id, mode);
    const opened = await signInWithLine(meta);
    assert.ok(!opened.ok && "step" in opened);
    assert.equal(opened.step, mode);
    assert.equal((await query(`SELECT reason FROM app.b031_challenge_exempt WHERE challenge_id = $1`, [opened.challengeId])).rows[0].reason, "line_demo");
    assert.equal((await query(`SELECT 1 FROM app.b031_challenge_epochs WHERE challenge_id = $1`, [opened.challengeId])).rowCount, 0);
    assert.equal((await completeSecondFactor(opened.challengeId, totpCode(opened.secret ?? secret), meta)).ok, true);
    assert.equal((await query(`SELECT 1 FROM app.b031_challenge_exempt WHERE challenge_id = $1`, [opened.challengeId])).rowCount, 0);
    assert.equal(await captureCredentialEpoch(person.id), "0");
  });
}

test("unclassified challenges fail closed after flag activation", async () => {
  const person = await user(true);
  const challenge = (await query(`INSERT INTO auth_challenges (user_id, purpose, remember, totp_secret, expires_at)
    VALUES ($1, 'enroll', false, $2, now() + interval '1 hour') RETURNING id`, [person.id, secret])).rows[0].id;
  assert.deepEqual(await completeSecondFactor(challenge, totpCode(secret), meta), { ok: false, error: "invalid" });
  assert.deepEqual(await counts(person.id), { sessions: 0, challenges: 0, mfa: 0 });
});

type QueryFn = (this: Client, sql: string, values?: unknown[]) => Promise<QueryResult>;

for (const flow of ["team_member", "tenant", "signup"] as const) {
  test(`${flow}: real password change AFTER successful verification makes acceptance fail`, { timeout: 15000 }, async () => {
    const person = await user();
    const token = flow === "signup" ? null : await invitation(person, flow);
    const original = Client.prototype.query;
    let fired = false;
    mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      const result = await (original as QueryFn).call(this, sql, values);
      const verified = sql.includes("AS matches") || sql.includes("crypt($2, encrypted_password) AS ok");
      if (!fired && verified && (values?.[0] === person.email || values?.[0] === person.id)) {
        fired = true;
        assert.equal(result.rows[0][flow === "signup" ? "ok" : "matches"], true);
        await changePassword(session(person, randomUUID()), password, nextPassword, nextPassword);
      }
      return result;
    }) as typeof original);
    const result = flow === "signup"
      ? await startSignup({ email: person.email, password, confirm: password, partnerCode: "", origin: "http://127.0.0.1:3000", meta, consent: true })
      : await acceptInvite(token!, "Fixture", password, password, meta, "", "", true);
    assert.equal(fired, true);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, flow === "signup" ? "duplicate" : "invalid");
    assert.equal(await captureCredentialEpoch(person.id), "2");
    assert.deepEqual(await counts(person.id), { sessions: 0, challenges: 0, mfa: 0 });
    if (token) assert.equal((await query(`SELECT status FROM invitations WHERE code_hash = $1`, [hashInviteToken(token)])).rows[0].status, "pending");
  });
}

test("concurrent password changes verified at epoch zero: only one commits", { timeout: 15000 }, async () => {
  const person = await user();
  const original = Client.prototype.query;
  let verified = 0;
  let release!: () => void;
  const bothVerified = new Promise<void>((resolve) => { release = resolve; });
  mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
    const result = await (original as QueryFn).call(this, sql, values);
    if (sql.includes("AND encrypted_password = crypt($2, encrypted_password)") && values?.[0] === person.email) {
      assert.equal(result.rows[0].id, person.id);
      if (++verified === 2) release();
      await bothVerified;
    }
    return result;
  }) as typeof original);
  const results = await Promise.allSettled([nextPassword, "Another1234"].map((value) =>
    changePassword(session(person, randomUUID()), password, value, value)));
  assert.equal(verified, 2);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(failed.reason.key, "errors.authInvalid");
  assert.equal(await captureCredentialEpoch(person.id), "2");
});

/** Real HTTP provider with local SQL persistence only. No network beyond loopback. */
async function provider(person: { id: string; email: string }, behavior: "success" | "reject" | "lost", during?: () => Promise<void>, beforeCommit?: () => Promise<void>) {
  let failure: unknown;
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      if (request.url?.startsWith("/auth/v1/token")) {
        const matches = (await query(`SELECT encrypted_password = crypt($2, encrypted_password) AS matches FROM auth.users WHERE id = $1`, [person.id, payload.password])).rows[0].matches;
        response.writeHead(matches ? 200 : 400, { "Content-Type": "application/json" });
        response.end(JSON.stringify(matches ? { user: { id: person.id } } : { error: "invalid_grant" }));
        return;
      }
      calls++;
      if (request.method === "POST") {
        assert.equal(request.url, "/auth/v1/admin/users");
        assert.equal(payload.password, undefined, "new hosted identity is passwordless until phase 1 commits");
        await query(`INSERT INTO auth.users (id, email, role, aud) VALUES ($1, $2, 'authenticated', 'authenticated')`, [person.id, person.email]);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: person.id }));
        return;
      }
      assert.equal(request.method, "PUT");
      assert.equal(request.url, `/auth/v1/admin/users/${person.id}`);
      assert.equal((await query(`SELECT state FROM app.b031_credential_changes WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`, [person.id])).rows[0].state, "pending");
      // Acquiring the epoch exclusively proves no DB epoch lock spans the HTTP call.
      const contender = new Client({ connectionString: clone.url });
      await contender.connect();
      try {
        await contender.query("BEGIN");
        await contender.query("SET LOCAL lock_timeout = '100ms'");
        await contender.query(`SELECT 1 FROM app.b031_credential_epochs WHERE user_id = $1 FOR UPDATE`, [person.id]);
        await contender.query("ROLLBACK");
      } finally { await contender.end(); }
      if (beforeCommit) await beforeCommit();
      if (behavior !== "reject") await query(`UPDATE auth.users SET encrypted_password = crypt($2, gen_salt('bf')), email_confirmed_at = now() WHERE id = $1`, [person.id, payload.password]);
      if (during) await during();
      if (behavior === "lost") return; // Provider committed, but never sends its response.
      response.writeHead(behavior === "reject" ? 422 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(behavior === "reject" ? { error: "rejected" } : { id: person.id }));
    } catch (error) { failure = error; response.destroy(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "loopback-fixture-only";
  process.env.SUPABASE_ANON_KEY = "loopback-fixture-only";
  return { async close() {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (failure) throw failure;
    assert.ok(calls > 0);
  } };
}

for (const kind of ["team_member", "tenant"] as const) {
  test(`hosted new ${kind} provisions passwordless first, then creates session only with phase-2 done`, async () => {
    const person = { id: randomUUID(), email: `hosted-new-${randomUUID()}@example.test` };
    const token = await invitation({ ...person, id: null }, kind);
    const remote = await provider(person, "success", async () => {
      assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1`, [person.id])).rowCount, 0);
      assert.equal((await query(`SELECT status FROM invitations WHERE code_hash = $1`, [hashInviteToken(token)])).rows[0].status, "pending");
    });
    try {
      assert.equal((await acceptInvite(token, "Fixture", nextPassword, nextPassword, meta, "", "", true)).ok, true);
      assert.equal((await query(`SELECT state FROM app.b031_credential_changes WHERE user_id = $1`, [person.id])).rows[0].state, "done");
      assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id])).rowCount, 1);
      assert.equal((await query(`SELECT 1 FROM profiles WHERE id = $1`, [person.id])).rowCount, 1);
      assert.equal(await captureCredentialEpoch(person.id), "2");
    } finally { await remote.close(); }
  });
}

for (const flow of ["change", "reset", "team_member", "tenant"] as const) {
  for (const behavior of ["success", "reject", "lost", "phase2-failure"] as const) {
    test(`hosted ${flow}/${behavior}: durable revocation, pending fence and provider outcome`, { timeout: 15000 }, async () => {
      const person = await user();
      await signIn(person.email, password, false, meta);
      await signIn(person.email, password, false, meta);
      const currentId = (await query(`SELECT id FROM auth_sessions WHERE user_id = $1 LIMIT 1`, [person.id])).rows[0].id;
      await query(`INSERT INTO auth_challenges (user_id, purpose, remember, expires_at) VALUES ($1, '2fa', false, now() + interval '1 hour')`, [person.id]);
      let token: string;
      if (flow === "reset" || flow === "change") {
        token = randomUUID();
        await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
          [person.id, createHash("sha256").update(token).digest("hex")]);
      } else {
        await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
        token = await invitation(person, flow);
      }
      const original = Client.prototype.query;
      let injected = false;
      if (behavior === "phase2-failure") mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
        if (!injected && sql.includes("SELECT app.b031_finish_credential_change(") && values?.[0] === person.id) {
          injected = true;
          throw new Error("injected phase 2 failure");
        }
        return (original as QueryFn).call(this, sql, values);
      }) as typeof original);
      // Allow the request to commit before the shortened deadline fires.
      if (behavior === "lost") {
        mock.restoreAll();
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        mock.method(AbortSignal, "timeout", (ms: number) => { assert.ok(ms > 0 && ms <= 90_000); return timeout(500); });
      }
      const remote = await provider(person, behavior === "phase2-failure" ? "success" : behavior, async () => {
        assert.equal(await captureCredentialEpoch(person.id), "1");
        assert.equal((await signIn(person.email, behavior === "reject" ? password : nextPassword, false, meta)).ok, false,
          "even a provider-verified password cannot create a session while pending");
        if (flow === "team_member" || flow === "tenant") {
          const contender = new Client({ connectionString: clone.url });
          await contender.connect();
          try {
            await contender.query("BEGIN");
            await contender.query("SET LOCAL lock_timeout = '100ms'");
            await contender.query(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [ORG_ID]);
            await contender.query(`SELECT id FROM invitations WHERE code_hash = $1 FOR UPDATE`, [hashInviteToken(token)]);
            assert.equal((await contender.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`, [hashInviteToken(token)])).rows[0].acquired, true);
            await contender.query("ROLLBACK");
          } finally { await contender.end(); }
        }
        assert.equal((await query(`SELECT 1 FROM auth_challenges WHERE user_id = $1`, [person.id])).rowCount, 0);
        const active = await query(`SELECT id FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id]);
        assert.deepEqual(active.rows.map((r) => r.id), flow === "change" ? [currentId] : []);
        // Simulate a session from an explicitly unfenced path during the provider gap.
        await query(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [person.id, randomUUID()]);
      });
      try {
        const action = () => flow === "change" ? changePassword(session(person, currentId), password, nextPassword, nextPassword)
          : flow === "reset" ? resetPassword(token, nextPassword, nextPassword)
          : acceptInvite(token, "Fixture", nextPassword, nextPassword, meta, "", "", true);
        if (behavior === "success") {
          const result = await action();
          if (result) assert.equal(result.ok, true);
        } else if (flow === "change" || flow === "reset" || (flow === "team_member" && behavior === "phase2-failure")) {
          await assert.rejects(action, behavior === "phase2-failure" ? /injected phase 2 failure/ : { key: "errors.generic" });
        } else {
          const result = await action();
          assert.ok(result && !result.ok);
        }
        const state = (await query(`SELECT state FROM app.b031_credential_changes WHERE user_id = $1`, [person.id])).rows[0].state;
        assert.equal(state, behavior === "phase2-failure" ? "pending" : behavior === "success" ? "done" : behavior === "reject" ? "failed" : "unknown");
        assert.equal(await captureCredentialEpoch(person.id), behavior === "phase2-failure" ? "1" : "2");
        if (behavior === "phase2-failure" || behavior === "lost") {
          if (behavior === "phase2-failure") assert.equal(injected, true);
          assert.equal((await signIn(person.email, nextPassword, false, meta)).ok, false);
          await query(`UPDATE app.b031_credential_changes SET started_at = now() - interval '3 minutes' WHERE user_id = $1`, [person.id]);
          // Production login performs recovery itself. No manual reconciliation helper.
          const recovered = await signIn(person.email, nextPassword, false, meta);
          assert.equal(recovered.ok, true);
          assert.equal(await captureCredentialEpoch(person.id), behavior === "lost" ? "3" : "2");
          await query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1`, [person.id]);
        }
        const oldActive = await query(`SELECT id FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL AND id = $2`, [person.id, currentId]);
        assert.equal(oldActive.rowCount, flow === "change" && behavior !== "phase2-failure" && behavior !== "lost" ? 1 : 0);
        const activeCount = (await query(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id])).rows[0].n;
        assert.equal(activeCount, flow === "change" && behavior !== "phase2-failure" && behavior !== "lost" ? 1
          : (flow === "team_member" || flow === "tenant") && behavior === "success" ? 1 : 0,
          "phase 2/reconciliation also revokes sessions created during the provider gap");
        if (behavior !== "reject") assert.equal((await signIn(person.email, nextPassword, false, meta)).ok, true);
        else if (flow === "change" || flow === "reset") assert.equal((await signIn(person.email, password, false, meta)).ok, true);
        if (flow === "team_member" || flow === "tenant") {
          assert.equal((await query(`SELECT status FROM invitations WHERE code_hash = $1`, [hashInviteToken(token)])).rows[0].status, behavior === "success" ? "accepted" : "pending");
        }
      } finally { await remote.close(); }
    });
  }
}

for (const flow of ["change", "reset", "team_member", "tenant"] as const) {
  test(`hosted ${flow} missing service key rejects before any write`, async () => {
    const person = await user();
    let token = randomUUID();
    if (flow === "reset") await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [person.id, createHash("sha256").update(token).digest("hex")]);
    if (flow === "team_member" || flow === "tenant") {
      await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
      token = await invitation(person, flow);
    }
    const original = Client.prototype.query;
    const writes: string[] = [];
    mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) || /SELECT app.b031_(begin|finish|bump)/.test(sql)) writes.push(sql);
      return (original as QueryFn).call(this, sql, values);
    }) as typeof original);
    process.env.SUPABASE_URL = "http://127.0.0.1:1";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (flow === "change") process.env.SUPABASE_ANON_KEY = "loopback-fixture-only";
    const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("must not call provider"); });
    try {
      if (flow === "change") await assert.rejects(() => changePassword(session(person, randomUUID()), password, nextPassword, nextPassword), { key: "errors.generic" });
      else if (flow === "reset") await assert.rejects(() => resetPassword(token, nextPassword, nextPassword), { key: "errors.generic" });
      else assert.equal((await acceptInvite(token, "Fixture", nextPassword, nextPassword, meta, "", "", true)).ok, false);
      assert.deepEqual(writes, []);
      assert.equal(fetcher.mock.callCount(), 0);
    } finally { delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY; }
  });
}

for (const kind of ["team_member", "tenant"] as const) {
  test(`hosted new ${kind} missing service key cannot provision or write`, async () => {
    const email = `missing-${randomUUID()}@example.test`;
    const token = await invitation({ id: null, email }, kind);
    process.env.SUPABASE_URL = "http://127.0.0.1:1";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("must not call provider"); });
    const original = Client.prototype.query;
    const writes: string[] = [];
    mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) || /SELECT app\.(provision|b031_(begin|finish|bump))/.test(sql)) writes.push(sql);
      return (original as QueryFn).call(this, sql, values);
    }) as typeof original);
    try {
      assert.equal((await acceptInvite(token, "Fixture", nextPassword, nextPassword, meta, "", "", true)).ok, false);
      assert.deepEqual(writes, []);
      assert.equal(fetcher.mock.callCount(), 0);
    } finally { delete process.env.SUPABASE_URL; }
  });
}

test("next change reconciles an abandoned pending exactly once before its two phases", async () => {
  const person = await user();
  await query(`SELECT app.b031_begin_credential_change($1, 0)`, [person.id]);
  await query(`UPDATE app.b031_credential_changes SET started_at = now() - interval '3 minutes' WHERE user_id = $1`, [person.id]);
  await changePassword(session(person, randomUUID()), password, nextPassword, nextPassword);
  assert.equal(await captureCredentialEpoch(person.id), "4");
  assert.deepEqual((await query(`SELECT state FROM app.b031_credential_changes WHERE user_id = $1 ORDER BY started_at`, [person.id])).rows.map((r) => r.state), ["unknown", "done"]);
});

for (const kind of ["team_member", "tenant"] as const) {
  test(`concurrent ${kind} passwordless acceptances: one password/session survives and old credentials are revoked`, { timeout: 15000 }, async () => {
    const person = await user();
    await signIn(person.email, password, false, meta);
    await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
    await query(`INSERT INTO auth_challenges (user_id, purpose, remember, expires_at) VALUES ($1, '2fa', false, now() + interval '1 hour')`, [person.id]);
    const tokens = await Promise.all([invitation(person, kind), invitation(person, kind, kind === "tenant" ? ORG2_ID : ORG_ID)]);
    if (kind === "tenant") {
      const original = Client.prototype.query;
      let captured = 0;
      let release!: () => void;
      const bothCaptured = new Promise<void>((resolve) => { release = resolve; });
      mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
        const result = await (original as QueryFn).call(this, sql, values);
        if (sql.includes("AS matches") && values?.[0] === person.email) {
          assert.equal(result.rows[0].has_password, false);
          if (++captured === 2) release();
          await bothCaptured;
        }
        return result;
      }) as typeof original);
    }
    const results = await Promise.all(tokens.map((token, index) => {
      const value = index ? nextPassword : password;
      return acceptInvite(token, "Fixture", value, value, meta, "", "", true);
    }));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(await captureCredentialEpoch(person.id), "2");
    assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id])).rowCount, 1);
    assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL`, [person.id])).rowCount, 1);
    assert.equal((await query(`SELECT 1 FROM auth_challenges WHERE user_id = $1`, [person.id])).rowCount, 0);
    const winner = results.findIndex((r) => r.ok);
    assert.equal((await query(`SELECT encrypted_password = crypt($2, encrypted_password) AS matches FROM auth.users WHERE id = $1`,
      [person.id, winner ? nextPassword : password])).rows[0].matches, true);
  });
}

for (const kind of ["team_member", "tenant"] as const) {
  for (const failure of (kind === "team_member" ? ["revoked", "seat"] : ["revoked"]) as ("revoked" | "seat")[]) {
    test(`${kind}: finish commits then acceptance rolls back (${failure}); new password still works`, async () => {
      const person = await user();
      await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
      const token = await invitation(person, kind);
      const originalOrg = (await query(`SELECT plan_tier, settings FROM organizations WHERE id = $1`, [ORG_ID])).rows[0];
      let finished = false;
      const original = Client.prototype.query;
      const spy = mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
        if (sql.includes("SELECT app.b031_lock_credential_epoch(") && values?.[0] === person.id) {
          assert.equal((await query(`SELECT state FROM app.b031_credential_changes WHERE user_id = $1`, [person.id])).rows[0].state, "done");
          assert.equal(await captureCredentialEpoch(person.id), "2");
          finished = true;
          if (failure === "revoked") await query(`UPDATE invitations SET status = 'revoked' WHERE code_hash = $1`, [hashInviteToken(token)]);
          else await query(`UPDATE organizations SET plan_tier = 'free', settings = settings - 'plan' WHERE id = $1`, [ORG_ID]);
        }
        return (original as QueryFn).call(this, sql, values);
      }) as typeof original);
      try {
        const result = await acceptInvite(token, "Fixture", nextPassword, nextPassword, meta, "", "", true);
        assert.equal(finished, true);
        assert.equal(result.ok, false);
        if (!result.ok && failure === "seat") assert.equal(result.error, "errors.seatLimit");
        assert.deepEqual(await counts(person.id), { sessions: 0, challenges: 0, mfa: 0 });
      } finally {
        spy.mock.restore();
        await query(`UPDATE organizations SET plan_tier = $2, settings = $3 WHERE id = $1`, [ORG_ID, originalOrg.plan_tier, originalOrg.settings]);
      }
      assert.equal((await signIn(person.email, nextPassword, false, meta)).ok, true);
      assert.equal(await captureCredentialEpoch(person.id), "2");
    });
  }

  for (const initial of ["passwordless", "established"] as const) {
    test(`${kind}: same-invite double submit (${initial}) has one session and no deadlock`, { timeout: 15000 }, async () => {
      const person = await user();
      if (initial === "passwordless") await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
      const token = await invitation(person, kind);
      const original = Client.prototype.query;
      let readers = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
        const result = await (original as QueryFn).call(this, sql, values);
        const matches = kind === "tenant" ? sql.includes("AS matches") && values?.[0] === person.email
          : sql.includes("AS matches FROM auth.users WHERE id = $1") && values?.[0] === person.id;
        if (matches && readers < 2) { if (++readers === 2) release(); await ready; }
        return result;
      }) as typeof original);
      const results = await Promise.all([1, 2].map(() => acceptInvite(token, "Fixture", password, password, meta, "", "", true)));
      assert.equal(readers, 2);
      assert.equal(results.filter((r) => r.ok).length, 1);
      assert.equal((await counts(person.id)).sessions, 1);
    });
  }
}

test("production fence recovers abandoned change before rejecting stale epoch; recovery survives rollback", async () => {
  const person = await user();
  await credentialTransaction((client) => beginCredentialChange(client, person.id, "0"));
  await query(`UPDATE app.b031_credential_changes SET started_at = now() - interval '3 minutes' WHERE user_id = $1`, [person.id]);
  const results = await Promise.allSettled([1, 2].map(() => withCredentialFence(person.id, "0", async () => assert.fail("stale fence"))));
  assert.ok(results.every((r) => r.status === "rejected" && r.reason.code === "P0B31"));
  assert.equal(await captureCredentialEpoch(person.id), "2", "single recovery winner, despite both rejected transactions");
  assert.equal((await signIn(person.email, password, false, meta)).ok, true);
  assert.equal(await captureCredentialEpoch(person.id), "2");
});

test("expired provider budget skips HTTP and SQL writes, including connection/phase-1 delay", async () => {
  const person = await user();
  const change = await credentialTransaction((client) => beginCredentialChange(client, person.id, "0"));
  const expired = { ...change, startedAt: Date.now() - 90_001 };
  assert.equal(await writeHardenedPassword(expired, nextPassword), "failed");
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "loopback-fixture-only";
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("expired call"); });
  try {
    assert.equal(await writeHardenedPassword(expired, nextPassword), "failed");
    assert.equal(fetcher.mock.callCount(), 0);
  } finally { delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
  assert.equal((await query(`SELECT encrypted_password = crypt($2, encrypted_password) AS matches FROM auth.users WHERE id = $1`, [person.id, password])).rows[0].matches, true);
});

for (const flow of ["reset", "change"] as const) {
  test(`${flow}: delayed finish after production recovery succeeds and revokes sessions since started_at`, async () => {
    const person = await user();
    const token = randomUUID();
    await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [person.id, createHash("sha256").update(token).digest("hex")]);
    const original = Client.prototype.query;
    let fired = false;
    mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      if (!fired && sql.includes("SELECT app.b031_finish_credential_change(") && values?.[0] === person.id) {
        fired = true;
        await query(`UPDATE app.b031_credential_changes SET started_at = now() - interval '3 minutes' WHERE user_id = $1`, [person.id]);
        assert.equal((await signIn(person.email, nextPassword, false, meta)).ok, true);
      }
      return (original as QueryFn).call(this, sql, values);
    }) as typeof original);
    if (flow === "reset") assert.deepEqual(await resetPassword(token, nextPassword, nextPassword), { ok: true });
    else await changePassword(session(person, randomUUID()), password, nextPassword, nextPassword);
    assert.equal(fired, true);
    assert.equal(await captureCredentialEpoch(person.id), "3");
    assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id])).rowCount, 0);
  });
}

test("provider commits after budget: unknown stays fenced, then production login recovers and no old session survives", { timeout: 15000 }, async () => {
  const person = await user();
  assert.equal((await signIn(person.email, password, false, meta)).ok, true);
  const token = randomUUID();
  await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [person.id, createHash("sha256").update(token).digest("hex")]);
  let release!: () => void;
  const mayCommit = new Promise<void>((resolve) => { release = resolve; });
  let announce!: () => void;
  const committed = new Promise<void>((resolve) => { announce = resolve; });
  const remote = await provider(person, "success", async () => { announce(); }, async () => { await mayCommit; });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  mock.method(AbortSignal, "timeout", (ms: number) => { assert.ok(ms > 0 && ms <= 90_000); return timeout(300); });
  try {
    await assert.rejects(() => resetPassword(token, nextPassword, nextPassword), { key: "errors.generic" });
    assert.equal((await signIn(person.email, password, false, meta)).ok, false, "unknown cannot reopen old-password login");
    // Advance persisted protocol time past 90 s, but inside the 120 s recovery margin.
    await query(`UPDATE app.b031_credential_changes SET started_at = now() - interval '100 seconds' WHERE user_id = $1`, [person.id]);
    release();
    await committed;
    assert.equal((await signIn(person.email, nextPassword, false, meta)).ok, false);
    assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [person.id])).rowCount, 0);
    await query(`UPDATE app.b031_credential_changes SET started_at = now() - interval '121 seconds' WHERE user_id = $1`, [person.id]);
    assert.equal((await signIn(person.email, nextPassword, false, meta)).ok, true);
    assert.equal(await captureCredentialEpoch(person.id), "3");
    assert.equal((await signIn(person.email, password, false, meta)).ok, false);
    assert.equal((await query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL`, [person.id])).rowCount, 1);
  } finally { release(); await remote.close(); }
});

test("local provider statement timeout bounds lock waits and rolls back password mutation", async () => {
  const person = await user();
  const change = await credentialTransaction((client) => beginCredentialChange(client, person.id, "0"));
  const blocker = new Client({ connectionString: clone.url });
  await blocker.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM auth.users WHERE id = $1 FOR UPDATE`, [person.id]);
    assert.equal(await writeHardenedPassword({ ...change, startedAt: Date.now() - 89_800 }, nextPassword), "unknown");
  } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
  await credentialTransaction((client) => finishCredentialChange(client, change, "unknown"));
  assert.equal((await query(`SELECT encrypted_password = crypt($2, encrypted_password) AS matches FROM auth.users WHERE id = $1`, [person.id, password])).rows[0].matches, true);
  assert.equal((await signIn(person.email, password, false, meta)).ok, false);
});

for (const kind of ["team_member", "tenant"] as const) {
  test(`${kind}: same invite races passwordless finish against established-password acceptance`, { timeout: 15000 }, async () => {
    const person = await user();
    await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
    const token = await invitation(person, kind);
    let finished!: () => void;
    const finishLocked = new Promise<void>((resolve) => { finished = resolve; });
    let competing!: () => void;
    const competitorAtFence = new Promise<void>((resolve) => { competing = resolve; });
    const original = Client.prototype.query;
    const phase2Clients = new Set<Client>();
    mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      if (sql.includes("SELECT app.b031_lock_credential_epoch(") && values?.[0] === person.id && phase2Clients.size) {
        assert.equal(phase2Clients.has(this), false, "acceptance uses a different connection from committed finish");
        competing();
      }
      const result = await (original as QueryFn).call(this, sql, values);
      if (sql.includes("SELECT app.b031_finish_credential_change(") && values?.[0] === person.id) {
        phase2Clients.add(this);
        finished();
        await competitorAtFence;
      }
      return result;
    }) as typeof original);
    const first = acceptInvite(token, "Fixture", password, password, meta, "", "", true);
    await finishLocked;
    const second = acceptInvite(token, "Fixture", password, password, meta, "", "", true);
    const results = await Promise.all([first, second]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal((await counts(person.id)).sessions, 1);
    assert.equal(await captureCredentialEpoch(person.id), "2");
  });
}

test("local provider cannot commit after an application pause exhausts its absolute budget", async () => {
  const person = await user();
  const change = await credentialTransaction((client) => beginCredentialChange(client, person.id, "0"));
  const original = Client.prototype.query;
  let paused = false;
  mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
    if (sql.startsWith("DO $b031$ BEGIN")) {
      paused = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return (original as QueryFn).call(this, sql, values);
  }) as typeof original);
  assert.equal(await writeHardenedPassword({ ...change, startedAt: Date.now() - 89_800 }, nextPassword), "unknown");
  assert.equal(paused, true);
  assert.equal((await query(`SELECT encrypted_password = crypt($2, encrypted_password) AS matches FROM auth.users WHERE id = $1`, [person.id, password])).rows[0].matches, true);
});

for (const kind of ["team_member", "tenant"] as const) {
  test(`${kind}: acceptance automatically recovers a provider success whose finish never ran`, async () => {
    const person = await user();
    await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
    const token = await invitation(person, kind);
    const change = await credentialTransaction((client) => beginCredentialChange(client, person.id, "0"));
    assert.equal(await writeHardenedPassword(change, nextPassword), "done");
    // Simulate elapsed time following a process loss after the provider commit.
    await query(`UPDATE app.b031_credential_changes SET started_at = now() - interval '121 seconds' WHERE id = $1`, [change.id]);
    assert.equal((await acceptInvite(token, "Fixture", nextPassword, nextPassword, meta, "", "", true)).ok, true);
    assert.equal(await captureCredentialEpoch(person.id), "2");
    assert.equal((await counts(person.id)).sessions, 1);
    const state = (await query(`SELECT state, finished_at FROM app.b031_credential_changes WHERE id = $1`, [change.id])).rows[0];
    assert.equal(state.state, "unknown");
    assert.ok(state.finished_at);
  });
}

// Captured by running these same fixtures against unmodified auth.ts/signup.ts at
// fc94d83361e9ee7844a1679fbb2c6b2e7c8f5f85. Exact SQL, including whitespace and
// transaction/session configuration statements; no filtering by table name.
const offFlows = ["signin", "signin-2fa", "signin-enroll", "complete-mfa", "begin-mfa", "confirm-mfa",
  "signup", "signup-new", "reset", "change", "team_member", "team_member-passwordless", "team_member-new",
  "tenant", "tenant-passwordless", "tenant-new"] as const;
for (const flow of offFlows) {
  test(`OFF complete SQL trace matches pre-B031 baseline: ${flow}`, async () => {
    await query(`UPDATE platform_settings SET value = '{"enabled":false}' WHERE key = 'session_hardening'`);
    const person = await user(flow.startsWith("signin") || flow === "complete-mfa");
    const current = session(person, randomUUID());
    let run: () => Promise<unknown>;
    if (flow.startsWith("signin")) {
      if (flow === "signin-2fa") await factor(person.id, "2fa");
      if (flow === "signin-enroll") await factor(person.id, "enroll");
      run = () => signIn(person.email, password, false, meta);
    } else if (flow === "complete-mfa") {
      await factor(person.id, "enroll");
      const opened = await signIn(person.email, password, false, meta);
      assert.ok(!opened.ok && "step" in opened);
      run = () => completeSecondFactor(opened.challengeId, totpCode(opened.secret!), meta);
    } else if (flow === "begin-mfa") {
      run = () => beginMfa(current);
    } else if (flow === "confirm-mfa") {
      const opened = await beginMfa(current);
      run = () => confirmMfa(current, opened.challengeId, totpCode(opened.secret));
    } else if (flow.startsWith("signup")) {
      const email = flow === "signup-new" ? `new-${randomUUID()}@example.test` : person.email;
      run = () => startSignup({ email, password, confirm: password, partnerCode: "", origin: "http://127.0.0.1:3000", meta, consent: true });
    } else if (flow === "reset") {
      const token = randomUUID();
      await query(`INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [person.id, createHash("sha256").update(token).digest("hex")]);
      run = () => resetPassword(token, nextPassword, nextPassword);
    } else if (flow === "change") {
      run = () => changePassword(current, password, nextPassword, nextPassword);
    } else {
      if (flow.endsWith("-passwordless")) await query(`UPDATE auth.users SET encrypted_password = NULL WHERE id = $1`, [person.id]);
      const invited = flow.endsWith("-new") ? { id: null, email: `new-${randomUUID()}@example.test` } : person;
      const token = await invitation(invited, flow.startsWith("team_member") ? "team_member" : "tenant");
      run = () => acceptInvite(token, "Fixture", password, password, meta, "", "", true);
    }
    const statements: string[] = [];
    const original = Client.prototype.query;
    const trace = mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      assert.equal(typeof sql, "string", "trace must capture every statement");
      statements.push(sql);
      return (original as QueryFn).call(this, sql, values);
    }) as typeof original);
    let result: unknown;
    try { result = await run(); } finally { trace.mock.restore(); }
    if (flow !== "change") assert.ok(result);
    if (result && typeof result === "object" && "ok" in result) {
      const expectedStep = flow === "signin-2fa" || flow === "signin-enroll";
      assert.equal((result as { ok: boolean }).ok, !expectedStep, `fixture succeeded: ${flow}`);
    }
    const flagRead = "SELECT app.b031_session_hardening_enabled() AS enabled";
    assert.equal(statements.filter((sql) => sql === flagRead).length, 1, "exactly one extra flag read");
    const index = statements.indexOf(flagRead);
    statements.splice(index, 1);
    const baseline = JSON.parse(readFileSync(new URL("./fixtures/b031-off-sql.json", import.meta.url), "utf8")) as Record<string, string[]>;
    assert.deepEqual(statements, baseline[flow]);
    for (const table of ["b031_credential_epochs", "b031_challenge_epochs"]) {
      assert.equal((await query(`SELECT 1 FROM app.${table} WHERE user_id = $1`, [person.id])).rowCount, 0);
    }
  });
}
