import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { RepairPhotos } from "@/components/repair-photos";
import { makeT } from "@/i18n";
import { loadAuditHistory, loadAuditScreen } from "./audit-read";
import { PERMS, ROLE_KEYS, can, navCount, noPermHref, roleHome, visibleNav, type PermKey } from "./perms";
import type { OrgRole, Session } from "./types";

// Literal oracle transcribed from d374bb695d0e97fad72d00449d6a57450a61a9b1,
// never derived from the current PERMS allowlists. Columns: Admin/Manager/Accountant/Maintenance/null.
const BASELINE: ReadonlyArray<readonly [PermKey, readonly boolean[]]> = [
  ["dash.view",       [true, true, true, false, false]],
  ["props.view",      [true, true, true, false, false]],
  ["props.edit",      [true, true, false, false, false]],
  ["leases.edit",     [true, true, false, false, false]],
  ["tenants.contact", [true, true, false, true, false]],
  ["pay.record",      [true, true, true, false, false]],
  ["pay.reverse",     [true, false, true, false, false]],
  ["bank.reconcile",  [true, false, true, false, false]],
  ["stmt.view",       [true, true, true, false, false]],
  ["stmt.generate",   [true, false, true, false, false]],
  ["exp.add",         [true, true, true, false, false]],
  ["month.close",     [true, false, true, false, false]],
  ["tickets.update",  [true, true, false, true, false]],
  ["messages.send",   [true, true, false, false, false]],
  ["reports.export",  [true, true, true, false, false]],
  ["team.manage",     [true, false, false, false, false]],
  ["settings.edit",   [true, false, false, false, false]],
  ["data.export",     [true, false, false, false, false]],
];
const ROLES = ["admin", "manager", "accountant", "maintenance", null] as const;
test("native/OFF baseline pins all four roles and all 18 recognized keys", () => {
  assert.deepEqual(ROLE_KEYS, ROLES.slice(0, 4));
  assert.deepEqual(PERMS.map(([key]) => key), BASELINE.map(([key]) => key));
});
for (const [key, expected] of BASELINE) {
  ROLES.forEach((role, column) => {
    test(`d374bb6 native/OFF ${role ?? "null"} ${key} = ${expected[column]}`, () => {
      assert.equal(can(role, key), expected[column]);
    });
  });
}

const NAV: Record<OrgRole, string[]> = {
  admin: ["/m", "/m/properties", "/m/owners", "/m/units", "/m/tenants", "/m/leases", "/m/rent", "/m/payments", "/m/bank", "/m/statements", "/m/expenses", "/m/reports", "/m/close", "/m/tickets", "/m/messages", "/m/team", "/m/audit", "/m/notify", "/m/settings"],
  manager: ["/m", "/m/properties", "/m/owners", "/m/units", "/m/tenants", "/m/leases", "/m/rent", "/m/payments", "/m/statements", "/m/expenses", "/m/reports", "/m/tickets", "/m/messages"],
  accountant: ["/m", "/m/properties", "/m/owners", "/m/units", "/m/tenants", "/m/leases", "/m/rent", "/m/payments", "/m/bank", "/m/statements", "/m/expenses", "/m/reports", "/m/close", "/m/tickets"],
  maintenance: ["/m/tickets"],
};
for (const role of ROLES) {
  test(`d374bb6 navigation destinations and native-Admin audit boundary: ${role}`, () => {
    const destinations = role ? NAV[role] : [];
    assert.deepEqual(visibleNav(role).flatMap((section) => section.links.map((link) => link.href)), destinations);
    assert.equal(navCount(role), destinations.length);
    assert.equal(roleHome("staff", role), role === "maintenance" || role === null ? "/m/tickets" : "/m");
    assert.equal(roleHome("tenant", role), "/t");
    assert.equal(roleHome("owner", role), "/o");
    for (const pathname of ["/m/audit", "/m/audit?cursor=x", "/m/audit/detail"]) {
      assert.equal(noPermHref(pathname, role), role === "admin" ? null : "/m/noperm?need=admin");
    }
    const routes: Array<[string, PermKey]> = [
      ["/m", "dash.view"], ["/m/properties", "props.view"], ["/m/properties/new", "props.edit"],
      ["/m/properties/p/edit", "props.edit"], ["/m/owners/o", "props.edit"],
      ["/m/leases/new", "leases.edit"], ["/m/bank", "bank.reconcile"],
      ["/m/payments", "pay.record"], ["/m/close", "month.close"], ["/m/team", "team.manage"],
      ["/m/settings", "settings.edit"], ["/m/reports", "reports.export"],
    ];
    for (const [pathname, key] of routes) {
      const allowed = BASELINE.find(([pinned]) => pinned === key)![1][ROLES.indexOf(role)];
      assert.equal(noPermHref(pathname, role), allowed ? null : `/m/noperm?need=${key}`);
    }
  });
}

for (const role of ["manager", "accountant", "maintenance", null] as const) {
  test(`native company audit readers return no records for ${role} without querying DB`, async () => {
    const session: Session = {
      userId: "00000000-0000-4000-8000-000000000001", sessionId: "session", orgId: "org", liveOrgId: "org",
      email: "test@example.invalid", name: "Fixture", kind: "staff", role,
      environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null,
    };
    const screen = await loadAuditScreen(session, {});
    assert.deepEqual(screen.entries, []);
    assert.deepEqual(screen.actors, []);
    assert.equal(screen.hasMore, false);
    assert.deepEqual(await loadAuditHistory(session, "properties", "00000000-0000-4000-8000-000000000002"), { entries: [], hasMore: false });
  });
}

test("Accountant photo DTO rendering exposes no public/internal filename, ID, URL or action", () => {
  const photos = [
    { id: "public-photo-id", name: "public-private-name.jpg", internal: false },
    { id: "internal-photo-id", name: "internal-private-name.jpg", internal: true },
  ];
  const html = renderToStaticMarkup(React.createElement(RepairPhotos, { photos, canView: can("accountant", "tickets.update"), t: makeT("zh-TW") }));
  assert.match(html, /repair-photo-noperm/);
  assert.doesNotMatch(html, /<img\b|<a\b|<button\b|<input\b|<form\b|\bsrc=|\bhref=|\/api\/tickets\/photos/);
  for (const photo of photos) {
    assert.equal(html.includes(photo.id), false);
    assert.equal(html.includes(photo.name), false);
  }
  // Positive control: the same DTO reaches images/links/names for the native Admin.
  const admin = renderToStaticMarkup(React.createElement(RepairPhotos, { photos, canView: can("admin", "tickets.update"), t: makeT("zh-TW") }));
  for (const photo of photos) {
    assert.ok(admin.includes(`/api/tickets/photos/${photo.id}`));
    assert.ok(admin.includes(photo.name));
  }
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}

test("B-017 preparation is disconnected from app/server runtime imports, including barrels and dynamic imports", () => {
  const policy = path.resolve("src/server/b017-custom-role-policy.ts");
  const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  assert.equal(config.error, undefined);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const cache = ts.createModuleResolutionCache(process.cwd(), (file) => file, options);
  const violations: string[] = [];
  // Scan ALL production src, stronger than just app/server: a component/lib barrel
  // importing the policy would otherwise create an indirect runtime dependency.
  for (const file of sourceFiles("src")) {
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || path.resolve(file) === policy) continue;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      let specifier: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
      if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
        const resolved = ts.resolveModuleName(specifier.text, path.resolve(file), options, ts.sys, cache).resolvedModule?.resolvedFileName;
        if ((resolved && path.resolve(resolved) === policy) || /b017-(custom-role-policy|legacy-compat)/.test(specifier.text)) {
          violations.push(`${file}: ${specifier.text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(violations, [], "preparation modules must have no production importers");
});
