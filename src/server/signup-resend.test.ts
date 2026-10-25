import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resendCooldownLeft, SIGNUP_RESEND_COOLDOWN_SEC, signupResendLocation } from "./signup";

test("signup resend waits 60 seconds and reports success, cooldown, and error", () => {
  assert.equal(SIGNUP_RESEND_COOLDOWN_SEC, 60);
  assert.equal(resendCooldownLeft(null), 0);
  assert.equal(resendCooldownLeft(0), 60);
  assert.equal(resendCooldownLeft(1), 59);
  assert.equal(resendCooldownLeft(59), 1);
  assert.equal(resendCooldownLeft(60), 0);
  assert.equal(resendCooldownLeft(90), 0);
  assert.equal(resendCooldownLeft(-1), 60);

  const email = "owner@example.com";
  const sent = signupResendLocation(email, "", { status: "sent", devToken: "dev-token", wait: 60 });
  assert.equal(sent, "/signup/verify?email=owner%40example.com&resent=1&dev=dev-token&wait=60");
  const loginBack = signupResendLocation(email, "login", { status: "sent", devToken: null, wait: 60 });
  assert.equal(loginBack, "/login?email=owner%40example.com&resent=1&wait=60&error=unconfirmed");
  const cooling = signupResendLocation(email, "login", { status: "cooldown", devToken: null, wait: 42 });
  assert.equal(cooling, "/login?email=owner%40example.com&resent=wait&wait=42&error=unconfirmed");
  const failed = signupResendLocation(email, "verify", { status: "error", devToken: null, wait: 0 });
  assert.equal(failed, "/signup/verify?email=owner%40example.com&resent=error");

  const source = readFileSync(new URL("./signup.ts", import.meta.url), "utf8");
  const resend = source.slice(source.indexOf("async function supabaseResend"), source.indexOf("async function markConfirmed"));
  assert.match(resend, /\/auth\/v1\/resend/);
  assert.match(resend, /type:\s*"signup"/);
  assert.match(source, /signup_verifications/);
  assert.doesNotMatch(source, /ALTER TABLE/);

  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_signup_resend, "重寄驗證信");
  assert.equal(zh.i_signup_resend_wait, "{n} 秒後可重寄驗證信");
  assert.match(zh.i_signup_resent, /驗證信已重寄/);
  assert.match(zh.i_signup_resend_error, /無法寄出/);
  assert.match(zh.i_signup_resend_cooldown, /稍候/);
  assert.equal(zh.i_signup_software_only, "只提供管理軟體，不經手任何款項。");
  assert.match(zh.i_signup_audience, /屋主/);
  assert.match(zh.i_signup_free_seat, /前 4 戶/);
  assert.match(zh.i_signup_free_seat, /1 個席次/);
  assert.match(zh.i_signup_invited_owner, /邀請/);

  const verify = readFileSync(new URL("../app/signup/verify/page.tsx", import.meta.url), "utf8");
  const loginPage = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(verify, /SignupResendForm/);
  assert.match(verify, /testId="signup-resend"/);
  assert.match(verify, /i_signup_resend_error/);
  assert.match(verify, /i_signup_resent/);
  assert.match(loginPage, /error === "unconfirmed"/);
  assert.match(loginPage, /back="login"/);
  assert.match(loginPage, /testId="login-resend"/);
  assert.match(loginPage, /data-testid="login-unconfirmed"/);
});
