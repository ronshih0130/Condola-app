import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { describeRecoveryHash, normalizeEmail, recoverySentAtStatus, requestPasswordReset } from "./auth";
import { CLOUDFLARE_FROM, SERVICE_EMAIL, useEmailBinding } from "./mail";
import { signupConsentMetadata } from "./legal-versions";
import { createSignupLink, deliverSignupMail } from "./signup-mail";
import {
  classifyPasswordGrant,
  classifySignupGenerateLink,
  confirmHashTarget,
  gotrueEndpoint,
  gotrueVerifyBody,
  parseGenerateLink,
  parseSupabaseSignup,
  passwordResetUrl,
  signupConfirmLink,
  signupConfirmUrl,
  signupMailVia,
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
  const localReset = readFileSync(new URL("../app/reset/[token]/page.tsx", import.meta.url), "utf8");
  assert.match(reset, /describeRecoveryHash/);
  assert.match(reset, /actionReset/);
  assert.match(reset, /name="type" value="recovery"/);
  assert.match(reset, /name="token_hash"/);
  assert.match(reset, /i_reset_expired/);
  assert.match(reset, /i_reset_resend/);
  assert.match(reset, /href="\/forgot"/);
  assert.doesNotMatch(reset, /verifyRecoveryTokenHash\(/);
  assert.doesNotMatch(reset, /actionVerifyRecovery/);
  assert.match(localReset, /describeReset/);
  assert.match(localReset, /i_reset_resend/);
  assert.doesNotMatch(localReset, /verifyRecoveryTokenHash\(/);
  const formAt = reset.indexOf("PasswordFields");
  const expiredAt = reset.indexOf("i_reset_expired");
  assert.ok(formAt > 0 && expiredAt > formAt);
  assert.equal(reset.slice(expiredAt).includes("PasswordFields"), false);
});

test("a recovery link is ready only inside the 60-minute window and a page load does not verify it", async () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.equal(recoverySentAtStatus(new Date("2026-10-21T11:00:01Z"), now), "ready");
  assert.equal(recoverySentAtStatus(new Date("2026-10-21T11:00:00Z"), now), "expired");
  assert.equal(recoverySentAtStatus(null, now), "expired");
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal(await describeRecoveryHash("hashed-token", "recovery", now), "expired");
    assert.equal(await describeRecoveryHash("hashed-token", "signup", now), "expired");
    assert.equal(await describeRecoveryHash("", "recovery", now), "expired");
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
  const auth = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  const start = auth.indexOf("export async function describeRecoveryHash");
  const end = auth.indexOf("const TEAM_ROLES", start);
  const fn = auth.slice(start, end);
  assert.match(fn, /SELECT recovery_sent_at/);
  assert.match(fn, /recovery_token/);
  assert.doesNotMatch(fn, /\/auth\/v1\/verify/);
  assert.doesNotMatch(fn, /verifyRecoveryTokenHash/);
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

test("signup generate_link maps email_exists, weak passwords, and a hashed token", () => {
  assert.deepEqual(
    classifySignupGenerateLink(422, {
      error_code: "email_exists",
      msg: "A user with this email address has already been registered",
    }),
    { ok: false, error: "duplicate" },
  );
  assert.deepEqual(
    classifySignupGenerateLink(422, { error_code: "weak_password", msg: "Password should be at least 6 characters." }),
    { ok: false, error: "weak" },
  );
  assert.deepEqual(
    classifySignupGenerateLink(400, { error_code: "validation_failed", msg: "Signup requires a valid password" }),
    { ok: false, error: "weak" },
  );
  assert.deepEqual(classifySignupGenerateLink(500, { msg: "database unavailable" }), { ok: false, error: "unavailable" });
  assert.deepEqual(classifySignupGenerateLink(200, { hashed_token: "hash" }), { ok: false, error: "unavailable" });
  assert.deepEqual(classifySignupGenerateLink(200, { id: "user-1", hashed_token: " hash ", email_confirmed_at: null }), {
    ok: true,
    hashedToken: "hash",
    userId: "user-1",
    confirmed: false,
  });
  assert.deepEqual(
    classifySignupGenerateLink(200, {
      hashed_token: "abc",
      user: { id: "user-2", email_confirmed_at: "2026-10-25T00:00:00Z" },
    }),
    { ok: true, hashedToken: "abc", userId: "user-2", confirmed: true },
  );
});

test("signup confirm links keep token_hash and type on the allow-listed origin", () => {
  const previousEnv = process.env.CONDOLA_ENV;
  const previousSite = process.env.CONDOLA_SITE_URL;
  try {
    process.env.CONDOLA_ENV = "production";
    process.env.CONDOLA_SITE_URL = "https://app.condola.app";
    assert.equal(
      signupConfirmLink("https://app.condola.app", "X"),
      "https://app.condola.app/signup/confirm?token_hash=X&type=signup",
    );
    process.env.CONDOLA_ENV = "staging";
    process.env.CONDOLA_SITE_URL = "https://staging.condola.app";
    assert.equal(
      signupConfirmLink("https://condola-staging.workers.dev", "X"),
      "https://staging.condola.app/signup/confirm?token_hash=X&type=signup",
    );
  } finally {
    if (previousEnv === undefined) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = previousEnv;
    if (previousSite === undefined) delete process.env.CONDOLA_SITE_URL;
    else process.env.CONDOLA_SITE_URL = previousSite;
  }
});

test("signup mail defaults to the app and supabase is the kill switch", () => {
  assert.equal(signupMailVia({}), "app");
  assert.equal(signupMailVia({ SIGNUP_MAIL_VIA: "app" }), "app");
  assert.equal(signupMailVia({ SIGNUP_MAIL_VIA: " Supabase " }), "supabase");
});

test("generate_link keeps the hashed token and ignores a body without one", () => {
  assert.deepEqual(parseGenerateLink({ id: "user-1", hashed_token: " hash " }), { hashedToken: "hash", userId: "user-1" });
  assert.deepEqual(parseGenerateLink({ user: { id: "user-2" }, hashed_token: "abc" }), { hashedToken: "abc", userId: "user-2" });
  assert.equal(parseGenerateLink({ id: "user-1" }), null);
});

test("password reset asks GoTrue for a link and sends it through the mail module", async () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anon: process.env.SUPABASE_ANON_KEY,
    provider: process.env.MAIL_PROVIDER,
    resend: process.env.RESEND_API_KEY,
    database: process.env.DATABASE_URL,
    fetch: global.fetch,
  };
  const calls: { url: string; method: string; body: string; authorization: string }[] = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.DATABASE_URL;
  process.env.MAIL_PROVIDER = "resend";
  process.env.RESEND_API_KEY = "re_test";
  useEmailBinding(undefined);
  global.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: String(init?.method),
      body: String(init?.body ?? ""),
      authorization: headers.get("authorization") || "",
    });
    if (String(input).includes("generate_link")) {
      const email = JSON.parse(String(init?.body)).email as string;
      if (email === "missing@example.com") return new Response("{}", { status: 404 });
      return Response.json({ id: "user-1", hashed_token: "hashed-token" });
    }
    return Response.json({ id: "msg_1" });
  };
  try {
    const known = await requestPasswordReset("  User+Tag@Example.com ", "https://staging.condola.app");
    const missing = await requestPasswordReset("missing@example.com", "https://app.condola.app/login");
    const blank = await requestPasswordReset("not an email", "https://staging.condola.app");
    assert.equal(known.token, null);
    assert.equal(missing.token, null);
    assert.equal(blank.token, null);
    assert.equal(calls.length, 3);
    const first = new URL(calls[0].url);
    assert.equal(first.origin, "https://example.supabase.co");
    assert.equal(first.pathname, "/auth/v1/admin/generate_link");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].authorization, "Bearer service-test");
    assert.deepEqual(JSON.parse(calls[0].body), {
      type: "recovery",
      email: "user+tag@example.com",
      options: { redirect_to: "https://staging.condola.app/reset" },
    });
    assert.equal(calls[1].url, "https://api.resend.com/emails");
    const mailed = JSON.parse(calls[1].body) as { from: string; to: string[]; subject: string; text: string };
    assert.equal(mailed.from, "\"租多啦 Condola\" <noreply@send.condola.app>");
    assert.deepEqual(mailed.to, ["user+tag@example.com"]);
    assert.equal(mailed.subject, "重設您的租多啦密碼");
    assert.match(mailed.text, /https:\/\/staging\.condola\.app\/reset\?token_hash=hashed-token&type=recovery/);
    assert.equal(mailed.text.includes("收款"), false);
    assert.equal(calls[2].url.includes("/auth/v1/recover"), false);
    assert.equal(calls.some((call) => call.url.includes("/auth/v1/recover")), false);
  } finally {
    global.fetch = saved.fetch;
    useEmailBinding(undefined);
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.service;
    if (saved.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.anon;
    if (saved.provider === undefined) delete process.env.MAIL_PROVIDER;
    else process.env.MAIL_PROVIDER = saved.provider;
    if (saved.resend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.resend;
    if (saved.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.database;
  }
});

test("signup confirmation asks GoTrue for a link and sends it through the Cloudflare binding", async () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    provider: process.env.MAIL_PROVIDER,
    site: process.env.CONDOLA_SITE_URL,
    env: process.env.CONDOLA_ENV,
    fetch: global.fetch,
  };
  const calls: { url: string; authorization: string; apikey: string; body: string }[] = [];
  const sent: { from: unknown; to: string; subject: string; text: string; replyTo?: string }[] = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
  process.env.MAIL_PROVIDER = "cloudflare";
  process.env.CONDOLA_ENV = "production";
  process.env.CONDOLA_SITE_URL = "https://app.condola.app";
  useEmailBinding({
    async send(message) {
      sent.push({ from: message.from, to: message.to, subject: message.subject, text: message.text || "", replyTo: message.replyTo });
      return { messageId: "msg-signup" };
    },
  });
  global.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization") || "",
      apikey: headers.get("apikey") || "",
      body: String(init?.body ?? ""),
    });
    const payload = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
    if (payload.email === "confirmed@example.com") {
      return Response.json(
        { error_code: "email_exists", msg: "A user with this email address has already been registered" },
        { status: 422 },
      );
    }
    if (payload.password === "short") {
      return Response.json({ error_code: "weak_password", msg: "Password should be at least 6 characters." }, { status: 422 });
    }
    return Response.json({ id: "user-1", hashed_token: "hashed-signup", email_confirmed_at: null });
  };
  try {
    const metadata = signupConsentMetadata(new Date("2026-10-25T07:00:00.000Z"));
    const created = await createSignupLink({
      email: "owner@example.com",
      password: "Fresh1234",
      data: metadata,
      origin: "https://app.condola.app",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const delivered = await deliverSignupMail("owner@example.com", created.hashedToken, "https://app.condola.app");
    assert.equal(delivered, true);
    const duplicate = await createSignupLink({ email: "confirmed@example.com", password: "Fresh1234", origin: "https://app.condola.app" });
    const weak = await createSignupLink({ email: "new@example.com", password: "short", origin: "https://app.condola.app" });
    const rotated = await createSignupLink({ email: "owner@example.com", origin: "https://staging.condola.app" });
    assert.deepEqual(duplicate, { ok: false, error: "duplicate" });
    assert.deepEqual(weak, { ok: false, error: "weak" });
    assert.equal(rotated.ok, true);
    assert.equal(calls.length, 4);
    assert.equal(new URL(calls[0].url).pathname, "/auth/v1/admin/generate_link");
    assert.equal(calls[0].authorization, "Bearer service-test");
    assert.equal(calls[0].apikey, "service-test");
    assert.deepEqual(JSON.parse(calls[0].body), {
      type: "signup",
      email: "owner@example.com",
      redirect_to: "https://app.condola.app/signup/confirm",
      password: "Fresh1234",
      data: metadata,
    });
    assert.equal(JSON.parse(calls[3].body).password, undefined);
    assert.equal(JSON.parse(calls[3].body).data, undefined);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].from, CLOUDFLARE_FROM);
    assert.equal(sent[0].to, "owner@example.com");
    assert.equal(sent[0].replyTo, SERVICE_EMAIL);
    assert.equal(sent[0].subject, "請確認您的租多啦 Condola 帳號");
    assert.match(sent[0].text, /https:\/\/app\.condola\.app\/signup\/confirm\?token_hash=hashed-signup&type=signup/);
  } finally {
    global.fetch = saved.fetch;
    useEmailBinding(undefined);
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.service;
    if (saved.provider === undefined) delete process.env.MAIL_PROVIDER;
    else process.env.MAIL_PROVIDER = saved.provider;
    if (saved.site === undefined) delete process.env.CONDOLA_SITE_URL;
    else process.env.CONDOLA_SITE_URL = saved.site;
    if (saved.env === undefined) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = saved.env;
  }
});
