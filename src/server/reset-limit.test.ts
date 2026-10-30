import assert from "node:assert/strict";
import test from "node:test";
import {
  PASSWORD_RESET_EMAIL_LIMIT,
  PASSWORD_RESET_IP_LIMIT,
  SIGNUP_MAIL_GLOBAL_LIMIT,
  SIGNUP_MAIL_HOUR_LIMIT,
  consumeMailAttempt,
  consumePasswordReset,
  signupSendBlock,
  underResetLimit,
} from "./reset-limit";

test("reset limits count email and IP separately", () => {
  assert.equal(underResetLimit(0, 0, "1.1.1.1"), true);
  assert.equal(underResetLimit(PASSWORD_RESET_EMAIL_LIMIT, 0, ""), false);
  assert.equal(underResetLimit(0, 20, "1.1.1.1"), false);
  assert.equal(underResetLimit(0, 20, ""), true);
});

test("in-memory reset limit blocks the sixth email within the hour", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const email = `limit-${Date.now()}@example.com`;
  try {
    for (let n = 0; n < PASSWORD_RESET_EMAIL_LIMIT; n += 1) {
      assert.equal(await consumePasswordReset(email, "203.0.113.5"), true);
    }
    assert.equal(await consumePasswordReset(email, "203.0.113.9"), false);
    assert.equal(await consumePasswordReset(`other-${email}`, "203.0.113.5"), true);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test("signup send block is 60 seconds, 5 an hour, then the global brake", () => {
  assert.equal(signupSendBlock({ recent: 0, hour: 0, global: 0 }), "ok");
  assert.equal(signupSendBlock({ recent: 1, hour: 1, global: 0 }), "wait");
  assert.equal(signupSendBlock({ recent: 0, hour: SIGNUP_MAIL_HOUR_LIMIT - 1, global: 0 }), "ok");
  assert.equal(signupSendBlock({ recent: 0, hour: SIGNUP_MAIL_HOUR_LIMIT, global: 0 }), "wait");
  assert.equal(signupSendBlock({ recent: 0, hour: 0, global: SIGNUP_MAIL_GLOBAL_LIMIT }), "ok");
  assert.equal(signupSendBlock({ recent: 0, hour: 0, global: SIGNUP_MAIL_GLOBAL_LIMIT + 1 }), "capped");
});

test("signup mail shares the IP budget and keeps its own email key", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const email = `signup-limit-${Date.now()}@example.com`;
  const ip = "198.51.100.40";
  try {
    for (let n = 0; n < PASSWORD_RESET_IP_LIMIT; n += 1) {
      assert.equal(await consumeMailAttempt("signup", `${n}-${email}`, ip), true);
    }
    assert.equal(await consumeMailAttempt("signup", `over-${email}`, ip), false);
    assert.equal(await consumePasswordReset(email, ip), false);
    assert.equal(await consumePasswordReset(email, "198.51.100.41"), true);
    for (let n = 0; n < PASSWORD_RESET_EMAIL_LIMIT; n += 1) {
      assert.equal(await consumeMailAttempt("signup", email, `198.51.100.${50 + n}`), true);
    }
    assert.equal(await consumeMailAttempt("signup", email, "198.51.100.90"), false);
    assert.equal(await consumePasswordReset(email, "198.51.100.91"), true);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});
