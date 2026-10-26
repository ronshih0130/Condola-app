import assert from "node:assert/strict";
import test from "node:test";
import { LOCKOUT_LIMIT, LOCKOUT_MS, lockActive, nextFailure } from "./lockout";

test("the fifth failure locks the email for 15 minutes", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  let count = 0;
  for (let attempt = 1; attempt < LOCKOUT_LIMIT; attempt += 1) {
    const next = nextFailure(count, now);
    assert.equal(next.locked, false);
    count = next.failedCount;
  }
  const locked = nextFailure(count, now);
  assert.equal(locked.failedCount, 5);
  assert.equal(locked.locked, true);
  assert.equal(locked.lockedUntil?.getTime(), now.getTime() + LOCKOUT_MS);
  assert.equal(lockActive(locked.lockedUntil, new Date(now.getTime() + LOCKOUT_MS - 1)), true);
  assert.equal(lockActive(locked.lockedUntil, new Date(now.getTime() + LOCKOUT_MS + 1)), false);
});
