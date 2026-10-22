import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "./errors";
import { demoModeEnabled } from "./demo";
import { taipeiToday } from "./money";
import {
  allocateOldestFirst,
  companyHandledRent,
  depositBalance,
  divHalfUp,
  formatTwd,
  paymentBalance,
  prorateRent,
  settlementClosing,
} from "./payment-rules";

const qaClock = globalThis as { __qaBusinessToday?: string };

test("move-out rent is half-up once, then capped at one month", () => {
  assert.equal(divHalfUp(12975, 30), 433);
  assert.equal(prorateRent(18000, 12), 7200);
  assert.equal(prorateRent(15000, 7), 3500);
  assert.equal(prorateRent(17500, 11), 6417);
  assert.equal(prorateRent(20000, 1), 667);
  assert.equal(prorateRent(18000, 30), 18000);
  assert.equal(prorateRent(12975, 1), 433);
  assert.equal(prorateRent(18000, 31), 18000);
});

test("partial payments, company-handled rent, deposit shortfall, and closing", () => {
  assert.deepEqual(paymentBalance(18000, [10000]), {
    status: "部分付款",
    remaining: 8000,
    text: "尚未繳 NT$8,000",
  });
  assert.deepEqual(
    allocateOldestFirst(
      [
        { period: "2026-09", remaining: 18000 },
        { period: "2026-08", remaining: 18000 },
      ],
      25000,
    ),
    [
      { period: "2026-08", remaining: 0 },
      { period: "2026-09", remaining: 11000 },
    ],
  );
  assert.equal(
    companyHandledRent([
      { recipient: "company", type: "rent", amount: 36000 },
      { recipient: "owner", type: "rent", amount: 18000 },
      { recipient: "company", type: "deposit", amount: 36000 },
    ]),
    36000,
  );
  assert.equal(depositBalance(36000, [30000, 8500]).shortfall, 2500);
  assert.equal(depositBalance(36000, [36000]).warning, false);
  assert.equal(settlementClosing({ opening: 5000, rent: 36000, expenses: 4200, payouts: 30000 }), 6800);
  assert.equal(formatTwd(-3300), "\u2212NT$3,300");
});

test("the demo business clock is ignored outside demo mode", () => {
  const env = process.env as Record<string, string | undefined>;
  const previousMode = env.DEMO_MODE;
  const previousNode = env.NODE_ENV;
  const previousCondola = env.CONDOLA_ENV;
  const previousClock = qaClock.__qaBusinessToday;
  try {
    env.DEMO_MODE = "true";
    env.NODE_ENV = "test";
    delete env.CONDOLA_ENV;
    qaClock.__qaBusinessToday = "2026-10-06";
    assert.equal(demoModeEnabled(), true);
    assert.equal(taipeiToday(), "2026-10-06");
    env.NODE_ENV = "production";
    assert.equal(demoModeEnabled(), false);
    assert.equal(taipeiToday() === "2026-10-06", false);
  } finally {
    if (previousMode === undefined) delete env.DEMO_MODE;
    else env.DEMO_MODE = previousMode;
    if (previousNode === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNode;
    if (previousCondola === undefined) delete env.CONDOLA_ENV;
    else env.CONDOLA_ENV = previousCondola;
    if (previousClock === undefined) delete qaClock.__qaBusinessToday;
    else qaClock.__qaBusinessToday = previousClock;
  }
});

test("a manager cannot confirm or decline a tenant-reported payment", async () => {
  const { confirmPayment, rejectPayment } = await import("./domain");
  const manager = {
    userId: "00000000-0000-4000-8000-000000000010",
    sessionId: "qa",
    email: "manager@example.test",
    name: "manager",
    kind: "staff" as const,
    role: "manager" as const,
    orgId: "00000000-0000-4000-8000-000000000001",
    liveOrgId: "00000000-0000-4000-8000-000000000001",
    environment: "live" as const,
    locale: "zh-TW" as const,
    calendar: "gregorian" as const,
    leaseId: null,
  };
  await assert.rejects(() => confirmPayment(manager, "00000000-0000-4000-8000-000000000099"), (error: unknown) => {
    assert.ok(error instanceof FlowError);
    assert.equal(error.key, "errors.forbidden");
    return true;
  });
  await assert.rejects(
    () => rejectPayment(manager, "00000000-0000-4000-8000-000000000099", "不登記"),
    (error: unknown) => {
      assert.ok(error instanceof FlowError);
      assert.equal(error.key, "errors.forbidden");
      return true;
    },
  );
});
