import assert from "node:assert/strict";
import test from "node:test";
import { callSubmitAction, claimFormSubmit, ensureIdempotencyKey, releaseFormSubmit } from "./submit-once";

test("a second submit in the same turn is refused until the guard is released", () => {
  const guard = { current: false };
  assert.equal(claimFormSubmit(guard), true);
  assert.equal(claimFormSubmit(guard), false);
  assert.equal(guard.current, true);
  releaseFormSubmit(guard);
  assert.equal(claimFormSubmit(guard), true);
});

test("a thrown server action releases the submit guard from finally", async () => {
  const guard = { current: false };
  assert.equal(claimFormSubmit(guard), true);
  await assert.rejects(
    () =>
      callSubmitAction(guard, async () => {
        throw new Error("redirect or action failure");
      }),
    /redirect or action failure/,
  );
  assert.equal(guard.current, false);
  assert.equal(claimFormSubmit(guard), true);
});

test("a resolved server action keeps the submit guard claimed", async () => {
  const guard = { current: false };
  assert.equal(claimFormSubmit(guard), true);
  const value = await callSubmitAction(guard, async () => "saved");
  assert.equal(value, "saved");
  assert.equal(guard.current, true);
  assert.equal(claimFormSubmit(guard), false);
});

test("the idempotency key is created once per wizard attempt", () => {
  const holder = { current: "" };
  const first = ensureIdempotencyKey(holder);
  const second = ensureIdempotencyKey(holder);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const another = ensureIdempotencyKey({ current: "" });
  assert.notEqual(another, first);
});
