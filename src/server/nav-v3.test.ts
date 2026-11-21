import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MANAGER_AREAS_V3, NO_AREA_PATHS_V3, areasFor, tabsFor, areaForPath, crumbFor, navLabel, pathWithin, roleHomeV3, landingV3 } from "./nav-v3";
import { can, noPermHref, type PermKey } from "./perms";
import type { Session, OrgRole } from "./types";

export const staff = (role: OrgRole): Session => ({
  kind: "staff", role, orgId: "org", liveOrgId: "org", userId: "user", sessionId: "session",
  name: "陳小明", email: "fixture@example.invalid", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null,
});
const ids = (items: readonly { id: string }[]) => items.map(item => item.id);
const labels = (items: readonly { key: string }[]) => items.map(item => navLabel(item.key, "zh-TW"));
const propertyLinks = ["/m/properties", "/m/units", "/m/tenants", "/m/owners", "/m/archive"];
const moneyLinks = ["/m/rent", "/m/payments", "/m/bank", "/m/statements", "/m/expenses", "/m/reports", "/m/close"];
const settingsLinks = ["/m/settings", "/m/team", "/m/roles", "/m/notify", "/m/audit", "/m/upgrade", "/m/import", "/m/account"];

for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
  test(`MGT-47-AC1/AC3/AC4, MGT-48-AC5, MGT-49-AC5: ${role} exact areas, sub-links and tabs`, () => {
    const areas = areasFor(staff(role));
    const expectedAreas = role === "maintenance" ? ["maintenance", "settings"]
      : role === "accountant" ? ["today", "properties", "leases", "money", "maintenance", "settings"]
      : ["today", "messages", "properties", "leases", "money", "maintenance", "settings"];
    assert.deepEqual(ids(areas), expectedAreas);
    const expectedLinks = role === "maintenance" ? { settings: ["/m/account"] } : {
      properties: propertyLinks,
      money: role === "manager" ? moneyLinks.filter(href => !["/m/bank", "/m/close"].includes(href)) : moneyLinks,
      settings: role === "admin" ? settingsLinks : role === "manager" ? ["/m/notify", "/m/import", "/m/account"] : ["/m/account"],
    };
    assert.deepEqual(Object.fromEntries(areas.filter(area => area.links.length).map(area => [area.id, area.links.map(item => item.href)])), expectedLinks);
    const expectedTabs = role === "maintenance" ? ["維修", "設定"] : role === "accountant"
      ? ["今天", "物件與租客", "租約", "收款", "更多"] : ["今天", "訊息", "物件與租客", "租約", "更多"];
    assert.deepEqual(labels(tabsFor(staff(role))), expectedTabs);
    assert.ok(tabsFor(staff(role)).some(tab => tab.id === areaForPath(roleHomeV3("staff", role))?.id));
    for (const area of areas) if (area.links.length) assert.equal(area.href, area.links[0].href);
  });
}

test("MGT-47-AC5: every actual manager page maps exactly once, or is explicitly excluded", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  const routes = walk("src/app/m").filter(file => file.endsWith("/page.tsx")).map(file => file.slice("src/app".length, -"/page.tsx".length));
  assert.ok(routes.length >= 54);
  for (const route of routes) {
    if (NO_AREA_PATHS_V3.includes(route as typeof NO_AREA_PATHS_V3[number])) { assert.equal(areaForPath(route), null); continue; }
    const matches = MANAGER_AREAS_V3.filter(area => {
      if (route === "/m/notifications") return area.id === "today";
      if (route.startsWith("/m/handover/")) return area.id === "leases";
      if (route.startsWith("/m/rooms/")) return area.id === "properties";
      return area.links.length ? area.links.some(link => pathWithin(route, link.href)) : pathWithin(route, area.href);
    });
    assert.equal(matches.length, 1, route);
    assert.equal(areaForPath(route)?.id, matches[0].id, route);
  }
  for (const path of ["/m/import", "/m/account", "/m/roles", "/m/upgrade"]) assert.equal(areaForPath(path)?.id, "settings");
  assert.equal(areaForPath("/m/notifications")?.id, "today");
  assert.equal(areaForPath("/m/handover/lease")?.id, "leases");
  assert.equal(areaForPath("/m/rooms/r1/invite/print")?.id, "properties");
  assert.equal(areaForPath("/m/units/u1/room-invites")?.id, "properties");
  assert.equal(areaForPath("/m/payments-extra"), null);
});

test("MGT-47-AC4/AC7: custom sessions filter area and sub-link grants and hide empty areas", () => {
  const session = staff("admin");
  session.customRole = { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId,
    nativeRole: "admin", keys: ["stmt.view", "pay.record"], audit: false, photos: false } as Session["customRole"];
  assert.deepEqual(ids(areasFor(session)), ["money", "settings"]);
  assert.deepEqual(areasFor(session)[0].links.map(link => link.href), ["/m/rent", "/m/payments", "/m/statements", "/m/reports"]);
  assert.deepEqual(areasFor(session)[1].links.map(link => link.href), ["/m/account"]);
  for (const area of areasFor(session)) for (const item of [area, ...area.links]) {
    if (item.perm !== "any" && item.perm !== "admin") assert.ok(can(session, item.perm as PermKey));
  }
  session.customRole!.keys = ["tickets.update"];
  assert.deepEqual(ids(areasFor(session)), ["maintenance", "settings"]);
  session.customRole!.orgId = "other";
  assert.deepEqual(ids(areasFor(session)), ["settings"]);
  assert.deepEqual(areasFor({ ...staff("admin"), kind: "tenant" }), []);
});

test("MGT-47-AC4/AC5, PLT-44-AC15: own area and approved sub-page crumbs", () => {
  const admin = staff("admin");
  for (const [path, expected] of [
    ["/m", ["今天"]], ["/m/messages", ["訊息"]], ["/m/leases", ["租約"]], ["/m/tickets", ["維修"]],
    ["/m/properties", ["物件與租客"]], ["/m/units", ["物件與租客", "單位與房間"]],
    ["/m/payments?filter=x", ["收款", "待確認繳款"]], ["/m/rent", ["收款"]], ["/m/more", ["更多"]],
  ] as const) assert.deepEqual(crumbFor(path, admin), expected);
  // R5-NOTIFY (MGT-135-AC1): a manager's settings area now opens on 通知設定, so 資料匯入 is a named sub-page.
  assert.deepEqual(crumbFor("/m/import", staff("manager")), ["設定", "資料匯入"]);
  assert.deepEqual(crumbFor("/m/notify", staff("manager")), ["設定", "通知設定"]);
  assert.equal(areasFor(staff("manager")).find(area => area.id === "settings")?.href, "/m/notify");
  // MGT-138 / R5-OWNVIEW frame: 「設定 › 規則與資料」 on the settings area's own first page.
  assert.deepEqual(crumbFor("/m/settings", admin), ["設定", "規則與資料"]);
  assert.deepEqual(crumbFor("/m/notify", admin), ["設定", "通知設定"]);
  assert.deepEqual(crumbFor("/m/bank", staff("manager")), ["收款"]);
  assert.deepEqual(crumbFor("/m/noperm", admin), []);
});

test("MGT-47-AC3: archive list and upgrade are not hidden by write-only feature gates", () => {
  assert.ok(areasFor(staff("admin")).flatMap(area => area.links).some(item => item.href === "/m/archive"));
  const archive = readFileSync("src/server/record-archive.ts", "utf8").split("export async function archiveList")[1].split("export async function archiveCommand")[0];
  assert.doesNotMatch(archive, /await enabled\(/);
  assert.doesNotMatch(readFileSync("src/app/m/upgrade/page.tsx", "utf8"), /notFound/);
  const custom = staff("admin");
  custom.customRole = { orgId: custom.orgId, userId: custom.userId, sessionId: custom.sessionId, nativeRole: "admin", keys: ["props.view"], photos: false, audit: false };
  assert.ok(!areasFor(custom).flatMap(area => area.links).some(item => item.href === "/m/archive"));
  custom.customRole.keys = ["props.view", "props.edit"];
  assert.ok(areasFor(custom).flatMap(area => area.links).some(item => item.href === "/m/archive"));
});

test("MGT-48-AC5 / MGT-49-AC5: all role landings", () => {
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    assert.equal(roleHomeV3("staff", role), role === "accountant" ? "/m/payments" : role === "maintenance" ? "/m/tickets" : "/m");
    assert.equal(roleHomeV3("tenant", role), "/t"); assert.equal(roleHomeV3("owner", role), "/o");
  }
});

const custom = (role: OrgRole, keys: PermKey[]) => {
  const session = staff(role);
  session.customRole = { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId,
    nativeRole: role, keys, audit: false, photos: false } as Session["customRole"];
  return session;
};

test("MGT-48-AC5 / MGT-49-AC5 / MGT-47-AC7: the landing is always a page the effective session can open", () => {
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    assert.equal(landingV3(staff(role)), roleHomeV3("staff", role));
    assert.equal(noPermHref(landingV3(staff(role)), staff(role)), null);
  }
  // An admin restricted to money keys must not land on 今天 (dash.view) and loop back to /m/noperm.
  const money = custom("admin", ["stmt.view", "pay.record"]);
  assert.notEqual(noPermHref("/m", money), null);
  assert.equal(landingV3(money), "/m/rent");
  // An accountant without pay.record must not land on /m/payments.
  const acct = custom("accountant", ["stmt.view"]);
  assert.equal(landingV3(acct), "/m/rent");
  // A maintenance custom role without tickets.update falls through to an always-open page.
  const maint = custom("maintenance", []);
  assert.equal(landingV3(maint), "/m/account");
  for (const s of [money, acct, maint]) assert.equal(noPermHref(landingV3(s), s), null);
  assert.equal(landingV3({ ...staff("admin"), kind: "tenant" }), "/t");
});

test("MGT-47-AC7: 角色權限 shows only when the page admits the session (team.manage and settings.edit)", () => {
  const hrefs = (s: Session) => areasFor(s).flatMap(area => area.links.map(item => item.href));
  assert.ok(hrefs(staff("admin")).includes("/m/roles"));
  assert.ok(!hrefs(custom("admin", ["team.manage"])).includes("/m/roles"));
  assert.ok(hrefs(custom("admin", ["team.manage", "settings.edit"])).includes("/m/roles"));
});
