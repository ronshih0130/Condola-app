import assert from "node:assert/strict";
import test from "node:test";
import { readHandoverJson } from "./handover-input";

test("JSON input is bounded by actual bytes, not just its header", async () => {
  assert.deepEqual(await readHandoverJson(new Request("http://localhost",{method:"POST",body:'{"operation":"prepare"}'})),{operation:"prepare"});
  await assert.rejects(readHandoverJson(new Request("http://localhost",{method:"POST",headers:{"content-length":"999999"},body:"{}"})));
  await assert.rejects(readHandoverJson(new Request("http://localhost",{method:"POST",headers:{"content-length":"1"},body:'{"padding":"'+"x".repeat(17000)+'"}'})));
  await assert.rejects(readHandoverJson(new Request("http://localhost",{method:"POST",body:"[]"})));
});
