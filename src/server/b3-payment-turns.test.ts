import assert from "node:assert/strict";
import test from "node:test";
import { COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST, tenantPaymentTurn, turnDayNumber } from "./b3-payment-turns";
import type { TenantPaymentHistory } from "./tenant-payment-history";

// Brand 3.0 Batch 3a (B-070), pure parts. Stories: TEN-51, PLT-53.

const ready = (turn?: { waiting: { amountMinor: number; currency: string } | null; reReport: boolean }): TenantPaymentHistory => ({
  state: "ready",
  lease: { id: "l", status: "active", currency: "TWD", canReport: true, legacyPayeeVisible: false },
  bill: { state: "due", overdue: false, pending: false, balanceMinor: 100, paidMinor: 0, currency: "TWD", lines: [] },
  monthlyDue: [], reports: [], nextCursor: null, ...(turn ? { turn } : {}),
} as unknown as TenantPaymentHistory);

test("TEN-51-AC1: a pending own report gives the waiting line with that report's amount", () => {
  assert.deepEqual(tenantPaymentTurn(ready({ waiting: { amountMinor: 3200000, currency: "TWD" }, reReport: false })), { kind: "waiting", amountMinor: 3200000, currency: "TWD" });
  // waiting wins over re-report: the tenant has already done their part
  assert.deepEqual(tenantPaymentTurn(ready({ waiting: { amountMinor: 5, currency: "TWD" }, reReport: true }))?.kind, "waiting");
});

test("TEN-51-AC2: re-report only when the summary says so", () => {
  assert.deepEqual(tenantPaymentTurn(ready({ waiting: null, reReport: true })), { kind: "your_turn", step: "re_report" });
  assert.equal(tenantPaymentTurn(ready({ waiting: null, reReport: false })), null);
});

test("TEN-51 negatives: no summary, history off or unavailable → no line; the result carries no name", () => {
  assert.equal(tenantPaymentTurn(ready()), null);
  assert.equal(tenantPaymentTurn({ state: "off" }), null);
  assert.equal(tenantPaymentTurn({ state: "unavailable" }), null);
  const out = JSON.stringify(tenantPaymentTurn(ready({ waiting: { amountMinor: 1, currency: "TWD" }, reReport: false })));
  assert.deepEqual(Object.keys(JSON.parse(out)).sort(), ["amountMinor", "currency", "kind"]);
});

test("PLT-53-AC5: day count from 1 in the property's timezone; none when since is approximate", () => {
  const taipei = { timezone: "Asia/Taipei", sinceExact: true };
  // 2026-11-14 23:30 Taipei = 15:30Z; "now" 2026-11-15 00:10 Taipei = 16:10Z the same UTC day → day 2 locally
  assert.equal(turnDayNumber({ ...taipei, since: "2026-11-14T15:30:00.000000Z" }, new Date("2026-11-14T16:10:00Z")), 2);
  assert.equal(turnDayNumber({ ...taipei, since: "2026-11-14T02:00:00.000000Z" }, new Date("2026-11-14T03:00:00Z")), 1);
  assert.equal(turnDayNumber({ ...taipei, since: "2026-11-10T02:00:00.000000Z" }, new Date("2026-11-14T03:00:00Z")), 5);
  assert.equal(turnDayNumber({ ...taipei, sinceExact: false, since: "2026-11-10T02:00:00.000000Z" }, new Date("2026-11-14T03:00:00Z")), null);
  assert.equal(turnDayNumber({ timezone: "Not/AZone", sinceExact: true, since: "2026-11-10T02:00:00.000000Z" }, new Date("2026-11-14T03:00:00Z")), null);
  assert.equal(turnDayNumber({ ...taipei, since: "not a date" }), null);
  // a clock that is behind `since` never yields day 0 or a negative day
  assert.equal(turnDayNumber({ ...taipei, since: "2026-11-14T02:00:00.000000Z" }, new Date("2026-11-12T03:00:00Z")), null);
});

test("3a is read-only: the reader's SQL only selects, and only tenant-portal reports are matters", () => {
  for (const sql of [COUNTS_SQL_FOR_TEST, LISTS_SQL_FOR_TEST]) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
    assert.doesNotMatch(sql, /\bFOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/i);
    assert.match(sql, /p\.org_id = \$1/);
    // every read of payments is restricted to tenant-portal reports of this org
    assert.equal((sql.match(/source = 'tenant_portal'/g) ?? []).length >= 3, true);
  }
});
