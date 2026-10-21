import assert from "node:assert/strict";
import test from "node:test";
import { activeTenantPick, filterTenants, type TenantOption } from "./tenant-pick";

const tenants: TenantOption[] = [
  { id: "1", name: "王小美", phone: "+886912111002", email: "xiaomei.wang@tenant.demo" },
  { id: "2", name: "張雅文", phone: "+886912111001", email: "yawen.zhang@tenant.demo" },
  { id: "3", name: "Alex Kim", phone: "+14155550199", email: "alex.kim@tenant.demo" },
];

test("tenant search matches name, email, and a Taiwan mobile with or without +886", () => {
  assert.deepEqual(filterTenants(tenants, "").map((row) => row.id), ["1", "2", "3"]);
  assert.deepEqual(filterTenants(tenants, "  小美 ").map((row) => row.id), ["1"]);
  assert.deepEqual(filterTenants(tenants, "YAWEN").map((row) => row.id), ["2"]);
  assert.deepEqual(filterTenants(tenants, "+886912111002").map((row) => row.id), ["1"]);
  assert.deepEqual(filterTenants(tenants, "0912-111-002").map((row) => row.id), ["1"]);
  assert.deepEqual(filterTenants(tenants, "4155550199").map((row) => row.id), ["3"]);
  assert.deepEqual(filterTenants(tenants, "沒有這個人"), []);
});

test("a pick is kept only while that tenant is still in the filtered list", () => {
  assert.equal(activeTenantPick("1", filterTenants(tenants, "小美")), "1");
  assert.equal(activeTenantPick("1", filterTenants(tenants, "沒有這個人")), "");
  assert.equal(activeTenantPick("", filterTenants(tenants, "")), "");
  assert.equal(activeTenantPick("1", filterTenants(tenants, "")), "1");
});
