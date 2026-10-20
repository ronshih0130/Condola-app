import assert from "node:assert/strict";
import test from "node:test";
import { maskTenantNames, privacyFromSettings } from "./privacy";

test("owner privacy defaults to names on and phones off", () => {
  assert.deepEqual(privacyFromSettings(null), { showName: true, showPhone: false });
  assert.deepEqual(privacyFromSettings({}), { showName: true, showPhone: false });
  assert.deepEqual(privacyFromSettings({ show_tenant_name: false, show_tenant_phone: true }), {
    showName: false,
    showPhone: true,
  });
});

test("hiding names replaces tenant names and leaves the rest of the line", () => {
  const masked = maskTenantNames("租金 王小美 3F", ["王小美", "王"], "租客（已隱藏）");
  assert.equal(masked, "租金 租客（已隱藏） 3F");
});
