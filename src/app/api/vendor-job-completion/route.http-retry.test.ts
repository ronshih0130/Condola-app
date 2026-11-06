import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { exerciseHttpRetry } from "../vendor-job/http-retry-fixture";
import { POST } from "./route";

test("completion route uses the supplied requestId without a session or consent gate", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /randomUUID|getSession|requireCurrentConsent/);
});

for (const hasAfterPhoto of [false, true]) {
  test(`HTTP completion retry with hasAfterPhoto=${hasAfterPhoto} replays one event`, async (t) => {
    const calls = await exerciseHttpRetry(t, POST, "/api/vendor-job-completion",
      { hasAfterPhoto, reason: "Work finished" },
      [{ reason: "Work finished; cleanup complete" }],
    );
    assert.equal(calls[0][5], "vendor_completion_submitted");
    assert.deepEqual(calls[0].slice(6, 10), [null, null, null, null]);
    assert.equal(calls[0][10], "Work finished");
  });
}

test("completion without an after photo requires a note", async () => {
  const response = await POST(new Request("http://localhost:43123/api/vendor-job-completion", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "v".repeat(43), requestId: "6dbf5a6c-2458-4daa-9f32-291a6b61d332",
      hasAfterPhoto: false,
    }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "rejected_invalid" });
});
