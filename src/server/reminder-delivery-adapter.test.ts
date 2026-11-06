import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  createMemoryDeliveryAdapter,
  type ReminderDeliveryRequest,
} from "./reminder-delivery-adapter";

function request(
  overrides: Partial<ReminderDeliveryRequest> = {},
): ReminderDeliveryRequest {
  return {
    reminderEventId: "event-1",
    leaseId: "lease-1",
    channel: "email",
    occurrenceKey: "2026-03-08:0",
    templateId: "rent-due",
    payload: { balanceMinor: 10000 },
    ...overrides,
  };
}

test("successful delivery records the request and returns a provider reference", async () => {
  const adapter = createMemoryDeliveryAdapter();
  const req = request();

  assert.deepEqual(adapter.sent, []);

  const result = await adapter.deliver(req);

  assert.equal(result.reminderEventId, req.reminderEventId);
  assert.equal(result.delivered, true);
  assert.equal(typeof result.providerRef, "string");
  assert.ok(result.providerRef);
  assert.deepEqual(adapter.sent, [req]);
});

test("repeated event and channel return the original reference without resending", async () => {
  const adapter = createMemoryDeliveryAdapter();
  const original = request();
  const first = await adapter.deliver(original);
  const second = await adapter.deliver(
    request({
      leaseId: "different-lease",
      occurrenceKey: "2026-03-09:1",
      templateId: "different-template",
      payload: { balanceMinor: 20000 },
    }),
  );

  assert.deepEqual(second, first);
  assert.equal(second.providerRef, first.providerRef);
  assert.deepEqual(adapter.sent, [original]);
});

test("the same event can be delivered once through each channel", async () => {
  const adapter = createMemoryDeliveryAdapter();
  const email = request({ channel: "email" });
  const line = request({ channel: "line" });

  const emailResult = await adapter.deliver(email);
  const lineResult = await adapter.deliver(line);

  assert.equal(emailResult.delivered, true);
  assert.equal(lineResult.delivered, true);
  assert.notEqual(emailResult.providerRef, lineResult.providerRef);
  assert.deepEqual(adapter.sent, [email, line]);

  assert.deepEqual(await adapter.deliver(email), emailResult);
  assert.deepEqual(await adapter.deliver(line), lineResult);
  assert.equal(adapter.sent.length, 2);
});

test("different event IDs on the same channel are independent deliveries", async () => {
  const adapter = createMemoryDeliveryAdapter();
  const firstRequest = request({ reminderEventId: "event-1" });
  const secondRequest = request({ reminderEventId: "event-2" });

  const first = await adapter.deliver(firstRequest);
  const second = await adapter.deliver(secondRequest);

  assert.equal(first.reminderEventId, "event-1");
  assert.equal(second.reminderEventId, "event-2");
  assert.notEqual(first.providerRef, second.providerRef);
  assert.deepEqual(adapter.sent, [firstRequest, secondRequest]);
});

test("concurrent duplicate deliveries are idempotent", async () => {
  const adapter = createMemoryDeliveryAdapter();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => adapter.deliver(request())),
  );

  assert.equal(adapter.sent.length, 1);
  for (const result of results) {
    assert.deepEqual(result, results[0]);
  }
});

test("mutating a returned result cannot alter a cached delivery", async () => {
  const adapter = createMemoryDeliveryAdapter();
  const first = await adapter.deliver(request());
  const originalProviderRef = first.providerRef;

  first.providerRef = "modified";
  first.delivered = false;
  first.reminderEventId = "modified-event";

  const retry = await adapter.deliver(request());

  assert.equal(retry.providerRef, originalProviderRef);
  assert.equal(retry.delivered, true);
  assert.equal(retry.reminderEventId, "event-1");
  assert.equal(adapter.sent.length, 1);
});

test("adapter instances maintain independent delivery state", async () => {
  const firstAdapter = createMemoryDeliveryAdapter();
  const secondAdapter = createMemoryDeliveryAdapter();

  await firstAdapter.deliver(request());
  assert.equal(firstAdapter.sent.length, 1);
  assert.equal(secondAdapter.sent.length, 0);

  const result = await secondAdapter.deliver(request());

  assert.equal(result.delivered, true);
  assert.equal(firstAdapter.sent.length, 1);
  assert.equal(secondAdapter.sent.length, 1);
  assert.notEqual(firstAdapter.sent, secondAdapter.sent);
});
