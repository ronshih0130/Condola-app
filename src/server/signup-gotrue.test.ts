import assert from "node:assert/strict";
import test from "node:test";
import { confirmHashTarget, gotrueEndpoint, parseSupabaseSignup, signupConfirmUrl } from "./signup-gotrue";

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
    assert.equal(signupConfirmUrl("https://condola-staging.workers.dev"), "https://staging.condola.app/signup/confirm");
    delete process.env.CONDOLA_SITE_URL;
    assert.equal(signupConfirmUrl("https://condola-staging.workers.dev"), "https://staging.condola.app/signup/confirm");

    process.env.CONDOLA_ENV = "production";
    assert.equal(signupConfirmUrl("https://app.condola.app"), "https://app.condola.app/signup/confirm");
    assert.equal(signupConfirmUrl("https://condola.app/login"), "https://app.condola.app/signup/confirm");
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
