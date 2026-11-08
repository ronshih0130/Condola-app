import test from "node:test";
import assert from "node:assert/strict";
import { recordPeriodDueComponent } from "./period-due-components";
import { writeMonthlyRent, readMonthlyRentHistory } from "./monthly-rent-writer";
import { monthlyRentHttpStatus } from "../app/api/monthly-rent-issue/_http-status";
import { POST } from "../app/api/monthly-rent-issue/route";
import type { Session } from "./types";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

const session = {
  userId: UUID,
  sessionId: UUID,
  email: "a@example.invalid",
  name: "a",
  kind: "staff",
  role: "admin",
  orgId: UUID,
  liveOrgId: UUID,
  environment: "live",
  locale: "en",
  calendar: "gregorian",
  leaseId: null,
  consent: null,
} as unknown as Session;

const component = {
  componentKey: "rent",
  amountMinor: "500",
  currency: "TWD",
  sourceRefKind: "manual",
  sourceRefId: UUID,
} as const;

const componentInput = {
  leaseId: UUID,
  periodYm: "2028-01",
  component,
};

const rentInput = {
  leaseId: UUID,
  month: "2028-01",
  requestId: UUID,
  expectedDigest: "a".repeat(64),
};

test("recordPeriodDueComponent rejects unauthorized sessions before database access", async () => {
  const unauthorizedSessions = [
    { ...session, role: "manager" },
    { ...session, role: undefined },
    { ...session, kind: "tenant" },
    { ...session, kind: "owner" },
  ];

  for (const candidate of unauthorizedSessions) {
    assert.deepEqual(
      await recordPeriodDueComponent(candidate as unknown as Session, componentInput),
      { ok: false, reason: "forbidden" },
    );
  }
});

test("recordPeriodDueComponent rejects invalid input before database access", async () => {
  const invalidInputs = [
    { ...componentInput, leaseId: "nope" },
    { ...componentInput, periodYm: "2028-13" },
    ...["0", "-5", "1.5", ""].map((amountMinor) => ({
      ...componentInput,
      component: { ...component, amountMinor },
    })),
    ...["twd", "TW"].map((currency) => ({
      ...componentInput,
      component: { ...component, currency },
    })),
    ...["  ", null].map((sourceRefId) => ({
      ...componentInput,
      component: { ...component, sourceRefId },
    })),
  ];

  for (const input of invalidInputs) {
    assert.deepEqual(
      await recordPeriodDueComponent(session, input),
      { ok: false, reason: "invalid" },
    );
  }
});

test("writeMonthlyRent rejects manager sessions before database access", async () => {
  const manager = { ...session, role: "manager" } as unknown as Session;

  assert.equal(
    (await writeMonthlyRent(manager, rentInput)).status,
    "rejected_disabled",
  );
});

test("writeMonthlyRent rejects invalid input before database access", async () => {
  const invalidInputs = [
    { ...rentInput, leaseId: "nope" },
    { ...rentInput, requestId: "nope" },
    { ...rentInput, expectedDigest: "nope" },
    { ...rentInput, month: "2028-13" },
  ];

  for (const input of invalidInputs) {
    assert.equal(
      (await writeMonthlyRent(session, input)).status,
      "rejected_invalid",
    );
  }
});

test("readMonthlyRentHistory rejects manager sessions before database access", async () => {
  const manager = { ...session, role: "manager" } as unknown as Session;

  assert.equal(
    (await readMonthlyRentHistory(manager, {
      leaseId: UUID,
      month: "2028-01",
    }))!.status,
    "rejected_disabled",
  );
});

test("readMonthlyRentHistory rejects invalid input before database access", async () => {
  for (const input of [
    { leaseId: UUID, month: "2028-13" },
    { leaseId: "nope", month: "2028-01" },
  ]) {
    assert.equal(
      (await readMonthlyRentHistory(session, input))!.status,
      "rejected_invalid",
    );
  }
});

test("monthlyRentHttpStatus maps every result status", () => {
  const cases = [
    ["rejected_disabled", 403],
    ["rejected_invalid", 400],
    ["rejected_conflict", 409],
    ["unsupported", 422],
    ["created", 200],
    ["already_issued", 200],
    ["replay", 200],
  ] as const;

  for (const [status, expected] of cases) {
    assert.equal(monthlyRentHttpStatus(status), expected, status);
  }
});

test("POST rejects cross-site requests without a session", async () => {
  const response = await POST(
    new Request("https://app.example/api/monthly-rent-issue", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        host: "app.example",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );

  assert.ok([401, 403].includes(response.status));
  if (response.headers) {
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
});

test("POST rejects requests without an origin or a session", async () => {
  const response = await POST(
    new Request("https://app.example/api/monthly-rent-issue", {
      method: "POST",
      headers: {
        host: "app.example",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );

  assert.ok([401, 403].includes(response.status));
  if (response.headers) {
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
});

test("POST rejects same-origin text requests without a session", async () => {
  const response = await POST(
    new Request("https://app.example/api/monthly-rent-issue", {
      method: "POST",
      headers: {
        origin: "https://app.example",
        host: "app.example",
        "content-type": "text/plain",
      },
      body: "{}",
    }),
  );

  assert.ok([401, 403].includes(response.status));
  if (response.headers) {
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
});
