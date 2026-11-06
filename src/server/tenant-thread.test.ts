import assert from "node:assert/strict";
import test from "node:test";
import { tenantThreadCreateOn } from "./tenant-thread";

const ORG = "11111111-1111-4111-8111-111111111111";
test("flag needs strict true global, allowlist and org flag", () => {
  assert.equal(tenantThreadCreateOn({ enabled: true, allowed_org_ids: [ORG] }, { tenant_thread_create: true }, ORG), true);
  assert.equal(tenantThreadCreateOn({ enabled: "true", allowed_org_ids: [ORG] }, { tenant_thread_create: true }, ORG), false);
  assert.equal(tenantThreadCreateOn({ enabled: true, allowed_org_ids: [] }, { tenant_thread_create: true }, ORG), false);
  assert.equal(tenantThreadCreateOn({ enabled: true, allowed_org_ids: [ORG] }, { tenant_thread_create: 1 }, ORG), false);
  assert.equal(tenantThreadCreateOn(null, null, ORG), false);
});
