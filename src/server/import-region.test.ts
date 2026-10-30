import assert from "node:assert/strict";
import test from "node:test";
import { resolveImportRegion } from "./import-region";

const row = { country_code: "TW", jurisdiction_id: "fixture", jurisdiction_code: "TW",
  jurisdiction_country: "TW", default_currency: "TWD", timezone: "Asia/Taipei" };

test("import profile uses configured timezone across midnight, never the machine's day", () => {
  const at = new Date("2026-11-01T00:30:00Z");
  assert.equal(resolveImportRegion(row, at).today, "2026-11-01");
  assert.equal(resolveImportRegion({ ...row, timezone: "America/Los_Angeles" }, at).today, "2026-10-31");
});

test("unsupported or inconsistent region never falls back to TW", () => {
  for (const changed of [{ country_code: "US" }, { jurisdiction_id: null }, { jurisdiction_code: "US-CA" },
    { jurisdiction_country: "US" }, { default_currency: "USD" }, { timezone: "unavailable/zone" }]) {
    assert.throws(() => resolveImportRegion({ ...row, ...changed }), /im_region_unavailable/);
  }
});
