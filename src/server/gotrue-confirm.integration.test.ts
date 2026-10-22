import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { claimGotrueConfirmToken, releaseGotrueConfirmToken } from "./signup";

test("a GoTrue confirm token can be claimed once", async () => {
  const token = `confirm-${randomUUID()}`;
  try {
    assert.equal(await claimGotrueConfirmToken(token), true);
    assert.equal(await claimGotrueConfirmToken(token), false);
  } finally {
    await releaseGotrueConfirmToken(token);
  }
});
