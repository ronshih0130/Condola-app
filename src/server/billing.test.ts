import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_UNITS,
  firmDisplayName,
  formatNt,
  monthlyAmount,
  normalizePartnerCode,
  quoteMonthly,
  seatLimit,
  yearlyAmount,
} from "./billing";
import { FREE_ACTIVE_UNITS } from "./sandbox-data";
import { INTERIM_FREE_UNITS } from "./b045-pricing-interim-rules";

const now = new Date("2026-10-20T00:00:00Z");

test("list prices match the published examples", () => {
  assert.equal(monthlyAmount({ units: 30, rate: 30 }), 750);
  assert.equal(monthlyAmount({ units: 150, rate: 30 }), 4350);
  assert.equal(monthlyAmount({ units: 600, rate: 30 }), 17850);
  assert.equal(monthlyAmount({ units: 600, rate: 40 }), 23800);
  assert.equal(yearlyAmount(17850), 196350);
  const standard = quoteMonthly({ units: 600, tier: "standard", cycle: "month", now });
  const pro = quoteMonthly({ units: 600, tier: "pro", cycle: "year", now });
  assert.equal(standard.monthly, 17850);
  assert.equal(standard.source, "list");
  assert.equal(pro.monthly, 23800);
  assert.equal(pro.due, 261800);
});

test("a partner rate applies to every billable unit", () => {
  assert.equal(monthlyAmount({ units: 200, rate: 20, freeUnits: 4 }), 3920);
  assert.equal(monthlyAmount({ units: 600, rate: 20, freeUnits: 4 }), 11920);
  const anju = quoteMonthly({
    units: 600,
    tier: "standard",
    cycle: "month",
    now,
    snapshot: { standardPrice: 20, proPrice: 30, freeUnits: 4, lockedUntil: "2027-10-20T00:00:00Z" },
  });
  assert.equal(anju.monthly, 11920);
  assert.equal(anju.source, "code");
  assert.equal(formatNt(anju.monthly), "NT$11,920");
});

test("a manual per-firm rate overrides the partner snapshot", () => {
  const quote = quoteMonthly({
    units: 200,
    tier: "standard",
    cycle: "month",
    now,
    snapshot: { standardPrice: 20, proPrice: 30, freeUnits: 4, lockedUntil: "2027-10-20T00:00:00Z" },
    override: { rate: 10, lockedUntil: null },
  });
  assert.equal(quote.source, "override");
  assert.equal(quote.rate, 10);
  assert.equal(quote.freeUnits, 4);
  assert.equal(quote.monthly, 1960);
  const expired = quoteMonthly({
    units: 30,
    tier: "standard",
    cycle: "month",
    now,
    snapshot: { standardPrice: 20, proPrice: 30, freeUnits: 4, lockedUntil: "2020-01-01T00:00:00Z" },
  });
  assert.equal(expired.source, "list");
  assert.equal(expired.monthly, 750);
});

test("seat caps and firm names", () => {
  assert.equal(seatLimit("free"), 1);
  assert.equal(seatLimit("standard"), 5);
  assert.equal(seatLimit("pro"), null);
  assert.equal(seatLimit("beta"), null);
  assert.equal(firmDisplayName("self", "", "ada@example.com"), "ada 的租屋");
  assert.equal(firmDisplayName("self", " 安居 ", "ada@example.com"), "安居");
  assert.equal(firmDisplayName("firm", " 松信 ", "ada@example.com"), "松信");
  assert.equal(normalizePartnerCode(" anju2026 "), "ANJU2026");
  assert.equal(normalizePartnerCode("no"), null);
  assert.equal(normalizePartnerCode(""), "");
});

// C4 (Ron 2026-11-13 01:30 PT, hub DECISIONS): free units = 5 everywhere; only units above 5 are billed.
test("C4: the first 5 units are free and billing starts at the 6th unit", () => {
  assert.equal(FREE_UNITS, 5);
  assert.equal(monthlyAmount({ units: 0, rate: 30 }), 0);
  assert.equal(monthlyAmount({ units: 5, rate: 30 }), 0);
  assert.equal(monthlyAmount({ units: 6, rate: 30 }), 30);
  assert.equal(monthlyAmount({ units: 6, rate: 40 }), 40);
  const list = quoteMonthly({ units: 5, tier: "standard", cycle: "month", now });
  assert.equal(list.source, "list");
  assert.equal(list.freeUnits, 5);
  assert.equal(list.monthly, 0);
  // A partner snapshot's negotiated allowance still wins over the list default.
  const partner = quoteMonthly({
    units: 6, tier: "standard", cycle: "month", now,
    snapshot: { standardPrice: 20, proPrice: 30, freeUnits: 4, lockedUntil: "2027-10-20T00:00:00Z" },
  });
  assert.equal(partner.freeUnits, 4);
  assert.equal(partner.monthly, 40);
});

test("C4: the free-unit threshold has one value across billing, sandbox cap and interim display", () => {
  assert.equal(FREE_ACTIVE_UNITS, FREE_UNITS);
  assert.equal(INTERIM_FREE_UNITS, FREE_UNITS);
});

test("C4: new partner codes default to FREE_UNITS in the admin form and the server action (Codex QA r1 P1)", async () => {
  const { readFileSync } = await import("node:fs");
  const form = readFileSync(new URL("../app/m/admin/page.tsx", import.meta.url), "utf8");
  const action = readFileSync(new URL("./signup-actions.ts", import.meta.url), "utf8");
  assert.match(form, /name="freeUnits"[^>]*defaultValue=\{FREE_UNITS\}/);
  assert.match(action, /freeUnits: number\("freeUnits", FREE_UNITS\)/);
});
