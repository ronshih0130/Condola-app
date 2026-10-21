import assert from "node:assert/strict";
import test from "node:test";
import { totpCode, verifyTotp } from "./totp";
import { PERMS, ROLE_KEYS, can, navCount, noPermHref, permForPath, requiresAdmin, visibleNav } from "./perms";

test("permission matrix matches the prototype table", () => {
  assert.equal(PERMS.length, 18);
  assert.deepEqual(ROLE_KEYS, ["admin", "manager", "accountant", "maintenance"]);
  assert.equal(can("manager", "exp.add"), true);
  assert.equal(can("accountant", "exp.add"), true);
  assert.equal(can("maintenance", "exp.add"), false);
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
  assert.equal(navCount("admin"), 19);
  const accountant = visibleNav("accountant").flatMap((section) => section.links.map((link) => link.href));
  assert.ok(accountant.includes("/m/tickets"));
  assert.ok(accountant.includes("/m/bank"));
  assert.ok(accountant.includes("/m/close"));
  assert.ok(accountant.includes("/m/expenses"));
  assert.ok(accountant.includes("/m/reports"));
  assert.ok(accountant.includes("/m/owners"));
  assert.ok(!accountant.includes("/m/team"));
  assert.ok(!accountant.includes("/m/settings"));
  assert.ok(!accountant.includes("/m/messages"));
  assert.deepEqual(
    visibleNav("maintenance").flatMap((section) => section.links.map((link) => link.href)),
    ["/m/tickets"],
  );
  assert.equal(permForPath("/m/owners"), "props.view");
  assert.equal(permForPath("/m/owners/new"), "props.edit");
  assert.equal(permForPath("/m/owners/abc"), "props.edit");
  assert.equal(permForPath("/m/units/new"), "props.edit");
  assert.equal(permForPath("/m/units/room/abc"), "props.edit");
  assert.equal(permForPath("/m/units/whole/abc"), "props.edit");
  assert.equal(permForPath("/m/units"), "props.view");
  assert.equal(permForPath("/m/properties/abc/edit"), "props.edit");
  assert.equal(permForPath("/m/properties/abc"), "props.view");
  assert.ok(visibleNav("admin").flatMap((section) => section.links.map((link) => link.href)).includes("/m/audit"));
  assert.ok(!accountant.includes("/m/audit"));
  assert.equal(requiresAdmin("/m/audit"), true);
  assert.equal(requiresAdmin("/m/audit?user=1"), true);
  assert.equal(requiresAdmin("/m/leases"), false);
  assert.equal(permForPath("/m/audit"), null);
  assert.equal(noPermHref("/m/audit", "manager"), "/m/noperm?need=admin");
  assert.equal(noPermHref("/m/audit", "accountant"), "/m/noperm?need=admin");
  assert.equal(noPermHref("/m/audit", "maintenance"), "/m/noperm?need=admin");
  assert.equal(noPermHref("/m/audit", "admin"), null);
  assert.equal(noPermHref("/m/settings", "manager"), "/m/noperm?need=settings.edit");
  assert.equal(noPermHref("/m/owners/new", "accountant"), "/m/noperm?need=props.edit");
  assert.equal(noPermHref("/m/leases", "manager"), null);
  assert.equal(permForPath("/m/tenants/abc"), "props.view");
  assert.equal(permForPath("/m/expenses"), "exp.add");
  assert.equal(permForPath("/m/expenses/new"), "exp.add");
  assert.equal(permForPath("/m/expenses/abc"), "exp.add");
  assert.equal(permForPath("/m/reports"), "reports.export");
  assert.equal(permForPath("/m/reports/export"), "reports.export");
  assert.equal(can("accountant", "reports.export"), true);
  assert.equal(can("maintenance", "reports.export"), false);
  assert.equal(permForPath("/m/tickets"), null);
  assert.equal(permForPath("/m/tickets/1"), null);
  assert.equal(can("accountant", "tickets.update"), false);
  assert.equal(can("maintenance", "tickets.update"), true);
  assert.equal(can("admin", "tickets.update"), true);
  assert.equal(can("manager", "tickets.update"), true);
});

test("totp accepts the current code and rejects a wrong one", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const at = Date.parse("2026-10-20T08:00:00Z");
  const code = totpCode(secret, at);
  assert.equal(verifyTotp(secret, code, at), true);
  assert.equal(verifyTotp(secret, "000000", at), code === "000000");
  assert.equal(verifyTotp(secret, "123456", at), code === "123456");
});
