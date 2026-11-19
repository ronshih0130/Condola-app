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
// actionResendPortalInvite in server/portal-resend-actions.ts uses the default guarded classification.
// Staff exports in server/vendor-link-actions.ts use the default guarded classification.
// vendor-onboarding.ts and vendor-receipt.ts are services, not entrypoints.
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
  "server/notification-center-actions.ts": {
    markVendorCenterRead: "Exact vendor job token gateway, no human user session",
  },
  "server/consent-actions.ts": {
    actionAcceptReconsent: "Record acceptance", actionAcceptPortalConsent: "Record acceptance",
  },
  "server/pricing-apply-actions.ts": {
    actionSubmitPricingApply: "Public pricing apply form, no user session required",
    runSubmitPricingApply: "Testable core of the public pricing apply form, no user session required",
  },
};
const openPages: Record<string, Record<string, string>> = {
  "app/vendor-account/page.tsx": { default: "Public shell only; account API validates auth cookie and current consent before all data and mutations. B-063 ON: the workbench admits by the B-026 account session and current consent (vendorWorkbenchAccess) before any read" },
  "app/v/[token]/estimate/page.tsx": { default: "B-026 scoped vendor token and flag gateway, no user session" },
  "app/v/[token]/page.tsx": { default: "Vendor link token authentication, no user session" },
  "app/v/[token]/notifications/page.tsx": { default: "Exact vendor job token gateway, no human user session" },
  "app/v/[token]/photos/page.tsx": { default: "B-105 vendor job token gateway (vendor_job_v3), no human user session" },
  "app/v/[token]/done/page.tsx": { default: "B-097 vendor job token gateway (vendor_job_v3, app.b097_vendor_done_view), no human user session" },
  "app/v/[token]/time/page.tsx": { default: "B-098 vendor job token gateway (vendor_job_v3, app.b098_vendor_tenant_phone), no human user session" },
  "app/v/documents/[token]/page.tsx": { default: "B-025 vendor document grant token, no human user session" },
};
const openRoutes: Record<string, Record<string, string>> = {
  "api/line/vendor-job/route.ts": { GET: "B-035 browser-bound single-job claim and strict LINE gates; no account session", POST: "B-035 same-origin CSRF and original locked vendor job capability; no account session" },
  "(line)/v/liff/job/route.ts": { GET: "B-035 browser-bound single-job claim; no human account authority" },
  "(line)/v/link/route.ts": { GET: "B-101 V-LINK review: browser-bound verified LINE flow, gates checked, no account session before confirmation", POST: "B-101 V-LINK remove/confirm: same-origin CSRF + browser-bound flow; session minted only on confirm, then existing consent routing (/consent?next=…)" },
  "api/line/portal/route.ts": { POST: "B-036 preference selection only; existing session, server role/company, portal flags and CSRF; current consent checked before returning portal next" },
  "api/line/reauth/route.ts": { POST: "B-033 explicit password/MFA step-up only; session-bound evidence, portal gates, browser proof and same-origin CSRF; never writes legal consent" },
  "api/line/flows/route.ts": { POST: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "api/line/session/route.ts": { POST: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "api/line/bind/route.ts": { POST: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "api/line/invites/accept/route.ts": { POST: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "api/line/login/start/route.ts": { GET: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "api/line/login/callback/route.ts": { GET: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "api/line/links/route.ts": { GET: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "api/line/links/[id]/route.ts": { DELETE: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "api/line/identity/route.ts": { DELETE: "B-033 identity establishment or revocation; browser proof, same-origin CSRF, portal gate and scoped invitation/credential consent inside lineHandlers" },
  "(line)/t/liff/route.ts": { GET: "Public B-033 bootstrap outside protected layouts; strict OFF 404 with Email link; read-only configuration" },
  "(line)/v/liff/route.ts": { GET: "Public B-033 bootstrap outside protected layouts; strict OFF 404 with Email link; read-only configuration", POST: "B-035 same-origin job-entry browser proof; strict vendor LINE gates, token only in the body, no database writes or account session" },
  "(line)/o/liff/route.ts": { GET: "Public B-033 bootstrap outside protected layouts; strict OFF 404 with Email link; read-only configuration" },
  "api/line/webhook/route.ts": { POST: "B-033 raw-body HMAC signature and selected-OA/org flag gate; provider webhook has no human session" },
  "api/vendor-account-staff/route.ts": { GET: "Read-only cookie auth, current consent and partner gate via authorizeVendorAccountStaffRequest; SQL revalidates staff scope", POST: "Read-only cookie auth, current consent and partner gate via authorizeVendorAccountStaffRequest; SQL revalidates staff scope" },
  "vendor-account/jobs/[jobId]/route.ts": { GET: "B-063 row opener: account cookie identity plus current consent via vendorWorkbenchAccess (B-026 gateways); no session or token-only → sign-in, stale terms → consent, non-vendor → B1-NOPERM route, else 404; read-only, no persona or session writes" },
  "api/vendor-account/route.ts": { GET: "Account cookie identity plus current consent via authorizeVendorAccountRequest; no persona or session writes", POST: "Account cookie identity plus current consent via authorizeVendorAccountRequest; strict same-origin mutation" },
  "api/vendor-account/address/route.ts": { POST: "B-112: account cookie identity plus current consent and an open workbench via vendorWorkbenchAccess, then the app.b112 account-session gateway; strict same-origin mutation" },
  "api/vendor-account/issuer-type/route.ts": { POST: "B-065: account cookie identity plus current consent and an open workbench via vendorWorkbenchAccess, then the app.b065 account-session gateway; strict same-origin mutation" },
  "api/vendor-estimate/route.ts": { POST: "B-026 scoped vendor token and flag gateway, no user session" },
  "join/[token]/route.ts": { GET: "Public B-033 unit LINE invite landing; token in the path only, no account session, no outbound" },
  "signup/unit-qr/route.ts": { GET: "Static retired B-005 L1 page; no database, no account data, no token interpolation" },
  "api/signup/unit-qr/route.ts": { POST: "Always 404; no body read, no cookie, no identity or data access" },
  "api/auth/enter/route.ts": { GET: "Authentication continuation checks consent" },
  "api/auth/sign-out/route.ts": { POST: "Always permit leaving" },
  "api/cron/reminders/route.ts": { POST: "Cron secret, no human identity" },
  "api/mock-subscription/route.ts": { POST: "Loopback-only signed local mock provider fixture; environment switch and HMAC, no human identity" },
  "api/cron/purge-id-documents/route.ts": { POST: "Retention must continue" },
  "api/demo/locale/route.ts": { GET: "Public preference" },
  "api/demo/mode/route.ts": { GET: "Removed, always 404" },
  "api/demo/persona/route.ts": { GET: "Removed, always 404" },
  "api/demo/tryout/route.ts": { GET: "Public preference" },
  "api/vendor-jobs/[token]/photos/[id]/route.ts": { GET: "Vendor link token authentication, no user session" },
  "api/vendor-jobs/photos/sign/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/vendor-jobs/photos/confirm/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/vendor-job-response/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/vendor-jobs/case-share/route.ts": { POST: "B-110: B-105 vendor case token through app.b110_vendor_share, no user session" },
  "s/[token]/photos/[id]/route.ts": { GET: "B-110 public read-only share link through app.b110_share_photo, no user session" },
  "api/vendor-jobs/case-complete/route.ts": { POST: "B-097: B-105 vendor case token through app.b097_vendor_complete, no user session" },
  "api/repairs/reopen/route.ts": { POST: "B-097: staff session with tickets.update and current consent (requireCurrentConsent), then app.b097_staff_reopen; strict same-origin mutation" },
  "api/vendor-jobs/case-decision/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/vendor-jobs/case-photos/confirm/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/vendor-job-completion/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/vendor-documents/route.ts": { POST: "B-025 vendor document grant token, no user session" },
  "api/vendor-documents/pdf/route.ts": { POST: "B-025 vendor document grant token, no user session" },
  "api/vendor-documents/scan/route.ts": { POST: "B-025 vendor document grant token, no user session" },
  "api/notification-center/vendor-mark/route.ts": { POST: "Exact vendor job token gateway, no human user session" },
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
function unalias(symbol: ts.Symbol, typeChecker = checker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? typeChecker.getAliasedSymbol(symbol) : symbol;
}
function isGuard(call: ts.CallExpression, typeChecker = checker) {
  const symbol = typeChecker.getSymbolAtLocation(call.expression);
  if (!symbol) return false;
  const target = unalias(symbol, typeChecker);
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
// Lauren 2b: `export const POST = withFlagGate(spec, handler)`. The wrapper's own handler runs the real
// requireCurrentConsent(undefined, "api") first (pinned on src/server/flag-gate.ts by the test below). A route export
// qualifies only through a direct, unaliased call of the real withFlagGate with no deps override (default deps only).
function flagGateCall(symbol: ts.Symbol) {
  const declaration = unalias(symbol).valueDeclaration;
  const init = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  return init && ts.isCallExpression(init) ? init : undefined;
}
function assertFlagGatedRoute(call: ts.CallExpression, label: string, typeChecker = checker) {
  assert.ok(ts.isIdentifier(call.expression) && call.expression.text === "withFlagGate", label + ": only a direct withFlagGate call may wrap a route");
  const symbol = typeChecker.getSymbolAtLocation(call.expression);
  const target = symbol && unalias(symbol, typeChecker);
  assert.ok(target?.name === "withFlagGate" && target.declarations?.some((d) => d.getSourceFile().fileName.endsWith("/server/flag-gate.ts")), label + ": untrusted withFlagGate");
  assert.equal(call.arguments.length, 2, label + ": production routes must not pass withFlagGate deps");
  assert.ok(!call.arguments.some(ts.isSpreadElement), label + ": spread arguments hide the deps");
}
// Lauren 2c: `export default withPageFlagGate(spec, Page)` (src/server/page-flag-gate.ts). The wrapper's gated page runs
// the real requireCurrentConsent(undefined, "page") first (pinned on page-flag-gate.ts by the test below). A page default
// export qualifies only through a direct, unaliased call of the real withPageFlagGate with no deps override.
function pageFlagGateCall(symbol: ts.Symbol) {
  const declaration = unalias(symbol).valueDeclaration;
  return declaration && ts.isExportAssignment(declaration) && ts.isCallExpression(declaration.expression) ? declaration.expression : undefined;
}
function assertFlagGatedPage(call: ts.CallExpression, label: string, typeChecker = checker) {
  assert.ok(ts.isIdentifier(call.expression) && call.expression.text === "withPageFlagGate", label + ": only a direct withPageFlagGate call may wrap a page");
  const symbol = typeChecker.getSymbolAtLocation(call.expression);
  const target = symbol && unalias(symbol, typeChecker);
  assert.ok(target?.name === "withPageFlagGate" && target.declarations?.some((d) => d.getSourceFile().fileName.endsWith("/server/page-flag-gate.ts")), label + ": untrusted withPageFlagGate");
  assert.equal(call.arguments.length, 2, label + ": production pages must not pass withPageFlagGate deps");
  assert.ok(!call.arguments.some(ts.isSpreadElement), label + ": spread arguments hide the deps");
  // Lauren 2c r1 (Codex review FAIL #1): what a scanner reads from the spec must be what runs. Same rule as
  // b017-entrypoints literalSpec: a plain object literal of identifier keys flagKey and flag, no spread, computed or
  // quoted key, method, accessor or duplicate; flagKey a string literal; flag and Page inline or same-file functions.
  const [spec, page] = call.arguments;
  assert.ok(ts.isObjectLiteralExpression(spec), label + ": spec is not an inline object literal");
  const seen = new Map<string, ts.PropertyAssignment | ts.ShorthandPropertyAssignment>();
  for (const p of spec.properties) {
    assert.ok(!ts.isSpreadAssignment(p), label + ": spread in spec");
    assert.ok(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p), label + ": method or accessor in spec");
    assert.ok(ts.isIdentifier(p.name), label + ": computed or quoted spec key");
    assert.ok(["flagKey", "flag"].includes(p.name.text), label + ": unexpected spec key " + p.name.text);
    assert.ok(!seen.has(p.name.text), label + ": duplicate spec key " + p.name.text);
    assert.ok(!ts.isShorthandPropertyAssignment(p) || !p.objectAssignmentInitializer, label + ": shorthand default in spec");
    seen.set(p.name.text, p);
  }
  const flagKey = seen.get("flagKey");
  assert.ok(flagKey && ts.isPropertyAssignment(flagKey) && ts.isStringLiteral(flagKey.initializer), label + ": spec.flagKey must be a string literal");
  const flag = seen.get("flag");
  assert.ok(flag, label + ": spec.flag is missing");
  assert.ok(sameFileFunction(ts.isPropertyAssignment(flag) ? flag.initializer : flag, typeChecker), label + ": spec.flag is not an inline function or a same-file, never-reassigned function");
  assert.ok(sameFileFunction(page, typeChecker), label + ": Page is not an inline function or a same-file, never-reassigned function");
}
/** An inline function, or an identifier / shorthand naming a same-file, never-reassigned function declaration or const function. */
function sameFileFunction(node: ts.Node, typeChecker = checker): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  const symbol = ts.isShorthandPropertyAssignment(node) ? typeChecker.getShorthandAssignmentValueSymbol(node)
    : ts.isIdentifier(node) ? typeChecker.getSymbolAtLocation(node) : undefined;
  if (!symbol || symbol.flags & ts.SymbolFlags.Alias) return false; // imported: not traced
  const file = node.getSourceFile(), declaration = symbol.valueDeclaration;
  if (!declaration || declaration.getSourceFile() !== file) return false;
  const targets = nodes(file).flatMap((n) => ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? [n.left]
    : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator) ? [n.operand] : []);
  if (targets.some((t) => nodes(t).some((id) => ts.isIdentifier(id) && typeChecker.getSymbolAtLocation(id) === symbol))) return false;
  if (ts.isFunctionDeclaration(declaration)) return !!declaration.body;
  return ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && !!declaration.initializer
    && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer));
}
function assertPayeeAdapter(body: ts.Node, route: boolean, label: string, typeChecker = checker) {
  assert.ok(ts.isBlock(body), label);
  const first = body.statements[0];
  assert.ok(first && ts.isVariableStatement(first) && (first.declarationList.flags & ts.NodeFlags.Const) !== 0 && first.declarationList.declarations.length === 1, label + ": adapter must be the first const statement");
  const declaration = first.declarationList.declarations[0];
  assert.ok(ts.isIdentifier(declaration.name) && declaration.initializer && ts.isAwaitExpression(declaration.initializer), label + ": adapter must be awaited");
  const call = declaration.initializer.expression;
  const name = route ? "authorizePayeeApiEntry" : "authorizePayeeActionEntry";
  assert.ok(ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === name && call.arguments.length === 0, label + ": invalid adapter call");
  const symbol = typeChecker.getSymbolAtLocation(call.expression);
  assert.ok(symbol, label + ": unknown adapter");
  const target = unalias(symbol, typeChecker);
  assert.equal(target.name, name, label + ": renamed adapter");
  assert.ok(target.declarations?.some((d) => d.getSourceFile().fileName.endsWith("/server/payee-consent.ts")), label + ": untrusted adapter");
  if (route) {
    const second = body.statements[1];
    assert.ok(second && ts.isIfStatement(second) && !second.elseStatement, label + ": missing denial return");
    const condition = second.expression;
    assert.ok(ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken
      && ts.isPropertyAccessExpression(condition.operand) && ts.isIdentifier(condition.operand.expression)
      && condition.operand.expression.text === declaration.name.text && condition.operand.name.text === "ok", label + ": invalid denial guard");
    const branch = ts.isBlock(second.thenStatement) && second.thenStatement.statements.length === 1
      ? second.thenStatement.statements[0] : second.thenStatement;
    assert.ok(ts.isReturnStatement(branch) && branch.expression && ts.isPropertyAccessExpression(branch.expression)
      && ts.isIdentifier(branch.expression.expression) && branch.expression.expression.text === declaration.name.text
      && branch.expression.name.text === "response", label + ": denial response must return");
  }
}

function guarded(body: ts.Node, route: boolean, label: string, typeChecker = checker) {
  const all = nodes(body);
  const payee = route ? label === "app/api/payee/[leaseId]/route.ts#POST"
    : ["server/payee-actions.ts#actionSavePayee", "server/payee-actions.ts#actionSetLeasePayee"].includes(label);
  if (payee) {
    assertPayeeAdapter(body, route, label, typeChecker);
    return;
  }
  assert.ok(!all.some((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && ["authorizePayeeApiEntry", "authorizePayeeActionEntry"].includes(node.expression.text)), label + ": payee adapter not permitted here");
  const guard = all.find((node): node is ts.CallExpression => ts.isCallExpression(node) && !!isGuard(node, typeChecker));
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
    const safe = new Set(["readSession", "getSession", "guardEffectiveSession", "demoModeEnabled", "can",
      "NextResponse.json", "redirect", "UUID.test", "teamInviteAllowlistConfigured", "teamInvitesAllowedForOrg"]);
    for (const call of priorCalls) {
      assert.ok(safe.has(call.expression.getText()), label + ": call before guard: " + call.expression.getText());
    }
    for (const node of all) {
      if (ts.isAwaitExpression(node) && node.getStart() < guard.parent.getStart()) {
        assert.ok(ts.isCallExpression(node.expression)
          ? ["readSession", "getSession", "guardEffectiveSession"].includes(node.expression.expression.getText())
          : node.expression.getText() === "context.params", label + ": await before guard");
      }
    }
  }
}

function assertAdapterDefinition(fn: ts.FunctionDeclaration | undefined, helper: string, mode: "action" | "api", typeChecker = checker) {
    const name = fn?.name?.text ?? "adapter";
    assert.ok(fn?.body && fn.parameters.length === 0, name);
    assert.equal(fn.body.statements.length, 1, name + ": adapter must only return helper");
    const statement = fn.body.statements[0];
    assert.ok(ts.isReturnStatement(statement) && statement.expression && ts.isCallExpression(statement.expression), name);
    const helperCall = statement.expression;
    assert.ok(ts.isIdentifier(helperCall.expression) && helperCall.expression.text === helper, name + ": exact helper name required");
    assert.ok(helperCall && helperCall.arguments.length === 1 && ts.isObjectLiteralExpression(helperCall.arguments[0]), name);
    const helperSymbol = typeChecker.getSymbolAtLocation(helperCall.expression);
    assert.ok(helperSymbol && unalias(helperSymbol, typeChecker).name === helper && unalias(helperSymbol, typeChecker).declarations?.some((d) => d.getSourceFile().fileName.endsWith("/server/payee-action-context.ts")), name);
    const properties: ts.NodeArray<ts.ObjectLiteralElementLike> = helperCall.arguments[0].properties;
    assert.deepEqual(properties.map((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ? p.name.getText() : "").sort(), ["audit", "readContext", "readSession", "requireConsent"]);
    for (const [property, symbolName, fileName] of [
      ["readSession", "readSession", "/server/session.ts"],
      ["readContext", "readPayeeContext", "/server/payee.ts"],
      ["audit", "logPayeeIngress", "/server/payee.ts"],
    ] as const) {
      const prop = properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === property);
      assert.ok(prop && (ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop)), name);
      const value = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
      const s = ts.isShorthandPropertyAssignment(prop) ? typeChecker.getShorthandAssignmentValueSymbol(prop) : typeChecker.getSymbolAtLocation(value);
      assert.ok(s && unalias(s, typeChecker).name === symbolName && unalias(s, typeChecker).declarations?.some((d) => d.getSourceFile().fileName.endsWith(fileName)), name + ": " + property);
    }
    const consent = properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "requireConsent");
    assert.ok(consent && ts.isPropertyAssignment(consent) && ts.isArrowFunction(consent.initializer));
    const callback = consent.initializer;
    assert.ok(callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0].name));
    const guard = callback.body;
    assert.ok(ts.isCallExpression(guard) && isGuard(guard, typeChecker) && guard.arguments.length === (mode === "api" ? 2 : 1), name);
    assert.equal(guard.arguments[0].getText(), callback.parameters[0].name.text);
    assert.ok(ts.isReturnStatement(helperCall.parent) && helperCall.parent.parent === fn.body, name + ": must return helper result");
    if (mode === "api") assert.equal(guard.arguments[1].getText(), '"api"');
}

test("payee entry adapters bind fixed real authorization dependencies", () => {
  const file = program.getSourceFile(resolve("src/server/payee-consent.ts"));
  assert.ok(file);
  for (const [name, helper, mode] of [["authorizePayeeActionEntry", "authorizePayeeAction", "action"], ["authorizePayeeApiEntry", "authorizePayeeApi", "api"]] as const) {
    const fn = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    assertAdapterDefinition(fn, helper, mode);
  }
});

test("payee adapter classification rejects impostors and non-dominating guards", () => {
  const virtual = resolve("src/server/__payee_consent_fixture.ts");
  const code = `
    import { authorizePayeeActionEntry, authorizePayeeApiEntry, authorizePayeeActionEntry as renamed } from './payee-consent';
    import { requireCurrentConsent } from './consent-gate';
    async function good() { const auth = await authorizePayeeApiEntry(); if (!auth.ok) return auth.response; return auth.session; }
    async function renamedGuard() { const session = await renamed(); return session; }
    async function impostor() { const authorizePayeeActionEntry = async () => ({}); const session = await authorizePayeeActionEntry(); return session; }
    async function noAwait() { const session = authorizePayeeActionEntry(); return session; }
    async function noReturn() { const auth = await authorizePayeeApiEntry(); if (!auth.ok) console.log(auth.response); return auth; }
    async function businessFirst() { await Promise.resolve(); const auth = await authorizePayeeApiEntry(); if (!auth.ok) return auth.response; return auth.session; }
    async function bareGuard() { await requireCurrentConsent(null); }
  `;
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: resolve("."), paths: { "@/*": ["src/*"] } };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, fresh) => resolve(file) === virtual
    ? ts.createSourceFile(virtual, code, language, true) : original(file, language, onError, fresh);
  const fixtureProgram = ts.createProgram([virtual], options, host);
  const file = fixtureProgram.getSourceFile(virtual);
  assert.ok(file);
  const fixtureChecker = fixtureProgram.getTypeChecker();
  function body(name: string) {
    const fn = file!.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    assert.ok(fn?.body);
    return fn.body;
  }
  assert.doesNotThrow(() => assertPayeeAdapter(body("good"), true, "good", fixtureChecker));
  for (const name of ["renamedGuard", "impostor", "noAwait"]) {
    assert.throws(() => assertPayeeAdapter(body(name), false, name, fixtureChecker));
  }
  for (const name of ["noReturn", "businessFirst"]) {
    assert.throws(() => assertPayeeAdapter(body(name), true, name, fixtureChecker));
  }
  assert.doesNotThrow(() => guarded(body("bareGuard"), false, "server/other-actions.ts#example", fixtureChecker));
  assert.throws(() => guarded(body("bareGuard"), false, "server/payee-actions.ts#actionSavePayee", fixtureChecker));
});

test("adapter definitions reject early bypasses and wrong helpers", () => {
  const source = program.getSourceFile(resolve("src/server/payee-consent.ts"));
  assert.ok(source);
  const original = source.getFullText();
  const variants: Record<string, string> = {
    good: original,
    earlyReturn: original.replace("return authorizePayeeAction(", "return {} as never; return authorizePayeeAction("),
    earlyBusiness: original.replace("return authorizePayeeAction(", "console.log('business'); return authorizePayeeAction("),
    renamed: original.replace("authorizePayeeAction, authorizePayeeApi", "authorizePayeeAction as wrongHelper, authorizePayeeApi").replace("return authorizePayeeAction(", "return wrongHelper("),
    wrongSymbol: original.replace("authorizePayeeAction, authorizePayeeApi", "authorizePayeeApi as authorizePayeeAction, authorizePayeeApi"),
  };
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: resolve("."), paths: { "@/*": ["src/*"] } };
  const host = ts.createCompilerHost(options);
  const originals = host.getSourceFile.bind(host);
  const virtual = Object.fromEntries(Object.entries(variants).map(([name, code]) => [resolve(`src/server/__payee_${name}.ts`), code]));
  host.getSourceFile = (file, language, onError, fresh) => virtual[resolve(file)] !== undefined
    ? ts.createSourceFile(file, virtual[resolve(file)], language, true) : originals(file, language, onError, fresh);
  const fixtures = ts.createProgram(Object.keys(virtual), options, host);
  for (const name of Object.keys(variants)) {
    const file = fixtures.getSourceFile(resolve(`src/server/__payee_${name}.ts`));
    assert.ok(file);
    const fn = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "authorizePayeeActionEntry");
    const check = () => assertAdapterDefinition(fn, "authorizePayeeAction", "action", fixtures.getTypeChecker());
    if (name === "good") assert.doesNotThrow(check); else assert.throws(check, name);
  }
});
test("withFlagGate (Lauren 2b) runs the real consent guard first, with the real default deps", () => {
  const file = program.getSourceFile(resolve("src/server/flag-gate.ts"));
  assert.ok(file);
  const defaults = file.statements.flatMap((s) => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === "defaultDeps");
  assert.ok(defaults?.initializer && ts.isObjectLiteralExpression(defaults.initializer), "defaultDeps object");
  const consent = defaults.initializer.properties.find((p) => p.name?.getText() === "requireCurrentConsent");
  assert.ok(consent && ts.isShorthandPropertyAssignment(consent), "defaultDeps.requireCurrentConsent is the imported guard");
  const bound = checker.getShorthandAssignmentValueSymbol(consent);
  assert.ok(bound && unalias(bound).name === "requireCurrentConsent"
    && unalias(bound).declarations?.some((d) => d.getSourceFile().fileName.endsWith("/server/consent-gate.ts")), "real consent guard");
  const fn = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "withFlagGate");
  assert.ok(fn?.body && fn.parameters.length === 3);
  const deps = fn.parameters[2];
  assert.ok(deps.initializer && ts.isIdentifier(deps.initializer) && deps.initializer.text === "defaultDeps", "deps default to defaultDeps");
  const gated = fn.body.statements.flatMap((s) => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === "gated");
  assert.ok(gated?.initializer && ts.isArrowFunction(gated.initializer) && ts.isBlock(gated.initializer.body), "gated handler");
  const [first, second] = gated.initializer.body.statements;
  assert.ok(first && ts.isVariableStatement(first) && first.declarationList.declarations.length === 1, "guard is the first statement");
  const denied = first.declarationList.declarations[0];
  assert.ok(ts.isIdentifier(denied.name) && denied.initializer && ts.isAwaitExpression(denied.initializer));
  const call = denied.initializer.expression;
  assert.ok(ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression) && call.expression.name.text === "requireCurrentConsent", "deps.requireCurrentConsent(...)");
  assert.equal(checker.getSymbolAtLocation(call.expression.expression)?.valueDeclaration, deps, "the deps parameter");
  assert.deepEqual(call.arguments.map((a) => a.getText()), ["undefined", '"api"']);
  assert.ok(second && ts.isIfStatement(second) && !second.elseStatement && second.expression.getText() === denied.name.text
    && ts.isReturnStatement(second.thenStatement) && second.thenStatement.expression?.getText() === denied.name.text, "denial returns first");
  const last = fn.body.statements[fn.body.statements.length - 1];
  assert.ok(ts.isReturnStatement(last) && last.expression && ts.isAsExpression(last.expression)
    && last.expression.expression.getText() === "gated", "withFlagGate returns the gated handler");
});

test("withFlagGate route classification rejects aliases, impostors, member calls and a deps override", () => {
  const virtual = resolve("src/app/api/__flag_gate_fixture/route.ts");
  const code = `
    import { withFlagGate, withFlagGate as gate } from "@/server/flag-gate";
    import * as fg from "@/server/flag-gate";
    const spec = { flagKey: "brand_v3", flag: () => true, tag: "t" };
    const handler = async () => new Response(null);
    export const good = withFlagGate(spec, handler);
    export const aliased = gate(spec, handler);
    export const member = fg.withFlagGate(spec, handler);
    export const withDeps = withFlagGate(spec, handler, { requireCurrentConsent: async () => null } as never);
    export const spread = withFlagGate(...([spec, handler] as const));
    export const impostor = (() => { const withFlagGate = (_s: unknown, h: unknown) => h; return withFlagGate(spec, handler); })();
  `;
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: resolve("."), paths: { "@/*": ["src/*"] } };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, fresh) => resolve(file) === virtual
    ? ts.createSourceFile(virtual, code, language, true) : original(file, language, onError, fresh);
  const fixtureProgram = ts.createProgram([virtual], options, host);
  const fixtureChecker = fixtureProgram.getTypeChecker();
  const file = fixtureProgram.getSourceFile(virtual);
  assert.ok(file);
  const call = (name: string) => {
    const declaration = file.statements.flatMap((s) => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])
      .find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    let init = declaration?.initializer;
    // The impostor's call sits inside an IIFE: classify the inner withFlagGate(...) call.
    if (name === "impostor") init = nodes(init!).find((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText() === "withFlagGate");
    assert.ok(init && ts.isCallExpression(init), name);
    return init;
  };
  assert.doesNotThrow(() => assertFlagGatedRoute(call("good"), "good", fixtureChecker));
  for (const name of ["aliased", "member", "withDeps", "spread", "impostor"]) {
    assert.throws(() => assertFlagGatedRoute(call(name), name, fixtureChecker), name);
  }
});

test("withPageFlagGate (Lauren 2c) runs the real page-mode consent guard first, then the real getSession, with the real default deps", () => {
  const file = program.getSourceFile(resolve("src/server/page-flag-gate.ts"));
  assert.ok(file);
  const defaults = file.statements.flatMap((s) => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === "defaultDeps");
  assert.ok(defaults?.initializer && ts.isObjectLiteralExpression(defaults.initializer), "defaultDeps object");
  for (const [property, fileName] of [["requireCurrentConsent", "/server/consent-gate.ts"], ["getSession", "/server/session.ts"]] as const) {
    const prop = defaults.initializer.properties.find((p) => p.name?.getText() === property);
    assert.ok(prop && ts.isShorthandPropertyAssignment(prop), `defaultDeps.${property} is the imported function`);
    const bound = checker.getShorthandAssignmentValueSymbol(prop);
    assert.ok(bound && unalias(bound).name === property
      && unalias(bound).declarations?.some((d) => d.getSourceFile().fileName.endsWith(fileName)), `real ${property}`);
  }
  const fn = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "withPageFlagGate");
  assert.ok(fn?.body && fn.parameters.length === 3);
  const deps = fn.parameters[2];
  assert.ok(deps.initializer && ts.isIdentifier(deps.initializer) && deps.initializer.text === "defaultDeps", "deps default to defaultDeps");
  const gated = fn.body.statements.flatMap((s) => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === "gated");
  assert.ok(gated?.initializer && ts.isArrowFunction(gated.initializer) && ts.isBlock(gated.initializer.body), "gated page");
  const [first, second] = gated.initializer.body.statements;
  assert.ok(first && ts.isExpressionStatement(first) && ts.isAwaitExpression(first.expression), "the consent guard is the first, awaited statement");
  const call = first.expression.expression;
  assert.ok(ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression) && call.expression.name.text === "requireCurrentConsent", "deps.requireCurrentConsent(...)");
  assert.equal(checker.getSymbolAtLocation(call.expression.expression)?.valueDeclaration, deps, "the deps parameter");
  assert.deepEqual(call.arguments.map((a) => a.getText()), ["undefined", '"page"']);
  assert.ok(second && ts.isVariableStatement(second) && second.declarationList.declarations.length === 1, "session is the second statement");
  const session = second.declarationList.declarations[0].initializer;
  assert.ok(session && ts.isAwaitExpression(session) && session.expression.getText() === "deps.getSession()", "await deps.getSession()");
  const last = fn.body.statements[fn.body.statements.length - 1];
  assert.ok(ts.isReturnStatement(last) && last.expression && ts.isAsExpression(last.expression)
    && last.expression.expression.getText() === "gated", "withPageFlagGate returns the gated page");
});

test("withPageFlagGate page classification accepts only a direct default-export call; rejects aliases, impostors, member calls and a deps override", () => {
  const dir = resolve("src/app/m/__page_flag_gate_fixture");
  const imp = `import { withPageFlagGate } from "@/server/page-flag-gate";`;
  const leak = `async () => { await fetch("x"); return true; }`;
  // name → [source, expected]: "ok", "unwrapped" (not a gate call: guarded() keeps classifying it), or the rejection RegExp.
  const cases: Record<string, [string, "ok" | "unwrapped" | RegExp]> = {
    good: [`${imp} async function Page() { return null; }
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, Page);`, "ok"],
    goodSameFileFlag: [`${imp} const flag = async () => true; function gate() { return true; }
      export default withPageFlagGate({ flagKey: "brand_v3", flag }, async () => null);
      export const other = withPageFlagGate({ flagKey: "brand_v3", flag: gate }, async () => null);`, "ok"],
    unwrapped: [`export default async function Page() { return null; }`, "unwrapped"],
    aliased: [`import { withPageFlagGate as gate } from "@/server/page-flag-gate";
      export default gate({ flagKey: "brand_v3", flag: () => true }, async () => null);`, /only a direct withPageFlagGate call/],
    member: [`import * as pg from "@/server/page-flag-gate";
      export default pg.withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, async () => null);`, /only a direct withPageFlagGate call/],
    withDeps: [`${imp} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, async () => null, { requireCurrentConsent: async () => null } as never);`, /must not pass withPageFlagGate deps/],
    spread: [`${imp} const args = [{ flagKey: "brand_v3", flag: () => true }, async () => null] as const;
      export default withPageFlagGate(...args);`, /must not pass withPageFlagGate deps|spread arguments/],
    impostor: [`const withPageFlagGate = (_s: unknown, p: unknown) => p;
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, async () => null);`, /untrusted withPageFlagGate/],
    routeWrapper: [`import { withFlagGate } from "@/server/flag-gate";
      export default withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t" }, async () => new Response(null));`, /only a direct withPageFlagGate call/],
    // Codex r1 BLOCKING repro and variants: the scanned spec must be the one that runs.
    specSpread: [`${imp} const overrides: { flag?: () => Promise<boolean> } = { flag: ${leak} };
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, ...overrides }, async () => null);`, /spread in spec/],
    duplicateFlag: [`${imp} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, flag: ${leak} }, async () => null);`, /duplicate spec key flag/],
    computedFlag: [`${imp} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, ["flag"]: ${leak} }, async () => null);`, /computed or quoted spec key/],
    quotedFlag: [`${imp} export default withPageFlagGate({ flagKey: "brand_v3", "flag": ${leak} }, async () => null);`, /computed or quoted spec key/],
    methodFlag: [`${imp} export default withPageFlagGate({ flagKey: "brand_v3", async flag() { return true; } }, async () => null);`, /method or accessor in spec/],
    unknownKey: [`${imp} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, deps: {} }, async () => null);`, /unexpected spec key deps/],
    specVariable: [`${imp} const spec = { flagKey: "brand_v3", flag: ${leak} };
      export default withPageFlagGate(spec, async () => null);`, /spec is not an inline object literal/],
    specObjectAssign: [`${imp} export default withPageFlagGate(Object.assign({ flagKey: "brand_v3", flag: () => true }, { flag: ${leak} }), async () => null);`, /spec is not an inline object literal/],
    flagKeyNotLiteral: [`${imp} const key = "brand_v3"; export default withPageFlagGate({ flagKey: key, flag: () => true }, async () => null);`, /flagKey must be a string literal/],
    missingFlag: [`${imp} export default withPageFlagGate({ flagKey: "brand_v3" }, async () => null);`, /spec\.flag is missing/],
    importedFlag: [`${imp} import { brandV3EnabledForOrg } from "@/server/brand-v3";
      export default withPageFlagGate({ flagKey: "brand_v3", flag: brandV3EnabledForOrg }, async () => null);`, /spec\.flag is not an inline function/],
    importedShorthandFlag: [`${imp} import { brandV3EnabledForOrg as flag } from "@/server/brand-v3";
      export default withPageFlagGate({ flagKey: "brand_v3", flag }, async () => null);`, /spec\.flag is not an inline function/],
    reassignedFlag: [`${imp} let gate = async () => true; gate = ${leak};
      export default withPageFlagGate({ flagKey: "brand_v3", flag: gate }, async () => null);`, /spec\.flag is not an inline function/],
    pageObjectAssign: [`${imp} async function Page() { return null; }
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, Object.assign(Page, { x: 1 }));`, /Page is not an inline function/],
    reassignedPage: [`${imp} async function Page() { return null; } (Page as unknown) = async () => null;
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, Page);`, /Page is not an inline function/],
    importedPage: [`${imp} import { brandV3EnabledForOrg } from "@/server/brand-v3";
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, brandV3EnabledForOrg as never);`, /Page is not an inline function/],
  };
  const virtual = Object.fromEntries(Object.entries(cases).map(([name, [code]]) => [join(dir, name, "page.tsx"), code]));
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, baseUrl: resolve("."), paths: { "@/*": ["src/*"] } };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, fresh) => virtual[resolve(file)] !== undefined
    ? ts.createSourceFile(file, virtual[resolve(file)], language, true, ts.ScriptKind.TSX) : original(file, language, onError, fresh);
  const fixtureProgram = ts.createProgram(Object.keys(virtual), options, host);
  const fixtureChecker = fixtureProgram.getTypeChecker();
  const exportCalls = (name: string) => {
    const file = fixtureProgram.getSourceFile(join(dir, name, "page.tsx"));
    assert.ok(file, name);
    const moduleSymbol = fixtureChecker.getSymbolAtLocation(file);
    assert.ok(moduleSymbol, name);
    return fixtureChecker.getExportsOfModule(moduleSymbol).map((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? fixtureChecker.getAliasedSymbol(symbol) : symbol;
      const declaration = target.valueDeclaration;
      if (symbol.name === "default") return pageFlagGateCall(symbol) ?? (declaration && ts.isExportAssignment(declaration) ? declaration.expression : undefined);
      const init = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      return init && ts.isCallExpression(init) ? init : undefined;
    });
  };
  for (const [name, [, expected]] of Object.entries(cases)) {
    const calls = exportCalls(name);
    if (expected === "unwrapped") { assert.deepEqual(calls, [undefined], name); continue; }
    for (const call of calls) {
      assert.ok(call && ts.isCallExpression(call), name);
      if (expected === "ok") assert.doesNotThrow(() => assertFlagGatedPage(call, name, fixtureChecker), name);
      else assert.throws(() => assertFlagGatedPage(call, name, fixtureChecker), expected, name);
    }
  }
});

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
    const page = /^app\/[motv]\/(?:.*\/)?page\.tsx$/.test(name) || ["app/m/leases/[id]/layout.tsx", "app/t/lease/layout.tsx"].includes(name);
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
      if (page && openPages[name]?.[key]) continue;
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
      const gate = route ? flagGateCall(symbol) : undefined;
      if (gate) { assertFlagGatedRoute(gate, label); continue; }
      const pageGate = page && key === "default" ? pageFlagGateCall(symbol) : undefined;
      if (pageGate) { assertFlagGatedPage(pageGate, label); continue; } // Lauren 2c
      guarded(bodyOf(symbol)!, route, label);
    }
    if (page) {
      assert.ok(exports.some((symbol) => symbol.name === "default"), name);
      assert.match(readFileSync(path, "utf8"), /force-dynamic/, name + ": dynamic rendering required");
    }
  }
});
