import assert from "node:assert/strict";
import test from "node:test";
import { exerciseHttpRetry } from "../vendor-job/http-retry-fixture";
import { POST } from "./route";

for (const afterPhotoCount of [0, 1]) {
  test(`HTTP completion uses ${afterPhotoCount} server-linked photos and replays one event`, async (t) => {
    const reason = afterPhotoCount === 0 ? "Work finished" : null;
    const calls = await exerciseHttpRetry(t, POST, "/api/vendor-job-completion",
      { hasAfterPhoto: afterPhotoCount === 0, reason },
      [{ reason: "Work finished; cleanup complete" }],
      afterPhotoCount,
    );
    assert.equal(calls[0][5], "vendor_completion_submitted");
    assert.deepEqual(calls[0].slice(6, 10), [null, null, null, null]);
    assert.equal(calls[0][10], reason);
  });
}

test("completion does not require a client photo assertion", async (t) => {
  await exerciseHttpRetry(t, POST, "/api/vendor-job-completion",
    { reason: null }, [{ reason: "Cleanup complete" }], 1);
});
