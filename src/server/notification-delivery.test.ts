import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { createCaptureAdapter, runDeliveryAttempts, type DeliveryChannel } from "./notification-delivery";
import { centerCopy } from "../i18n/lanes/notification-center";

for (const channel of ["email", "line"] satisfies DeliveryChannel[]) {
  test(`${channel} capture is local preparation and records a request snapshot`, async (t) => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network call"); });
    const adapter = createCaptureAdapter(channel);
    const req = { attemptId: "attempt", sourceKind: "rent_due", sourceId: "source", recipientKey: "contact:opaque", attempt: 1 };
    assert.equal(adapter.channel, channel);
    assert.deepEqual(await adapter.deliver(req), { result: "captured" });
    assert.deepEqual(adapter.captures, [req]);
    req.recipientKey = "changed";
    assert.equal(adapter.captures[0].recipientKey, "contact:opaque");
    assert.equal(createCaptureAdapter(channel).captures.length, 0);
  });
}

test("delivery labels distinguish local capture and provider acceptance without claiming delivery", () => {
  assert.deepEqual(centerCopy("en").delivery, {
    queued: "Queued", claimed: "Preparing", captured: "Recorded locally (not sent)",
    accepted: "Accepted by provider (not confirmed delivered)", failed: "Failed", unknown: "Result unconfirmed (not retried automatically)",
  });
  assert.deepEqual(centerCopy("zh-TW").delivery, {
    queued: "排隊中", claimed: "準備中", captured: "已在本機記錄（未發送）",
    accepted: "服務商已受理（不代表已送達）", failed: "失敗", unknown: "結果未確認（不會自動重試）",
  });
});

for (const value of [undefined, "false", "TRUE", ""]) test(`LINE env OFF ${String(value)} preserves zero-limit Email runner query sequence`, async t => {
  const old = process.env.LINE_PLATFORM_ENABLED;
  if (value === undefined) delete process.env.LINE_PLATFORM_ENABLED; else process.env.LINE_PLATFORM_ENABLED = value;
  t.mock.method(Client.prototype, "query", () => { throw new Error("OFF added a database query"); });
  const errors = t.mock.method(console, "error", () => {});
  try {
    assert.equal(await runDeliveryAttempts("unused", createCaptureAdapter("email"), 0), 0);
    assert.equal(errors.mock.callCount(), 0);
  } finally {
    if (old === undefined) delete process.env.LINE_PLATFORM_ENABLED; else process.env.LINE_PLATFORM_ENABLED = old;
  }
});
