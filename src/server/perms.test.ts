import assert from "node:assert/strict";
import test from "node:test";
import { totpCode, verifyTotp } from "./totp";
import { PERMS, ROLE_KEYS, can, navCount, visibleNav } from "./perms";

test("permission matrix matches the prototype table", () => {
  assert.equal(PERMS.length, 18);
  assert.deepEqual(ROLE_KEYS, ["admin", "manager", "accountant", "maintenance"]);
  assert.equal(can("manager", "exp.add"), true);
  assert.equal(can("manager", "stmt.generate"), false);
  assert.equal(can("manager", "pay.reverse"), false);
  assert.equal(can("manager", "month.close"), false);
  assert.equal(can("accountant", "stmt.generate"), true);
  assert.equal(can("accountant", "pay.reverse"), true);
  assert.equal(can("accountant", "month.close"), true);
  assert.equal(can("accountant", "tenants.contact"), false);
  assert.equal(can("maintenance", "tenants.contact"), true);
  assert.equal(can("admin", "team.manage"), true);
  assert.equal(can("maintenance", "dash.view"), false);
});

test("navigation follows the matrix", () => {
  assert.equal(navCount("admin"), 15);
  const accountant = visibleNav("accountant").flatMap((section) => section.links.map((link) => link.href));
  assert.ok(accountant.includes("/m/bank"));
  assert.ok(accountant.includes("/m/close"));
  assert.ok(!accountant.includes("/m/team"));
  assert.ok(!accountant.includes("/m/settings"));
  assert.ok(!accountant.includes("/m/messages"));
  assert.deepEqual(
    visibleNav("maintenance").flatMap((section) => section.links.map((link) => link.href)),
    ["/m/tickets"],
  );
});

test("totp accepts the current code and rejects a wrong one", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const at = Date.parse("2026-10-20T08:00:00Z");
  const code = totpCode(secret, at);
  assert.equal(verifyTotp(secret, code, at), true);
  assert.equal(verifyTotp(secret, "000000", at), code === "000000");
  assert.equal(verifyTotp(secret, "123456", at), code === "123456");
});
