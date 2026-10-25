import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query } from "./db";
import { claimGotrueConfirmToken, GOTRUE_JWT_EXPIRY_SECONDS, releaseGotrueConfirmToken } from "./signup";

test("a GoTrue confirm token can be claimed once", async () => {
  const token = `confirm-${randomUUID()}`;
  try {
    assert.equal(await claimGotrueConfirmToken(token), true);
    assert.equal(await claimGotrueConfirmToken(token), false);
  } finally {
    await releaseGotrueConfirmToken(token);
  }
});

test("confirm replay rows older than twice the JWT lifetime are deleted on the next claim", async () => {
  const oldHash = `old-${randomUUID()}`;
  const freshHash = `fresh-${randomUUID()}`;
  const token = `confirm-${randomUUID()}`;
  const cutoff = GOTRUE_JWT_EXPIRY_SECONDS * 2;
  try {
    await query(
      `INSERT INTO gotrue_confirm_uses (token_hash, used_at) VALUES
         ($1, now() - make_interval(secs => $3)),
         ($2, now() - make_interval(secs => $4))`,
      [oldHash, freshHash, cutoff + 60, Math.floor(cutoff / 2)],
    );
    assert.equal(await claimGotrueConfirmToken(token), true);
    const oldRow = await query(`SELECT 1 FROM gotrue_confirm_uses WHERE token_hash = $1`, [oldHash]);
    const freshRow = await query(`SELECT 1 FROM gotrue_confirm_uses WHERE token_hash = $1`, [freshHash]);
    assert.equal(oldRow.rowCount, 0);
    assert.equal(freshRow.rowCount, 1);
  } finally {
    await query(`DELETE FROM gotrue_confirm_uses WHERE token_hash = ANY($1::text[])`, [[oldHash, freshHash]]);
    await releaseGotrueConfirmToken(token);
  }
});
