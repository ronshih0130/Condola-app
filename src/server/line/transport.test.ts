import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCapturedLineTransport } from "./transport";
test("captured transport modes preserve retry keys locally; no network implementation", async () => {
  for (const mode of ["accepted", "failed", "timeout", "duplicateAccepted"] as const) {
    const t = createCapturedLineTransport({ mode });
    assert.equal((await t.push({ channelId: "local", to: "local", messages: [], headers: { "X-Line-Retry-Key": "same-claim" } })).status, mode);
    assert.equal(t.calls[0].method, "push");
  }
  const source = readFileSync(new URL("./transport.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|https?:\/\/|node:https|node:http/);
});
test("used/failed reply token never triggers push", async () => {
  for (const mode of ["accepted", "failed", "timeout"] as const) {
    const t = createCapturedLineTransport({ mode });
    await t.reply("one-use", []);
    assert.equal((await t.reply("one-use", [])).status, "failed");
    assert.equal(t.calls.filter(c => c.method === "push").length, 0);
  }
});
