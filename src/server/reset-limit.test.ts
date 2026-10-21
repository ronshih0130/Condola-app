import assert from "node:assert/strict";
import test from "node:test";
import { PASSWORD_RESET_EMAIL_LIMIT, consumePasswordReset, underResetLimit } from "./reset-limit";

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
