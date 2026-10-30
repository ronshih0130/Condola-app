import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createResendMemory } from "./test-portal-resend-memory";
import { resendEligibility, settleResend, simulatedResult } from "../lib/portal-resend-state";
import { PortalResendResult } from "../components/portal-resend-result";

const sourceId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const request2 = "00000000-0000-4000-8000-000000000003";
const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request = { sourceId, requestId, orgId, actorId, generation: 1, payloadDigest: "a".repeat(64), snapshot: { enabled: true, available: true, connected: false } };
const clock = () => { let fire = () => {}; return { schedule: (cb: () => void) => { fire = cb; return () => {}; }, fire: () => fire() }; };

test("reference eligibility and final states retain simulation provenance", () => {
  assert.deepEqual(resendEligibility({ enabled: false, available: false, connected: true }), simulatedResult("disabled"));
  assert.deepEqual(resendEligibility({ enabled: false, available: true, connected: false }), simulatedResult("disabled"));
  assert.deepEqual(resendEligibility({ enabled: true, available: false, connected: false }), simulatedResult("unavailable"));
  assert.deepEqual(settleResend(simulatedResult("unknown"), "accepted"), simulatedResult("unknown"));
});
test("same request replays, conflicting request cannot claim active generation", async () => {
  let calls = 0; let resolve!: (x: "captured") => void;
  const model = createResendMemory(() => { calls++; return new Promise(r => { resolve = r; }); }, clock());
  const a = model.run(request); const b = model.run({ ...request });
  assert.deepEqual(await model.run({ ...request, payloadDigest: "b".repeat(64) }), simulatedResult("conflict"));
  assert.deepEqual(await model.run({ ...request, requestId: request2 }), simulatedResult("conflict"));
  assert.deepEqual(await model.run({ ...request, requestId: request2, generation: 2 }), simulatedResult("conflict"));
  await Promise.resolve(); resolve("captured");
  assert.deepEqual(await a, simulatedResult("captured")); assert.deepEqual(await b, await a); assert.equal(calls, 1);
  assert.deepEqual(await model.run({ ...request, requestId: request2 }), simulatedResult("conflict"));
});
test("unknown is terminal even when a late transport resolves", async () => {
  const timer = clock(); let resolve!: (x: "accepted") => void;
  const model = createResendMemory(() => new Promise(r => { resolve = r; }), timer);
  const pending = model.run(request); await Promise.resolve(); timer.fire();
  assert.deepEqual(await pending, simulatedResult("unknown")); resolve("accepted"); await Promise.resolve();
  assert.deepEqual(await model.run(request), simulatedResult("unknown"));
  assert.deepEqual(await model.run({ ...request, requestId: request2 }), simulatedResult("conflict"));
  assert.deepEqual(await model.run({ ...request, requestId: request2, generation: 2 }), simulatedResult("conflict"));
});
test("completed association bypasses the transport and no private material appears", async () => {
  let calls = 0; const model = createResendMemory(async () => { calls++; throw Error("private transport error"); }, clock());
  assert.deepEqual(await model.run({ ...request, snapshot: { ...request.snapshot, connected: true } }), simulatedResult("already_connected"));
  assert.equal(calls, 0);
  const unknown = await model.run(request); assert.deepEqual(unknown, simulatedResult("unknown"));
  assert.equal(JSON.stringify(unknown).includes("private"), false);
});
test("shared renderer escapes context and labels simulation in both locales", () => {
  for (const locale of ["en", "zh-TW"] as const) for (const audience of ["owner", "tenant"] as const) {
    const html = renderToStaticMarkup(createElement(PortalResendResult, { result: simulatedResult("captured"), locale, company: "<Synthetic>", audience }));
    assert.ok(html.includes("&lt;Synthetic&gt;")); assert.ok(html.includes(locale === "en" ? "Simulation preview" : "模擬預覽"));
    assert.ok(html.includes(locale === "en" ? "delivery is not confirmed" : "尚未確認送達"));
  }
});

test("definitive rejection releases the local reservation; acceptance retains it", async () => {
  let calls = 0;
  const model = createResendMemory(async () => { calls++; return calls === 1 ? "rejected" : "accepted"; }, clock());
  assert.deepEqual(await model.run({ ...request, requestId: "-".repeat(36) }), simulatedResult("conflict"));
  assert.equal(calls, 0);
  assert.deepEqual(await model.run(request), simulatedResult("rejected"));
  assert.deepEqual(await model.run(request), simulatedResult("rejected"));
  assert.deepEqual(await model.run({ ...request, requestId: request2, generation: 2 }), simulatedResult("accepted"));
  assert.deepEqual(await model.run({ ...request, requestId: request2, generation: 2 }), simulatedResult("accepted"));
  assert.deepEqual(await model.run({ ...request, requestId: "00000000-0000-4000-8000-000000000004", generation: 3 }), simulatedResult("conflict"));
  assert.equal(calls, 2);
});

test("scoped identity is canonical and models remain independent", async () => {
  let calls = 0;
  const script = async () => { calls++; return "accepted" as const; };
  const a = createResendMemory(script, clock()), b = createResendMemory(script, clock());
  const first = await a.run(request);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(await a.run({ ...request, orgId: orgId.toUpperCase(), actorId: actorId.toUpperCase() }), first);
  assert.deepEqual(await a.run({ ...request, actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }), simulatedResult("conflict"));
  assert.deepEqual(await a.run({ ...request, orgId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }), simulatedResult("accepted"));
  assert.deepEqual(await b.run(request), simulatedResult("accepted"));
  assert.equal(calls, 3);
});
test("unexpected transport output becomes unknown and cannot auto retry", async () => {
  const model = createResendMemory(async () => "unexpected" as never, clock());
  assert.deepEqual(await model.run(request), simulatedResult("unknown"));
  assert.deepEqual(await model.run({ ...request, requestId: request2, generation: 2 }), simulatedResult("conflict"));
});
