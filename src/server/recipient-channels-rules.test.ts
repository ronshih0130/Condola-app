import assert from "node:assert/strict";
import test from "node:test";
import { planChannels, PORTAL_ENTRY } from "./recipient-channels-rules";

const base = { portal: "tenant" as const, emailAvailable: true, inAppAvailable: true, lineBound: true, lineFriend: true };

test("order is in_app, line, email; entry follows the portal (LIFF reserved)", () => {
  const p = planChannels(base);
  assert.deepEqual(p.channels, ["in_app", "line", "email"]);
  assert.deepEqual(p.entry, { web: "/t", liff: "/t/liff" });
  assert.equal(PORTAL_ENTRY.vendor.liff, "/v/liff");
});

test("LINE needs bound AND friend; unusable requested channels are reported with a reason", () => {
  assert.deepEqual(planChannels({ ...base, lineFriend: false }).unavailable, [{ channel: "line", reason: "not_friend" }]);
  assert.deepEqual(planChannels({ ...base, lineBound: false, lineFriend: false }).unavailable, [{ channel: "line", reason: "not_bound" }]);
  const none = planChannels({ portal: null, emailAvailable: false, inAppAvailable: true, lineBound: true, lineFriend: true });
  assert.deepEqual(none.channels, []);
  assert.deepEqual(none.unavailable, [{ channel: "in_app", reason: "no_portal" }, { channel: "line", reason: "no_portal" }, { channel: "email", reason: "no_email" }]);
  assert.equal(none.entry, null);
});

test("only requested channels are considered", () => {
  assert.deepEqual(planChannels(base, ["email"]).channels, ["email"]);
  assert.deepEqual(planChannels({ ...base, emailAvailable: false }, ["email"]).unavailable, [{ channel: "email", reason: "no_email" }]);
});
