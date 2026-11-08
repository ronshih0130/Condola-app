import assert from "node:assert/strict";
import test from "node:test";
import { formatLedgerMinor, ledgerPanelView } from "./owner-net-ledger-presentation";
import { buildSnapshot } from "./owner-net-ledger-rules";

test("formatLedgerMinor keeps integer minor units exact beyond 2^53", () => {
  assert.equal(formatLedgerMinor(BigInt("900719925474099312"), "USD", 2, "en"), "USD 9,007,199,254,740,993.12");
  assert.equal(formatLedgerMinor(BigInt(-150000), "TWD", 2, "zh-TW"), "−NT$1,500");
  assert.equal(formatLedgerMinor(BigInt(5), "JPY", 0, "en"), "JPY 5");
  assert.throws(() => formatLedgerMinor(BigInt(1), "USD", 7, "en"));
});

test("ledgerPanelView marks negative net, direct rent and keeps version 1 first", () => {
  const snapshot = buildSnapshot({ opening: BigInt(0), companyRent: BigInt(1000), directRent: BigInt(500), otherIncome: BigInt(0),
    managementFee: BigInt(100), expenses: BigInt(400), payouts: BigInt(900), prepayDraws: BigInt(0) },
  { currency: "TWD", periodStart: "2028-01-01", periodEnd: "2028-01-31", statementId: "s", calculationFingerprint: "f" });
  const view = ledgerPanelView({
    latest: { id: "v2", version_no: 2, reason: "fix", actor_user_id: "u", actor_name: null, created_at: "t2", snapshot },
    versions: [{ id: "v2", version_no: 2, reason: "fix", actor_user_id: "u", actor_name: null, created_at: "t2", snapshot }],
    canRecord: false, deliveries: null, currency: "TWD", minorUnit: 2,
    original: { issuedAt: "t1", issuedBy: null }, staff: false,
  }, { statementId: "s", locale: "zh-TW" });
  assert.equal(view.latest?.negative, true);
  assert.equal(view.latest?.hasDirectRent, true);
  assert.equal(view.latest?.reconciles, true);
  assert.equal(view.latest?.net, "−NT$4");
  assert.deepEqual(view.versions.map((v) => v.versionNo), [1, 2]);
  assert.equal(view.versions[1].actor, null);
  const direct = view.latest?.lines.find((l) => l.key === "direct_rent");
  assert.equal(direct?.affectsBalance, false);
});

test("period-net label follows net, not closing (opening 1000 / net -100 and opening -1000 / net +100)", () => {
  const make = (opening: number, payouts: number) => buildSnapshot({ opening: BigInt(opening), companyRent: BigInt(100), directRent: BigInt(0), otherIncome: BigInt(0),
    managementFee: BigInt(0), expenses: BigInt(0), payouts: BigInt(payouts), prepayDraws: BigInt(0) },
  { currency: "USD", periodStart: "2028-01-01", periodEnd: "2028-01-31", statementId: "s", calculationFingerprint: "f" });
  const view = (snapshot: ReturnType<typeof make>) => ledgerPanelView({
    latest: { id: "v2", version_no: 2, reason: "r", actor_user_id: "u", actor_name: "Staff A", created_at: "t", snapshot },
    versions: [{ id: "v2", version_no: 2, reason: "r", actor_user_id: "u", actor_name: "Staff A", created_at: "t", snapshot }],
    canRecord: false, deliveries: null, currency: "USD", minorUnit: 2, original: { issuedAt: "t1", issuedBy: null }, staff: false,
  }, { statementId: "s", locale: "en" });
  assert.equal(view(make(1000, 200)).latest?.negative, true);
  assert.equal(view(make(-1000, 0)).latest?.negative, false);
  const v = view(make(1000, 200));
  assert.equal(v.versions[1].actor, "Staff A");
  assert.ok(v.versions[1].breakdown, "each later version keeps its own breakdown");
});
