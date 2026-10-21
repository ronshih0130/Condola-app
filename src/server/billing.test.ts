import assert from "node:assert/strict";
import test from "node:test";
import {
  firmDisplayName,
  formatNt,
  monthlyAmount,
  normalizePartnerCode,
  quoteMonthly,
  seatLimit,
  yearlyAmount,
} from "./billing";

const now = new Date("2026-10-20T00:00:00Z");

test("list prices match the published examples", () => {
  assert.equal(monthlyAmount({ units: 30, rate: 30 }), 780);
  assert.equal(monthlyAmount({ units: 150, rate: 30 }), 4380);
  assert.equal(monthlyAmount({ units: 600, rate: 30 }), 17380);
  assert.equal(monthlyAmount({ units: 600, rate: 40 }), 22340);
  assert.equal(yearlyAmount(17380), 173800);
  const standard = quoteMonthly({ units: 600, tier: "standard", cycle: "month", now });
  const pro = quoteMonthly({ units: 600, tier: "pro", cycle: "year", now });
  assert.equal(standard.monthly, 17380);
  assert.equal(standard.source, "list");
  assert.equal(pro.monthly, 22340);
  assert.equal(pro.due, 223400);
});

test("a partner rate below NT$25 is kept past 500 units", () => {
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
  assert.equal(expired.monthly, 780);
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
