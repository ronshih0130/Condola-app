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
};
const openPages: Record<string, Record<string, string>> = {
  "app/vendor-account/page.tsx": { default: "Public shell only; account API validates auth cookie and current consent before all data and mutations" },
  "app/v/[token]/estimate/page.tsx": { default: "B-026 scoped vendor token and flag gateway, no user session" },
  "app/v/[token]/page.tsx": { default: "Vendor link token authentication, no user session" },
  "app/v/[token]/notifications/page.tsx": { default: "Exact vendor job token gateway, no human user session" },
};
const openRoutes: Record<string, Record<string, string>> = {
  "api/line/vendor-job/route.ts": { GET: "B-035 browser-bound single-job claim and strict LINE gates; no account session", POST: "B-035 same-origin CSRF and original locked vendor job capability; no account session" },
  "(line)/v/liff/job/route.ts": { GET: "B-035 browser-bound single-job claim; no human account authority" },
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
  "(line)/t/liff/route.ts": { GET: "Public B-033 bootstrap outside protected layouts; OFF Email fallback; read-only configuration" },
  "(line)/v/liff/route.ts": { GET: "Public B-033 bootstrap outside protected layouts; OFF Email fallback; read-only configuration", POST: "B-035 same-origin job-entry browser proof; strict vendor LINE gates, token only in the body, no database writes or account session" },
  "(line)/o/liff/route.ts": { GET: "Public B-033 bootstrap outside protected layouts; OFF Email fallback; read-only configuration" },
  "api/line/webhook/route.ts": { POST: "B-033 raw-body HMAC signature and selected-OA/org flag gate; provider webhook has no human session" },
  "api/vendor-account-staff/route.ts": { GET: "Read-only cookie auth, current consent and partner gate via authorizeVendorAccountStaffRequest; SQL revalidates staff scope", POST: "Read-only cookie auth, current consent and partner gate via authorizeVendorAccountStaffRequest; SQL revalidates staff scope" },
  "api/vendor-account/route.ts": { GET: "Account cookie identity plus current consent via authorizeVendorAccountRequest; no persona or session writes", POST: "Account cookie identity plus current consent via authorizeVendorAccountRequest; strict same-origin mutation" },
  "api/vendor-estimate/route.ts": { POST: "B-026 scoped vendor token and flag gateway, no user session" },
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
  "api/vendor-job-response/route.ts": { POST: "Vendor link token authentication, no user session" },
  "api/vendor-job-completion/route.ts": { POST: "Vendor link token authentication, no user session" },
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
      guarded(bodyOf(symbol)!, route, label);
    }
    if (page) {
      assert.ok(exports.some((symbol) => symbol.name === "default"), name);
      assert.match(readFileSync(path, "utf8"), /force-dynamic/, name + ": dynamic rendering required");
    }
  }
});
