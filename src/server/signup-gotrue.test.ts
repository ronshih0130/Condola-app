import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { normalizeEmail, requestPasswordReset } from "./auth";
import {
  classifyPasswordGrant,
  confirmHashTarget,
  gotrueEndpoint,
  gotrueVerifyBody,
  parseSupabaseSignup,
  passwordResetUrl,
  signupConfirmUrl,
  signupVerifyType,
} from "./signup-gotrue";

test("GoTrue signup accepts a top-level id and a nested user id", () => {
  const top = parseSupabaseSignup(200, { id: "user-top", aud: "authenticated", email_confirmed_at: null });
  assert.equal(top !== "duplicate" && top !== "unavailable" && top.id, "user-top");
  if (top === "duplicate" || top === "unavailable") throw new Error("expected a user");
  assert.equal(top.confirmed, false);

  const nested = parseSupabaseSignup(200, { user: { id: "user-nested", email_confirmed_at: "2026-10-20T00:00:00Z" } });
  if (nested === "duplicate" || nested === "unavailable") throw new Error("expected a user");
  assert.equal(nested.id, "user-nested");
  assert.equal(nested.confirmed, true);

  assert.equal(parseSupabaseSignup(200, { user: {} }), "unavailable");
  assert.equal(parseSupabaseSignup(422, { msg: "User already registered", error_code: "user_already_exists" }), "duplicate");
  assert.equal(parseSupabaseSignup(500, { message: "unavailable" }), "unavailable");
});

test("GoTrue signup and resend put redirect_to on the query string", () => {
  const redirectTo = "https://staging.condola.app/signup/confirm";
  const signup = new URL(gotrueEndpoint("https://example.supabase.co", "/auth/v1/signup", redirectTo));
  assert.equal(signup.origin, "https://example.supabase.co");
  assert.equal(signup.pathname, "/auth/v1/signup");
  assert.equal(signup.searchParams.get("redirect_to"), redirectTo);
  const resend = new URL(gotrueEndpoint("https://example.supabase.co/", "/auth/v1/resend", redirectTo));
  assert.equal(resend.pathname, "/auth/v1/resend");
  assert.equal(resend.searchParams.get("redirect_to"), redirectTo);
});

test("confirmation links use the allow-listed staging or production origin", () => {
  const previousEnv = process.env.CONDOLA_ENV;
  const previousSite = process.env.CONDOLA_SITE_URL;
  try {
    process.env.CONDOLA_ENV = "staging";
    process.env.CONDOLA_SITE_URL = "https://staging.condola.app";
    assert.equal(signupConfirmUrl("https://staging.condola.app"), "https://staging.condola.app/signup/confirm");
    assert.equal(passwordResetUrl("https://staging.condola.app"), "https://staging.condola.app/reset");
    assert.equal(signupConfirmUrl("https://condola-staging.workers.dev"), "https://staging.condola.app/signup/confirm");
    assert.equal(passwordResetUrl("https://condola-staging.workers.dev"), "https://staging.condola.app/reset");
    delete process.env.CONDOLA_SITE_URL;
    assert.equal(signupConfirmUrl("https://condola-staging.workers.dev"), "https://staging.condola.app/signup/confirm");

    process.env.CONDOLA_ENV = "production";
    process.env.CONDOLA_SITE_URL = "https://app.condola.app";
    assert.equal(signupConfirmUrl("https://app.condola.app"), "https://app.condola.app/signup/confirm");
    assert.equal(passwordResetUrl("https://app.condola.app"), "https://app.condola.app/reset");
    assert.equal(signupConfirmUrl("https://condola.app/login"), "https://app.condola.app/signup/confirm");
    assert.equal(passwordResetUrl("https://condola.app/login"), "https://app.condola.app/reset");
    assert.equal(signupConfirmUrl("https://condola-prod.workers.dev"), "https://app.condola.app/signup/confirm");
    assert.equal(signupConfirmUrl("https://evil.example"), "https://app.condola.app/signup/confirm");
    process.env.CONDOLA_SITE_URL = "https://staging.condola.app";
    assert.equal(signupConfirmUrl("https://condola.app/login"), "https://staging.condola.app/signup/confirm");
    delete process.env.CONDOLA_SITE_URL;
    assert.equal(signupConfirmUrl("https://evil.example"), "https://app.condola.app/signup/confirm");

    process.env.CONDOLA_ENV = "development";
    process.env.CONDOLA_SITE_URL = "https://staging.condola.app/";
    assert.equal(signupConfirmUrl("http://127.0.0.1:43123"), "https://staging.condola.app/signup/confirm");
    delete process.env.CONDOLA_SITE_URL;
    assert.equal(signupConfirmUrl("http://127.0.0.1:43123"), "http://127.0.0.1:43123/signup/confirm");
  } finally {
    if (previousEnv === undefined) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = previousEnv;
    if (previousSite === undefined) delete process.env.CONDOLA_SITE_URL;
    else process.env.CONDOLA_SITE_URL = previousSite;
  }
});

test("a plus address survives trim, case, and form-urlencoded spaces", () => {
  assert.equal(normalizeEmail("  User+Tag@Example.com "), "user+tag@example.com");
  assert.equal(normalizeEmail("user tag@example.com"), "user+tag@example.com");
  assert.equal(normalizeEmail("user  tag+more@example.com"), "user+tag+more@example.com");
  assert.equal(normalizeEmail("not an email"), null);
});

test("password grant maps email_not_confirmed and leaves other GoTrue errors alone", () => {
  assert.deepEqual(classifyPasswordGrant(200, { user: { id: "user-1" } }), { userId: "user-1" });
  assert.deepEqual(classifyPasswordGrant(200, { id: "user-top" }), { userId: "user-top" });
  assert.equal(classifyPasswordGrant(400, { error_code: "email_not_confirmed", msg: "Email not confirmed" }), "unconfirmed");
  assert.equal(classifyPasswordGrant(400, { error: "invalid_grant", error_description: "Invalid login credentials" }), "invalid");
  assert.equal(classifyPasswordGrant(429, { error_code: "over_request_rate_limit", msg: "Too many requests" }), "unavailable");
  assert.equal(classifyPasswordGrant(500, { message: "database unavailable" }), "unavailable");
  assert.equal(classifyPasswordGrant(200, {}), "unavailable");
});

test("confirmation verify is a POST body and GET pages do not call it", () => {
  assert.deepEqual(gotrueVerifyBody("signup", " hash "), { type: "signup", token_hash: "hash" });
  assert.deepEqual(gotrueVerifyBody("email", "hash"), { type: "email", token_hash: "hash" });
  assert.deepEqual(gotrueVerifyBody("recovery", "hash"), { type: "recovery", token_hash: "hash" });
  assert.equal(signupVerifyType("signup"), "signup");
  assert.equal(signupVerifyType("email"), "email");
  assert.equal(signupVerifyType(""), "signup");
  assert.equal(signupVerifyType("recovery"), null);

  const confirm = readFileSync(new URL("../app/signup/confirm/page.tsx", import.meta.url), "utf8");
  assert.match(confirm, /actionConfirmSupabaseHash/);
  assert.match(confirm, /i_signup_confirm_email/);
  assert.doesNotMatch(confirm, /<(ConfirmSupabaseHash|ConfirmToken)\b/);
  assert.doesNotMatch(confirm, /useEffect/);
  const verify = readFileSync(new URL("../app/signup/verify/page.tsx", import.meta.url), "utf8");
  assert.match(verify, /n:\s*2/);
  assert.match(verify, /name="nextEmail"[\s\S]*name="password"/);
  const reset = readFileSync(new URL("../app/reset/page.tsx", import.meta.url), "utf8");
  assert.match(reset, /actionVerifyRecovery/);
  assert.match(reset, /type=recovery|name="type" value="recovery"/);
  assert.doesNotMatch(reset, /verifyRecoveryTokenHash\(/);
});

test("a hash access_token is forwarded to /signup/confirm and not looped", () => {
  assert.equal(
    confirmHashTarget("/", "#access_token=abc&type=signup"),
    "/signup/confirm#access_token=abc&type=signup",
  );
  assert.equal(confirmHashTarget("/login", "access_token=abc"), "/signup/confirm#access_token=abc");
  assert.equal(confirmHashTarget("/signup/confirm", "#access_token=abc"), null);
  assert.equal(confirmHashTarget("/login", "#error=access_denied"), null);
  assert.equal(confirmHashTarget("/m", ""), null);
});

test("password reset asks GoTrue to send the recovery email and stays generic", async () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    publicUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publicAnon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    fetch: global.fetch,
  };
  const calls: { url: string; method: string; body: string }[] = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-test";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  global.fetch = async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method), body: String(init?.body ?? "") });
    return new Response("{}", { status: calls.length === 1 ? 200 : 500 });
  };
  try {
    const known = await requestPasswordReset("  User+Tag@Example.com ", "https://staging.condola.app");
    const missing = await requestPasswordReset("missing@example.com", "https://app.condola.app/login");
    const blank = await requestPasswordReset("not an email", "https://staging.condola.app");
    assert.equal(known.token, null);
    assert.equal(missing.token, null);
    assert.equal(blank.token, null);
    assert.equal(calls.length, 2);
    const first = new URL(calls[0].url);
    assert.equal(first.origin, "https://example.supabase.co");
    assert.equal(first.pathname, "/auth/v1/recover");
    assert.equal(first.searchParams.get("redirect_to"), "https://staging.condola.app/reset");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body), { email: "user+tag@example.com" });
    assert.equal(new URL(calls[1].url).searchParams.get("redirect_to"), "https://app.condola.app/reset");
    assert.deepEqual(JSON.parse(calls[1].body), { email: "missing@example.com" });
  } finally {
    global.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.anon;
    if (saved.publicUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.publicUrl;
    if (saved.publicAnon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.publicAnon;
  }
});
