import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { admitTenantReport, unreportedRest } from "./b087-report-guard";

test("B-087 rest = open balance minus pending, never negative", () => {
  assert.equal(unreportedRest(100000, 0), 100000);
  assert.equal(unreportedRest(100000, 60000), 40000);
  assert.equal(unreportedRest(100000, 100000), 0);
  assert.equal(unreportedRest(40000, 100000), 0);
});

test("B-087 admits only amounts within the rest, and nothing when the rest is zero", () => {
  assert.equal(admitTenantReport(40000, 100000, 60000), "ok");
  assert.equal(admitTenantReport(40001, 100000, 60000), "over_unreported");
  assert.equal(admitTenantReport(1, 100000, 100000), "over_unreported");
  assert.equal(admitTenantReport(1, 0, 0), "over_unreported");
  assert.equal(admitTenantReport(100000, 100000, 0), "ok");
});

test("B-087 is wired into the tenant report path only, after the legacy ceiling and before the insert", () => {
  const src = readFileSync("src/server/domain.ts", "utf8");
  const start = src.indexOf("export async function recordPayment(");
  const tenantBranch = src.slice(start, src.indexOf('assertStaff(session, ["admin", "manager", "accountant"], "pay.record");', start));
  const legacy = tenantBranch.indexOf('if (amount > balance) throw new FlowError("errors.amountTooHigh");');
  const guard = tenantBranch.indexOf("if (await b087Enabled(client, lease.org_id)) await assertWithinUnreported(client, lease.org_id, input.leaseId, amount);");
  const insert = tenantBranch.indexOf("INSERT INTO payments");
  assert.ok(legacy > 0 && guard > legacy && insert > guard);
  assert.equal(src.split("assertWithinUnreported(").length - 1, 1);
});

test("B-087 copy: zh-TW matches TEN-53-AC4 and never says 收款 or 入帳", () => {
  const zh = JSON.parse(readFileSync("src/i18n/zh-TW.json", "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, string>;
  assert.equal(zh.i_amount_over_unreported, "金額超過還沒回報的部分。");
  assert.doesNotMatch(zh.i_amount_over_unreported, /收款|入帳/);
  assert.ok(en.i_amount_over_unreported);
  assert.match(readFileSync("src/i18n/errors.ts", "utf8"), /"errors\.amountOverUnreported": "i_amount_over_unreported"/);
});
