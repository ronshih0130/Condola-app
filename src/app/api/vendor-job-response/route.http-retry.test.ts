import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { exerciseHttpRetry } from "../vendor-job/http-retry-fixture";
import { POST } from "./route";

const start = "2026-11-10T09:00:00.000Z";
const end = "2026-11-10T10:00:00.000Z";

test("response route uses the supplied requestId without a session or consent gate", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /randomUUID|getSession|requireCurrentConsent/);
});

for (const action of ["propose", "accept_confirm", "reject"] as const) {
  test(`HTTP ${action} retry replays the original event and rejects changed payloads`, async (t) => {
    const times = action === "propose" ? { proposedStart: start, proposedEnd: end }
      : { confirmedStart: start, confirmedEnd: end };
    const initial = { action, times, reason: "Available at this time" };
    const mutations: Record<string, unknown>[] = [{ reason: "Updated reason" }];
    if (action !== "reject") {
      mutations.push({ times: action === "propose"
        ? { ...times, proposedEnd: "2026-11-10T11:00:00.000Z" }
        : { ...times, confirmedEnd: "2026-11-10T11:00:00.000Z" } });
    }
    const calls = await exerciseHttpRetry(t, POST, "/api/vendor-job-response", initial, mutations);
    assert.equal(calls[0][5], action === "reject" ? "vendor_rejected" : "vendor_proposed");
    assert.deepEqual(calls[0].slice(6, 10), action === "reject"
      ? [null, null, null, null] : [start, end, null, null]);
    assert.equal(calls[0][10], initial.reason);
  });
}
