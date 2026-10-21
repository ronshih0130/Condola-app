import assert from "node:assert/strict";
import test from "node:test";
import { callSubmitAction, claimFormSubmit, ensureIdempotencyKey, enterCommitsControl, isNextRedirect, releaseFormSubmit } from "./submit-once";

test("a second submit in the same turn is refused until the guard is released", () => {
  const guard = { current: false };
  assert.equal(claimFormSubmit(guard), true);
  assert.equal(claimFormSubmit(guard), false);
  assert.equal(guard.current, true);
  releaseFormSubmit(guard);
  assert.equal(claimFormSubmit(guard), true);
});

test("a triple click claims the create guard once", () => {
  const guard = { current: false };
  const claims = [claimFormSubmit(guard), claimFormSubmit(guard), claimFormSubmit(guard)];
  assert.deepEqual(claims, [true, false, false]);
  assert.equal(guard.current, true);
});

test("a network failure returns the lease error and releases the submit guard", async () => {
  const guard = { current: false };
  assert.equal(claimFormSubmit(guard), true);
  const value = await callSubmitAction(
    guard,
    async () => {
      throw new TypeError("Failed to fetch");
    },
    () => ({ error: "errors.leaseNetwork" }),
  );
  assert.deepEqual(value, { error: "errors.leaseNetwork" });
  assert.equal(guard.current, false);
  assert.equal(claimFormSubmit(guard), true);
});

test("a non-redirect server failure, including a 500, stays on the form", async () => {
  const guard = { current: true };
  const failure = Object.assign(new Error("An unexpected response was received from the server."), { digest: "500" });
  const value = await callSubmitAction(
    guard,
    async () => {
      throw failure;
    },
    () => ({ error: "errors.leaseNetwork" }),
  );
  assert.equal(isNextRedirect(failure), false);
  assert.deepEqual(value, { error: "errors.leaseNetwork" });
  assert.equal(guard.current, false);
});

test("a Next redirect still throws after the guard is released", async () => {
  const guard = { current: true };
  const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
    digest: "NEXT_REDIRECT;replace;/m/leases/abc?created=1;307;",
  });
  assert.equal(isNextRedirect(redirect), true);
  await assert.rejects(
    () =>
      callSubmitAction(
        guard,
        async () => {
          throw redirect;
        },
        () => ({ error: "errors.leaseNetwork" }),
      ),
    (error: unknown) => error === redirect,
  );
  assert.equal(guard.current, false);
});

test("a resolved server action keeps the submit guard claimed", async () => {
  const guard = { current: false };
  assert.equal(claimFormSubmit(guard), true);
  const value = await callSubmitAction(
    guard,
    async () => "saved",
    () => "retry",
  );
  assert.equal(value, "saved");
  assert.equal(guard.current, true);
  assert.equal(claimFormSubmit(guard), false);
});

test("a failed submit can be resent once and succeeds", async () => {
  const guard = { current: false };
  let attempts = 0;
  async function submit() {
    if (!claimFormSubmit(guard)) throw new Error("guard still held");
    return callSubmitAction(
      guard,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return "saved";
      },
      () => "retry",
    );
  }
  assert.equal(await submit(), "retry");
  assert.equal(guard.current, false);
  assert.equal(await submit(), "saved");
  assert.equal(attempts, 2);
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

test("Enter still commits a select, so the first unit choice is not discarded", () => {
  assert.equal(enterCommitsControl({ tagName: "SELECT" }), true);
  assert.equal(enterCommitsControl({ tagName: "OPTION" }), true);
  assert.equal(enterCommitsControl({ tagName: "TEXTAREA" }), true);
  assert.equal(enterCommitsControl({ tagName: "BUTTON", type: "submit" }), true);
  assert.equal(enterCommitsControl({ tagName: "BUTTON", type: "button" }), false);
  assert.equal(enterCommitsControl({ tagName: "INPUT" }), false);
  assert.equal(enterCommitsControl(null), false);
});
