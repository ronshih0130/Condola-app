import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve("src");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const paths = files(root).filter((path) => /\.tsx?$/.test(path));
const program = ts.createProgram(paths, {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
  baseUrl: resolve("."), paths: { "@/*": ["src/*"] },
});
const checker = program.getTypeChecker();
const openActions: Record<string, Record<string, string>> = {
  "server/auth-actions.ts": {
    actionSignIn: "Establish identity", actionLineLogin: "Establish identity",
    actionSecondFactor: "Complete authentication", actionForgot: "Recover identity",
    actionReset: "Recover identity", actionAccept: "Invitation acceptance has its own consent check",
    actionDescribeTeamJoin: "Public invitation description, no user session required",
    actionAcceptTeamJoin: "Invitation acceptance has its own consent check",
    actionRevokeSession: "Terminate sessions", actionRevokeOthers: "Terminate sessions",
    actionClearBackup: "Clear recovery cookie", actionSignOut: "Always permit leaving",
  },
  "server/signup-actions.ts": {
    actionPreviewCode: "Public signup", actionStartSignup: "Public signup",
    actionResendSignup: "Verify identity", actionChangeSignupEmail: "Verify identity",
    actionConfirmToken: "Verify identity", actionConfirmSupabaseHash: "Verify identity",
    actionConfirmSupabase: "Verify identity", actionCreateFirm: "createFirm checks acceptance",
  },
  "server/actions.ts": {
    actionVendorReport: "Vendor link token, no user session",
  },
  "server/consent-actions.ts": {
    actionAcceptReconsent: "Record acceptance", actionAcceptPortalConsent: "Record acceptance",
  },
};
const openRoutes: Record<string, Record<string, string>> = {
  "api/auth/enter/route.ts": { GET: "Authentication continuation checks consent" },
  "api/auth/sign-out/route.ts": { POST: "Always permit leaving" },
  "api/cron/reminders/route.ts": { POST: "Cron secret, no human identity" },
  "api/cron/purge-id-documents/route.ts": { POST: "Retention must continue" },
  "api/demo/locale/route.ts": { GET: "Public preference" },
  "api/demo/mode/route.ts": { GET: "Removed, always 404" },
  "api/demo/persona/route.ts": { GET: "Removed, always 404" },
  "api/demo/tryout/route.ts": { GET: "Public preference" },
  "api/vendor-jobs/[token]/photos/[id]/route.ts": { GET: "Vendor link token authentication, no user session" },
  "api/vendor-jobs/photos/sign/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/vendor-jobs/photos/confirm/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/reset-flash/route.ts": { POST: "Recovery feedback cookie" },
  "api/version/route.ts": { GET: "Public version" },
};
function directive(node: ts.Node) {
  return ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression)
    && node.expression.text === "use server";
}
function nodes(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  function visit(child: ts.Node) {
    result.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return result;
}
function unalias(symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function isGuard(call: ts.CallExpression) {
  const symbol = checker.getSymbolAtLocation(call.expression);
  if (!symbol) return false;
  const target = unalias(symbol);
  return target.name === "requireCurrentConsent"
    && target.declarations?.some((d) => d.getSourceFile().fileName.endsWith("/server/consent-gate.ts"));
}
function bodyOf(symbol: ts.Symbol) {
  const declaration = unalias(symbol).valueDeclaration;
  if (declaration && ts.isFunctionDeclaration(declaration)) return declaration.body;
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const init = declaration.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init.body;
  }
  assert.fail("Unclassified runtime export: " + symbol.name);
}
function guarded(body: ts.Node, route: boolean, label: string) {
  const all = nodes(body);
  const guard = all.find((node): node is ts.CallExpression => ts.isCallExpression(node) && !!isGuard(node));
  assert.ok(guard, label + ": missing guard");
  assert.ok(ts.isAwaitExpression(guard.parent), label + ": guard must be awaited");
  // A guard hidden in a branch, callback or catch cannot dominate the handler.
  for (let parent: ts.Node = guard.parent; parent !== body; parent = parent.parent) {
    assert.ok(!ts.isIfStatement(parent) && !ts.isConditionalExpression(parent)
      && !ts.isFunctionLike(parent) && !ts.isCatchClause(parent)
      && !ts.isIterationStatement(parent, false), label + ": conditional guard");
  }
  const priorCalls = all.filter((node): node is ts.CallExpression =>
    ts.isCallExpression(node) && node.getStart() < guard.getStart());
  if (!route) {
    assert.ok(ts.isBlock(body), label);
    const first = body.statements[0];
    assert.ok(first && ts.isExpressionStatement(first) && ts.isAwaitExpression(first.expression)
      && first.expression.expression === guard, label + ": guard must be the first statement");
    assert.equal(priorCalls.length, 0, label + ": side effect before guard");
  }
  else {
    const safe = new Set(["readSession", "getSession", "demoModeEnabled", "can",
      "NextResponse.json", "redirect", "UUID.test", "teamInviteAllowlistConfigured", "teamInvitesAllowedForOrg"]);
    for (const call of priorCalls) {
      assert.ok(safe.has(call.expression.getText()), label + ": call before guard: " + call.expression.getText());
    }
    for (const node of all) {
      if (ts.isAwaitExpression(node) && node.getStart() < guard.parent.getStart()) {
        assert.ok(ts.isCallExpression(node.expression)
          ? ["readSession", "getSession"].includes(node.expression.expression.getText())
          : node.expression.getText() === "context.params", label + ": await before guard");
      }
    }
  }
}
test("all runtime server exports, routes and protected pages are classified", () => {
  for (const path of paths) {
    const file = program.getSourceFile(path)!;
    const name = relative(root, path).replaceAll("\\", "/");
    const server = file.statements.some(directive);
    if (/^server\/.*actions.*\.ts$/.test(name)) assert.ok(server, name + ": action module lost use server");
    for (const node of nodes(file)) {
      if (directive(node)) assert.equal(node.parent, file, name + ": inline action needs explicit classification");
    }
    const route = name.startsWith("app/") && name.endsWith("/route.ts");
    const page = /^app\/[mot]\/(?:.*\/)?page\.tsx$/.test(name);
    if (!server && !route && !page) continue;
    const moduleSymbol = checker.getSymbolAtLocation(file);
    assert.ok(moduleSymbol, name);
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const symbol of exports) {
      if (!(unalias(symbol).flags & ts.SymbolFlags.Value)) continue;
      const key = symbol.name;
      const label = name + "#" + key;
      if (server && openActions[name]?.[key]) continue;
      if (route && openRoutes[name.slice(4)]?.[key]) continue;
      if ((route || page) && ["dynamic", "revalidate", "runtime", "maxDuration", "fetchCache", "metadata", "generateMetadata"].includes(key)) {
        assert.notEqual(key, "generateMetadata", label + ": classify data-producing metadata");
        continue;
      }
      if (page && key !== "default") assert.fail(label + ": unclassified page export");
      if (name === "app/api/id-documents/photo/route.ts" && key === "GET") {
        // Token-bound authorization runs inside the existing photo connection.
        const body = bodyOf(symbol)!;
        const calls = nodes(body).filter(ts.isCallExpression);
        const serve = calls.find((call) => call.expression.getText() === "serveSignedPhoto");
        assert.ok(serve);
        const callback = serve.arguments[1];
        assert.ok(callback && ts.isArrowFunction(callback));
        assert.ok(nodes(callback).some((node) => ts.isCallExpression(node)
          && !!isGuard(node) && ts.isAwaitExpression(node.parent)));
        assert.ok(calls.find((call) => call.expression.getText() === "readPhotoToken")!.pos < serve.pos);
        assert.equal(calls.filter((call) => call.expression.getText() === "readSessionOn").length, 1);
        continue;
      }
      guarded(bodyOf(symbol)!, route, label);
    }
    if (page) {
      assert.ok(exports.some((symbol) => symbol.name === "default"), name);
      assert.match(readFileSync(path, "utf8"), /force-dynamic/, name + ": dynamic rendering required");
    }
  }
});
