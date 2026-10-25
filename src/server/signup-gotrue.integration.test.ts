import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecoveryTokenHash } from "./auth";
import { query } from "./db";
import { PRIVACY_VERSION, TERMS_VERSION } from "./legal-versions";
import { confirmSupabaseTokenHash, startSignup } from "./signup";

const meta = { ua: "signup-gotrue", ip: "127.0.0.1" };

test("a top-level GoTrue id starts the funnel, and a retry does not send another email", { timeout: 120_000 }, async () => {
  const saved = {
    env: process.env.CONDOLA_ENV,
    site: process.env.CONDOLA_SITE_URL,
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    publicUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    fetch: global.fetch,
  };
  const email = `gotrue.${Date.now().toString(36)}@example.com`;
  const calls: { url: string; body: string }[] = [];
  const users: string[] = [];
  process.env.CONDOLA_ENV = "staging";
  process.env.CONDOLA_SITE_URL = "https://staging.condola.app";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  global.fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, body });
    if (url.includes("/auth/v1/resend")) return new Response("{}", { status: 200 });
    const payload = JSON.parse(body) as { email: string; password: string };
    const inserted = await query<{ id: string }>(
      `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, role, aud)
       VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), '{}'::jsonb, 'authenticated', 'authenticated')
       RETURNING id::text`,
      [payload.email, payload.password],
    );
    return new Response(JSON.stringify({ id: inserted.rows[0].id, aud: "authenticated", email: payload.email }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const first = await startSignup({
      email,
      password: "Fresh1234",
      confirm: "Fresh1234",
      partnerCode: "",
      origin: "https://condola-staging.workers.dev",
      meta,
      consent: true,
    });
    assert.equal(first.ok, true);
    if (!first.ok || first.status !== "verify") throw new Error("expected verify");
    assert.equal(calls.length, 1);
    const called = new URL(calls[0].url);
    assert.equal(called.pathname, "/auth/v1/signup");
    assert.equal(called.searchParams.get("redirect_to"), "https://staging.condola.app/signup/confirm");
    const sent = JSON.parse(calls[0].body) as {
      email?: string;
      data?: { terms_accepted_at?: string; terms_version?: string; privacy_version?: string };
      options?: { data?: { terms_accepted_at?: string; terms_version?: string; privacy_version?: string } };
    };
    assert.equal(sent.email, email);
    assert.match(sent.data?.terms_accepted_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(sent.data?.terms_version, TERMS_VERSION);
    assert.equal(sent.data?.privacy_version, PRIVACY_VERSION);
    assert.deepEqual(sent.options?.data, sent.data);

    const userId = (await query<{ id: string }>(`SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`, [email])).rows[0].id;
    users.push(userId);
    const profile = await query<{ email: string }>(`SELECT email::text FROM profiles WHERE id = $1`, [userId]);
    assert.equal(profile.rows[0]?.email, email);
    const started = async () => {
      const row = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM funnel_events WHERE event_type = 'signup_started' AND user_id = $1`,
        [userId],
      );
      return row.rows[0].n;
    };
    assert.equal(await started(), 1);

    await query(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS confirmation_token text`);
    await query(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz`);
    const confirmationToken = "gotrue-confirm-token-keep";
    const confirmationSentAt = "2026-10-20T03:00:00.000Z";
    await query(
      `UPDATE auth.users SET confirmation_token = $2, confirmation_sent_at = $3::timestamptz WHERE id = $1`,
      [userId, confirmationToken, confirmationSentAt],
    );
    await query(`DELETE FROM profiles WHERE id = $1`, [userId]);
    await query(`DELETE FROM funnel_events WHERE user_id = $1 AND event_type = 'signup_started'`, [userId]);
    const retry = await startSignup({
      email,
      password: "Fresh1234",
      confirm: "Fresh1234",
      partnerCode: "",
      origin: "https://staging.condola.app",
      meta,
      consent: true,
    });
    assert.equal(retry.ok, true);
    if (!retry.ok || retry.status !== "verify") throw new Error("expected retry verify");
    assert.equal(calls.length, 1, "a plain retry must not call GoTrue resend");
    const kept = await query<{ confirmation_token: string; confirmation_sent_at: Date }>(
      `SELECT confirmation_token, confirmation_sent_at FROM auth.users WHERE id = $1`,
      [userId],
    );
    assert.equal(kept.rows[0].confirmation_token, confirmationToken);
    assert.equal(kept.rows[0].confirmation_sent_at.toISOString(), confirmationSentAt);
    assert.equal((await query<{ email: string }>(`SELECT email::text FROM profiles WHERE id = $1`, [userId])).rows[0]?.email, email);
    assert.equal(await started(), 1);

    await startSignup({
      email,
      password: "Fresh1234",
      confirm: "Fresh1234",
      partnerCode: "",
      origin: "https://staging.condola.app",
      meta,
      consent: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(await started(), 1);
  } finally {
    global.fetch = saved.fetch;
    if (saved.env === undefined) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = saved.env;
    if (saved.site === undefined) delete process.env.CONDOLA_SITE_URL;
    else process.env.CONDOLA_SITE_URL = saved.site;
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.anon;
    if (saved.publicUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.publicUrl;
    if (users.length) {
      await query(`DELETE FROM funnel_events WHERE user_id = ANY($1::uuid[])`, [users]).catch(() => undefined);
      await query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]).catch(() => undefined);
    }
  }
});

test("token_hash confirmation and recovery verify only run when POSTed", async () => {
  const saved = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, fetch: global.fetch };
  const email = `confirm.plus+tag.${Date.now().toString(36)}@example.com`;
  const calls: { url: string; body: string }[] = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon";
  const inserted = await query<{ id: string }>(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, role, aud)
     VALUES (gen_random_uuid(), $1, crypt('Fresh1234', gen_salt('bf')), '{}'::jsonb, 'authenticated', 'authenticated')
     RETURNING id::text`,
    [email],
  );
  const userId = inserted.rows[0].id;
  global.fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ user: { id: userId, email } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    assert.equal(calls.length, 0);
    const confirmed = await confirmSupabaseTokenHash("signup-hash", "email", meta);
    assert.equal(confirmed.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/auth\/v1\/verify$/);
    assert.deepEqual(JSON.parse(calls[0].body), { type: "email", token_hash: "signup-hash" });
    const marked = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM funnel_events WHERE event_type = 'email_confirmed' AND user_id = $1`,
      [userId],
    );
    assert.equal(marked.rows[0].n, 1);
    const recovery = await verifyRecoveryTokenHash("recovery-hash");
    assert.equal(recovery.ok, true);
    assert.deepEqual(JSON.parse(calls[1].body), { type: "recovery", token_hash: "recovery-hash" });
    if (recovery.ok) {
      const reset = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM auth_password_resets WHERE user_id = $1 AND used_at IS NULL`,
        [userId],
      );
      assert.equal(reset.rows[0].n, 1);
    }
  } finally {
    global.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.anon;
    await query(`DELETE FROM auth_password_resets WHERE user_id = $1`, [userId]).catch(() => undefined);
    await query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]).catch(() => undefined);
    await query(`DELETE FROM funnel_events WHERE user_id = $1`, [userId]).catch(() => undefined);
    await query(`DELETE FROM auth.users WHERE id = $1`, [userId]).catch(() => undefined);
  }
});
