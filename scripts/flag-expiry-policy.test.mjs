import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { evaluateFlags, WARN_DAYS } = require("./flag-expiry-policy.cjs");
const yaml = require("yaml");
const at = (iso) => Date.parse(iso);
const flag = (expires_at, extra = {}) => ({ owner: "Ron", default: false, expires_at, ...extra });

test("B-027 policy: ok > 7 days, warn within 7 days, fail when expired", () => {
  const e = [["a", flag("2026-11-20T18:00:00-08:00 PT (America/Los_Angeles)")], ["b", flag("2026-11-10T18:00:00-08:00 PT (America/Los_Angeles)")]];
  assert.equal(WARN_DAYS, 7);
  let r = evaluateFlags(e, at("2026-11-01T00:00:00-07:00"));
  assert.deepEqual([r.failures.length, r.warnings.length], [0, 0]);
  r = evaluateFlags(e, at("2026-11-06T03:00:00-08:00"));
  assert.deepEqual(r.failures, []); assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /^b: expires within 7 days/);
  r = evaluateFlags(e, at("2026-11-10T18:00:00-08:00"));
  assert.deepEqual(r.failures, ["b: expired"]);
});

test("B-027 policy: malformed records and stable GA rules fail", () => {
  const now = at("2026-11-06T03:00:00-08:00");
  assert.match(evaluateFlags([["x", { default: false, expires_at: "2026-12-01T00:00:00-08:00 PT (America/Los_Angeles)" }]], now).failures[0], /owner required/);
  assert.match(evaluateFlags([["x", flag("2026-12-01T00:00:00Z")]], now).failures[0], /explicit offset/);
  assert.match(evaluateFlags([["x", flag("2026-12-01T00:00:00-07:00 PT (America/Los_Angeles)")]], now).failures[0], /offset is wrong/);
  assert.match(evaluateFlags([["x", flag("2027-01-01T00:00:00-08:00 PT (America/Los_Angeles)", { stable_ga_at: "2026-10-01T00:00:00-07:00 PT (America/Los_Angeles)" })]], now).failures[0], /14 days of stable GA/);
  assert.match(evaluateFlags([["x", flag("2027-01-01T00:00:00-08:00 PT (America/Los_Angeles)")], ["x", flag("2027-01-01T00:00:00-08:00 PT (America/Los_Angeles)")]], now).failures[0], /unique/);
});

test("the committed ops/flags.yaml is structurally valid under the policy (fixed clock 2026-11-06 PT)", () => {
  const doc = yaml.parse(readFileSync(new URL("../ops/flags.yaml", import.meta.url), "utf8"), { uniqueKeys: true });
  const entries = Array.isArray(doc.flags) ? doc.flags.map((x) => [x?.name, x]) : Object.entries(doc.flags);
  assert.deepEqual(evaluateFlags(entries, at("2026-11-06T00:00:00-08:00")).failures, []);
});

test("exact boundaries: 7-day warning and 14-day stable-GA removal", () => {
  const exp = "2026-11-20T00:00:00-08:00 PT (America/Los_Angeles)", expAt = at("2026-11-20T00:00:00-08:00"), DAY = 86400000;
  const warn = (now) => evaluateFlags([["x", flag(exp)]], now).warnings.length;
  assert.equal(warn(expAt - 7 * DAY - 1), 0);
  assert.equal(warn(expAt - 7 * DAY), 1);
  assert.equal(warn(expAt - 1), 1);
  assert.deepEqual(evaluateFlags([["x", flag(exp)]], expAt).failures, ["x: expired"]);
  const ga = "2026-11-01T00:00:00-07:00 PT (America/Los_Angeles)", gaAt = at("2026-11-01T00:00:00-07:00");
  const gaFail = (now) => evaluateFlags([["x", flag("2027-06-01T00:00:00-07:00 PT (America/Los_Angeles)", { stable_ga_at: ga })]], now).failures;
  assert.deepEqual(gaFail(gaAt + 14 * DAY - 1), []);
  assert.match(gaFail(gaAt + 14 * DAY)[0], /14 days of stable GA/);
  assert.match(gaFail(gaAt - 1)[0], /cannot be in the future/);
});
