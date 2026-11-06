import assert from "node:assert/strict";
import test from "node:test";
import { readLineConfig } from "./config";

test("env kill is strict; guard protection always on, sending requires explicit true or documented ON", () => {
  for (const raw of [undefined, "false", "TRUE", "1", "on", "", " true ", "malformed"]) {
    const c = readLineConfig({ LINE_PLATFORM_ENABLED: raw, LINE_PUSH_QUOTA_GUARD: raw });
    assert.equal(c.platformEnabled, false);
    assert.equal(c.guardEnabled, true);
    assert.equal(c.guardReady, false);
  }
  for (const guard of ["true", "ON"]) assert.equal(readLineConfig({ LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: guard }).guardReady, true);
});
test("monthly limit defaults only when absent; malformed and above 180 fail closed", () => {
  const env = { LINE_PUSH_QUOTA_GUARD: "true" };
  assert.equal(readLineConfig(env).monthlyLimit, 180);
  assert.equal(readLineConfig(env).guardReady, true);
  for (const raw of ["", "0", "181", "200", "201", "-1", "1.5", "1e2", " 180 ", "Infinity", "x"]) {
    const config = readLineConfig({ ...env, LINE_PUSH_MONTHLY_LIMIT: raw });
    assert.equal(config.monthlyLimit, null);
    assert.equal(config.guardReady, false);
  }
  for (const n of [1, 179, 180]) {
    const config = readLineConfig({ ...env, LINE_PUSH_MONTHLY_LIMIT: String(n) });
    assert.equal(config.monthlyLimit, n);
    assert.equal(config.guardReady, true);
  }
});
