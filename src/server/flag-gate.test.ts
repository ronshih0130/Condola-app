import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import ts from "typescript";
import flagGatePlugin, { countFlagChecks } from "../../eslint-rules/flag-gate.mjs";

/**
 * Baseline = frozen total hand-written flag-check call count across src/app, derived (NOT hardcoded)
 * from eslint-rules/flag-gate-baseline.json. Generate both JSON files once with:
 *   node eslint-rules/regen-flag-gate-allowlist.mjs
 */
function readBaselineTotal(): number {
  const url = new URL("../../eslint-rules/flag-gate-baseline.json", import.meta.url);
  if (!existsSync(url)) {
    throw new Error(
      "eslint-rules/flag-gate-baseline.json is missing; run `node eslint-rules/regen-flag-gate-allowlist.mjs` first.",
    );
  }
  return (JSON.parse(readFileSync(url, "utf8")) as { total: number }).total;
}
export const FLAG_GATE_ALLOWLIST_BASELINE: number = readBaselineTotal();

const ORG = "00000000-0000-4000-8000-000000000001";
const BASE = "http://localhost";
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

// ---- Loading flag-gate.ts in isolation (same transpile+mock style as b073-flag-off-endpoints.test.tsx) ----

function compileToExports(source: string, requireFn: (name: string) => unknown): Record<string, unknown> {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)(requireFn, exports);
  return exports;
}

function loadFlagGate() {
  const source = readFileSync(new URL("./flag-gate.ts", import.meta.url), "utf8");
  return compileToExports(source, (name) => {
    // Defaults are never exercised (tests inject deps), but the module binds them at load.
    if (name === "@/server/consent-gate") return { requireCurrentConsent: async () => null };
    if (name === "@/server/session") return { readSession: async () => null };
    if (name === "@/server/errors") return { logServerError: () => {} };
    throw new Error(`Unmocked dependency in flag-gate.ts: ${name}`);
  });
}

const flagGate = loadFlagGate();
const withFlagGate = flagGate.withFlagGate as <Ctx = unknown>(
  spec: Record<string, unknown>,
  handler: (request: Request, session: unknown, ctx: Ctx) => Response | Promise<Response>,
  deps?: Record<string, unknown>,
) => ((request: Request, ctx: Ctx) => Promise<Response>) & Record<symbol, unknown>;
const FLAG_GATE = flagGate.FLAG_GATE as symbol;

// ---- Fakes ----

function fakeDeps(over: Record<string, unknown> = {}) {
  const log: Array<{ tag: string; error: unknown }> = [];
  const deps = {
    requireCurrentConsent: async () => null,
    readSession: async () => ({ orgId: ORG }),
    logServerError: (tag: string, error: unknown) => { log.push({ tag, error }); },
    ...over,
  };
  return { deps, log };
}

function spec(over: Record<string, unknown> = {}) {
  return { flagKey: "brand_v3", flag: async () => true, tag: "flag_gate_test", ...over };
}

function countingRequest({ origin = BASE, path: p = "/api/x" }: { origin?: string; path?: string } = {}) {
  const calls = { pulls: 0, cancels: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { calls.pulls += 1; controller.close(); },
    cancel() { calls.cancels += 1; },
  }, { highWaterMark: 0 }); // Don't prefetch independently of the handler.
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
    headers: { Origin: origin, "Content-Type": "application/json" },
  };
  return { request: new Request(`${BASE}${p}`, init), calls };
}

const headerEntries = (res: Response) => ({ cc: res.headers.get("cache-control"), vary: res.headers.get("vary") });

// ---- (a) wrapper unit tests ----

test("consent denied: the gate response is passed through untouched; session and handler never run", async () => {
  const denied = new Response(null, { status: 418 });
  let sessionCalls = 0, handlerCalls = 0;
  const { deps } = fakeDeps({
    requireCurrentConsent: async () => denied,
    readSession: async () => { sessionCalls += 1; return { orgId: ORG }; },
  });
  const route = withFlagGate(spec(), async () => { handlerCalls += 1; return new Response("x"); }, deps);
  const { request, calls } = countingRequest();
  const res = await route(request, {});
  assert.equal(res, denied);
  assert.equal(sessionCalls, 0);
  assert.equal(handlerCalls, 0);
  assert.equal(calls.pulls, 0);
});

test("session read throws: 500, logged with the spec tag, handler not run", async () => {
  const boom = new Error("session boom");
  const { deps, log } = fakeDeps({ readSession: async () => { throw boom; } });
  let handlerCalls = 0;
  const route = withFlagGate(spec(), async () => { handlerCalls += 1; return new Response("x"); }, deps);
  const { request, calls } = countingRequest();
  const res = await route(request, {});
  assert.equal(res.status, 500);
  assert.equal(handlerCalls, 0);
  assert.equal(calls.pulls, 0);
  assert.deepEqual(log, [{ tag: "flag_gate_test", error: boom }]);
});

test("no session: 401", async () => {
  const { deps } = fakeDeps({ readSession: async () => null });
  const route = withFlagGate(spec(), async () => new Response("x"), deps);
  const { request, calls } = countingRequest();
  const res = await route(request, {});
  assert.equal(res.status, 401);
  assert.equal(calls.pulls, 0);
});

test("sameOrigin mismatch: 403 before the flag is evaluated", async () => {
  let flagCalls = 0;
  const { deps } = fakeDeps();
  const route = withFlagGate(spec({ sameOrigin: true, flag: async () => { flagCalls += 1; return true; } }), async () => new Response("x"), deps);
  const { request, calls } = countingRequest({ origin: "http://evil.example" });
  const res = await route(request, {});
  assert.equal(res.status, 403);
  assert.equal(flagCalls, 0);
  assert.equal(calls.pulls, 0);
});

test("flag false: 404, handler not run", async () => {
  let handlerCalls = 0;
  const { deps } = fakeDeps();
  const route = withFlagGate(spec({ flag: async () => false }), async () => { handlerCalls += 1; return new Response("x"); }, deps);
  const { request, calls } = countingRequest();
  const res = await route(request, {});
  assert.equal(res.status, 404);
  assert.equal(handlerCalls, 0);
  assert.equal(calls.pulls, 0);
});

test("flag throws: 404 (fail closed), logged with the spec tag", async () => {
  const boom = new Error("flag boom");
  const { deps, log } = fakeDeps();
  const route = withFlagGate(spec({ flag: async () => { throw boom; } }), async () => new Response("x"), deps);
  const { request, calls } = countingRequest();
  const res = await route(request, {});
  assert.equal(res.status, 404);
  assert.equal(calls.pulls, 0);
  assert.deepEqual(log, [{ tag: "flag_gate_test", error: boom }]);
});

test("the request body is never read on any gate path", async () => {
  const scenarios = [
    { name: "consent denied", deps: { requireCurrentConsent: async () => new Response(null, { status: 418 }) }, spec: {} as Record<string, unknown> },
    { name: "session throw", deps: { readSession: async () => { throw new Error("x"); } }, spec: {} },
    { name: "no session", deps: { readSession: async () => null }, spec: {} },
    { name: "sameOrigin mismatch", deps: {}, spec: { sameOrigin: true }, origin: "http://evil.example" },
    { name: "flag false", deps: {}, spec: { flag: async () => false } },
    { name: "flag throws", deps: {}, spec: { flag: async () => { throw new Error("x"); } } },
  ];
  for (const sc of scenarios) {
    const { deps } = fakeDeps(sc.deps);
    const route = withFlagGate(spec(sc.spec), async () => new Response("handler-read"), deps);
    const { request, calls } = countingRequest({ origin: sc.origin ?? BASE });
    await route(request, {});
    assert.equal(calls.pulls, 0, `${sc.name}: body was pulled before the handler`);
  }
});

test("handler runs only when the flag is ON, and receives (request, session, ctx)", async () => {
  type Seen = { req: Request; session: unknown; ctx: unknown };
  const seenBox: { value: Seen | null } = { value: null };
  const { deps } = fakeDeps();
  const route = withFlagGate(spec(), async (req, session, ctx) => {
    seenBox.value = { req, session, ctx };
    return new Response("ok", { status: 200 });
  }, deps);
  const { request } = countingRequest();
  const ctx = { params: { id: "1" } };
  const res = await route(request, ctx);
  assert.equal(res.status, 200);
  const seen = seenBox.value;
  assert.ok(seen);
  assert.equal(seen.req, request);
  assert.deepEqual(seen.session, { orgId: ORG });
  assert.equal(seen.ctx, ctx);
});

test("handler throws: 500, logged with the spec tag", async () => {
  const boom = new Error("handler boom");
  const { deps, log } = fakeDeps();
  const route = withFlagGate(spec(), async () => { throw boom; }, deps);
  const { request } = countingRequest();
  const res = await route(request, {});
  assert.equal(res.status, 500);
  assert.deepEqual(log, [{ tag: "flag_gate_test", error: boom }]);
});

test("headers: default private/no-store + Vary Cookie, overridable, and null body", async () => {
  const { deps } = fakeDeps();
  const defaulted = withFlagGate(spec({ flag: async () => false }), async () => new Response("x"), deps);
  const resA = await defaulted(countingRequest().request, {});
  assert.deepEqual(headerEntries(resA), { cc: "private, no-store", vary: "Cookie" });
  assert.equal(await resA.text(), "");

  const custom = withFlagGate(spec({ flag: async () => false, headers: { "X-Test": "1" } }), async () => new Response("x"), deps);
  const resB = await custom(countingRequest().request, {});
  assert.equal(resB.headers.get("x-test"), "1");
  assert.equal(resB.headers.get("cache-control"), null);
  assert.equal(await resB.text(), "");
});

test("the wrapped route carries FLAG_GATE metadata with the registry key (non-enumerable)", () => {
  const route = withFlagGate(spec({ flagKey: "brand_v3" }), async () => new Response("x"), fakeDeps().deps);
  assert.equal(route[FLAG_GATE], "brand_v3");
  assert.ok(!Object.keys(route).includes("FLAG_GATE"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(route, FLAG_GATE)?.enumerable, false);
});

// ---- (b) auto-enumeration by AST ----

const flagsYaml = readFileSync(new URL("../../ops/flags.yaml", import.meta.url), "utf8");

// A flagKey is "registered" when it appears, on its own line, in one of these accepted YAML shapes
// (fail closed otherwise):
//   "  brand_v3:"              registry key under `flags:`
//   "- brand_v3" / "- brand_v3:"  list-style entry
//   "  name: brand_v3"         explicit `name:` field
function isRegisteredFlagKey(key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const registryKey = new RegExp(`^\\s*-?\\s*(name:\\s*)?${esc}:?\\s*$`, "m");
  const nameField = new RegExp(`^\\s*name:\\s*${esc}\\s*$`, "m");
  return registryKey.test(flagsYaml) || nameField.test(flagsYaml);
}

function routeRequire(name: string): unknown {
  if (name.includes("flag-gate")) return { withFlagGate, FLAG_GATE };
  // Routes bind other server deps at import but never call them at module top level; stub leniently.
  return new Proxy(function () {}, { get: () => () => undefined, apply: () => undefined });
}

function isFlagGateModuleSpec(source: string): boolean {
  return source === "@/server/flag-gate" || /(^|\/)flag-gate$/.test(source);
}

type RouteAnalysis = {
  flagGateLocals: Set<string>;
  importsWithFlagGate: boolean;
  wrappedMethods: Set<string>;
  reexportSpecifiers: string[];
};

// Parse a route/module's top-level declarations: which HTTP exports are `export const X = <wfg>(...)`
// (where <wfg> is a withFlagGate import), whether it imports withFlagGate at all, and its re-exports.
function analyzeRouteSource(src: string): RouteAnalysis {
  const sf = ts.createSourceFile("route.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const flagGateLocals = new Set<string>();
  const wrappedMethods = new Set<string>();
  const reexportSpecifiers: string[] = [];
  let importsWithFlagGate = false;

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const source = stmt.moduleSpecifier.text;
      const bindings = stmt.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported === "withFlagGate" && isFlagGateModuleSpec(source)) {
            flagGateLocals.add(el.name.text);
            importsWithFlagGate = true;
          }
        }
      }
    } else if (ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          HTTP_METHODS.includes(decl.name.text) &&
          decl.initializer &&
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          flagGateLocals.has(decl.initializer.expression.text)
        ) {
          wrappedMethods.add(decl.name.text);
        }
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      // Covers both `export { X } from "..."` and `export * from "..."`.
      reexportSpecifiers.push(stmt.moduleSpecifier.text);
    }
  }
  return { flagGateLocals, importsWithFlagGate, wrappedMethods, reexportSpecifiers };
}

// Does a relative re-export target import withFlagGate? (Only sibling/relative modules are resolved;
// alias/absolute specifiers fall back to false — path-alias resolution is out of scope here.)
function reexportTargetImportsWithFlagGate(routeFile: string, spec: string): boolean {
  if (!spec.startsWith(".")) return false;
  const dir = path.dirname(routeFile);
  const candidates = [`${spec}.ts`, `${spec}.tsx`, path.join(spec, "index.ts"), path.join(spec, "index.tsx")];
  for (const c of candidates) {
    const abs = path.resolve(dir, c);
    if (existsSync(abs)) return analyzeRouteSource(readFileSync(abs, "utf8")).importsWithFlagGate;
  }
  return false;
}

type RouteRecord = {
  file: string;
  wrapped: Array<{ method: string; flagKey: unknown; hasMetadata: boolean }>;
  error: string | null;
};

const REEXPORT_ERROR = "declare withFlagGate in route.ts so the gate is discoverable";

function scanFlagGateRoutes(rootDir: string): RouteRecord[] {
  const records: RouteRecord[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name !== "route.ts") continue;

      const src = readFileSync(full, "utf8");
      const analysis = analyzeRouteSource(src);

      // A route.ts that re-exports a handler from a module importing withFlagGate hides the gate.
      let error: string | null = null;
      for (const spec of analysis.reexportSpecifiers) {
        if (reexportTargetImportsWithFlagGate(full, spec)) { error = REEXPORT_ERROR; break; }
      }

      // Only the AST-identified wrapped HTTP exports carry/need FLAG_GATE metadata; others are ignored.
      const wrapped: RouteRecord["wrapped"] = [];
      if (analysis.wrappedMethods.size > 0) {
        const mod = compileToExports(src, routeRequire);
        for (const method of analysis.wrappedMethods) {
          const fn = mod[method];
          const flagKey = typeof fn === "function" ? (fn as unknown as Record<symbol, unknown>)[FLAG_GATE] : undefined;
          wrapped.push({ method, flagKey, hasMetadata: flagKey !== undefined });
        }
      }

      if (wrapped.length > 0 || error) records.push({ file: full, wrapped, error });
    }
  };
  walk(rootDir);
  return records;
}

test("auto-enumeration: only withFlagGate-wrapped HTTP exports must carry a registered FLAG_GATE flagKey", () => {
  const appDir = fileURLToPath(new URL("../app", import.meta.url));
  for (const rec of scanFlagGateRoutes(appDir)) {
    assert.equal(rec.error, null, `${rec.file}: ${rec.error ?? ""}`);
    for (const w of rec.wrapped) {
      assert.equal(w.hasMetadata, true, `${rec.file} ${w.method}: missing FLAG_GATE metadata`);
      assert.equal(typeof w.flagKey, "string");
      assert.ok((w.flagKey as string).length > 0);
      assert.ok(isRegisteredFlagKey(w.flagKey as string), `flagKey not registered in ops/flags.yaml: ${String(w.flagKey)}`);
    }
  }
});

test("auto-enumeration fixture: a mixed module checks only the wrapped export; an unwrapped OPTIONS is ignored", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "flag-gate-scan-mixed-"));
  try {
    const routeDir = path.join(tmp, "api", "fixture");
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(path.join(routeDir, "route.ts"), [
      `import { withFlagGate } from "@/server/flag-gate";`,
      `export const POST = withFlagGate(`,
      `  { flagKey: "brand_v3", flag: () => true, tag: "fixture_route" },`,
      `  async () => new Response(null, { status: 200 }),`,
      `);`,
      `export const OPTIONS = () => new Response(null, { status: 204 });`,
      ``,
    ].join("\n"));
    const found = scanFlagGateRoutes(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].error, null);
    assert.deepEqual(found[0].wrapped.map((w) => w.method), ["POST"]);
    assert.equal(found[0].wrapped[0].hasMetadata, true);
    assert.equal(found[0].wrapped[0].flagKey, "brand_v3");
    assert.ok(isRegisteredFlagKey(found[0].wrapped[0].flagKey as string));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-enumeration fixture: a route.ts that re-exports a wrapped handler fails (gate not discoverable)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "flag-gate-scan-reexport-"));
  try {
    const routeDir = path.join(tmp, "api", "fixture");
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(path.join(routeDir, "handlers.ts"), [
      `import { withFlagGate } from "@/server/flag-gate";`,
      `export const POST = withFlagGate(`,
      `  { flagKey: "brand_v3", flag: () => true, tag: "fixture_route" },`,
      `  async () => new Response(null, { status: 200 }),`,
      `);`,
      ``,
    ].join("\n"));
    writeFileSync(path.join(routeDir, "route.ts"), `export { POST } from "./handlers";\n`);
    const found = scanFlagGateRoutes(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].error, REEXPORT_ERROR);
    assert.deepEqual(found[0].wrapped, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- (c) ratchet: per-file AST counts must equal allowances; total within the frozen baseline ----

test("ratchet: every allowlist entry equals its real AST flag-check count; total stays within the frozen baseline", async () => {
  const allowlist = JSON.parse(
    readFileSync(new URL("../../eslint-rules/flag-gate-allowlist.json", import.meta.url), "utf8"),
  ) as Record<string, number>;

  const total = Object.values(allowlist).reduce((a, b) => a + b, 0);
  // Ratchet may only decrease: total <= baseline (NO equality — a legitimate removal lowers it).
  assert.ok(
    total <= FLAG_GATE_ALLOWLIST_BASELINE,
    `allowlist total ${total} exceeds frozen baseline ${FLAG_GATE_ALLOWLIST_BASELINE}; the ratchet may only decrease`,
  );

  for (const [rel, allowance] of Object.entries(allowlist)) {
    assert.ok(Number.isInteger(allowance) && allowance >= 1, `bad allowlist count for ${rel}`);
    const abs = new URL(`../../${rel}`, import.meta.url);
    assert.ok(existsSync(abs), `allowlisted file missing: ${rel}`);
    const count = await countFlagChecks(readFileSync(abs, "utf8"), fileURLToPath(abs));
    // Exact equality: a stale/slack allowance (actual < allowance) OR an outgrown one (actual > allowance) fails.
    assert.equal(
      count,
      allowance,
      `${rel}: the AST rule finds ${count} hand-written flag check(s) but flag-gate-allowlist.json allows ${allowance}. ` +
        `Lower the allowance to ${count} — the allowlist must ratchet down and may never retain slack.`,
    );
  }
});

// ---- (d) rule proof: detection (aliases/computed/local) and the narrowed withFlagGate exemption ----

function ruleProofFile(): string {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  return path.join(repoRoot, "src/app/__flag_gate_rule_proof__/route.ts"); // NOT allowlisted
}

function lintSnippet(src: string, filename: string): Linter.LintMessage[] {
  const linter = new Linter({ configType: "flat" });
  const config: Linter.Config = {
    files: ["**/*.{ts,tsx}"],
    plugins: { condola: flagGatePlugin as unknown as NonNullable<Linter.Config["plugins"]>[string] },
    languageOptions: { ecmaVersion: 2022 as const, sourceType: "module" as const },
    rules: { "condola/flag-gate": "error" as const },
  };
  return linter.verify(src, config, { filename });
}

test("rule: a hand-written check is flagged; the deferred withFlagGate predicate is not", () => {
  const filename = ruleProofFile();

  const offending = [
    `export async function POST(session, headers) {`,
    `  if (!await brandV3EnabledForOrg(session.orgId)) return new Response(null, { status: 404, headers });`,
    `  return new Response(null);`,
    `}`,
  ].join("\n");
  const offendingMessages = lintSnippet(offending, filename);
  assert.equal(offendingMessages.length, 1, JSON.stringify(offendingMessages));
  assert.equal(offendingMessages[0].ruleId, "condola/flag-gate");

  const wrapped = [
    `import { withFlagGate } from "@/server/flag-gate";`,
    `export const POST = withFlagGate(`,
    `  { flagKey: "brand_v3", flag: (s) => brandV3EnabledForOrg(s.orgId), tag: "t", sameOrigin: true },`,
    `  async (request, session) => new Response(null, { status: 200 }),`,
    `);`,
  ].join("\n");
  const wrappedMessages = lintSnippet(wrapped, filename);
  assert.deepEqual(wrappedMessages, [], JSON.stringify(wrappedMessages));
});

test("rule: aliased imports and computed-member namespace calls are detected; locals are not", () => {
  const filename = ruleProofFile();

  const aliased = [
    `import { brandV3EnabledForOrg as brandCheck } from "@/server/brand-v3";`,
    `export async function GET() {`,
    `  return new Response(null, { status: (await brandCheck("org")) ? 200 : 404 });`,
    `}`,
  ].join("\n");
  const aliasedMsgs = lintSnippet(aliased, filename);
  assert.equal(aliasedMsgs.length, 1, JSON.stringify(aliasedMsgs));
  assert.equal(aliasedMsgs[0].ruleId, "condola/flag-gate");

  const nsDot = [
    `import * as flags from "@/server/brand-v3";`,
    `export async function GET() {`,
    `  return new Response(null, { status: (await flags.brandV3EnabledForOrg("org")) ? 200 : 404 });`,
    `}`,
  ].join("\n");
  assert.equal(lintSnippet(nsDot, filename).length, 1);

  const nsComputed = [
    `import * as flags from "@/server/brand-v3";`,
    `export async function GET() {`,
    `  return new Response(null, { status: (await flags["brandV3EnabledForOrg"]("org")) ? 200 : 404 });`,
    `}`,
  ].join("\n");
  assert.equal(lintSnippet(nsComputed, filename).length, 1);

  const localHelper = [
    `const isSubmitEnabled = () => true;`,
    `export function GET() {`,
    `  return new Response(null, { status: isSubmitEnabled() ? 200 : 404 });`,
    `}`,
  ].join("\n");
  const localMsgs = lintSnippet(localHelper, filename);
  assert.deepEqual(localMsgs, [], JSON.stringify(localMsgs));

  const combined = [
    `import { brandV3EnabledForOrg as brandCheck } from "@/server/brand-v3";`,
    `import * as flags from "@/server/brand-v3";`,
    `export async function GET() {`,
    `  const on = (await brandCheck("org")) || (await flags["brandV3EnabledForOrg"]("org"));`,
    `  return new Response(null, { status: on ? 200 : 404 });`,
    `}`,
  ].join("\n");
  assert.equal(lintSnippet(combined, filename).length, 2);
});

test("rule: the withFlagGate exemption is scoped to the deferred flag predicate of a flag-gate import", () => {
  const filename = ruleProofFile();

  // Eager evaluation inside the first argument is NOT the deferred predicate -> reported.
  const eager = [
    `import { withFlagGate } from "@/server/flag-gate";`,
    `import { brandV3EnabledForOrg } from "@/server/brand-v3";`,
    `export async function GET() {`,
    `  return withFlagGate(await brandV3EnabledForOrg("org"));`,
    `}`,
  ].join("\n");
  assert.equal(lintSnippet(eager, filename).length, 1);

  // A LOCAL function named withFlagGate must not grant the exemption.
  const localWrapper = [
    `import { brandV3EnabledForOrg } from "@/server/brand-v3";`,
    `const withFlagGate = (enabled) => enabled;`,
    `export default async function Page() {`,
    `  return withFlagGate(await brandV3EnabledForOrg("org")) ? "on" : "off";`,
    `}`,
  ].join("\n");
  assert.equal(lintSnippet(localWrapper, filename).length, 1);

  // The genuine deferred predicate of a flag-gate import (alias allowed) is exempt.
  const deferred = [
    `import { withFlagGate as gate } from "@/server/flag-gate";`,
    `import { brandV3EnabledForOrg } from "@/server/brand-v3";`,
    `export const GET = gate(`,
    `  { flagKey: "brand_v3", flag: (s) => brandV3EnabledForOrg(s.orgId), tag: "t" },`,
    `  async () => new Response(null, { status: 200 }),`,
    `);`,
  ].join("\n");
  const deferredMsgs = lintSnippet(deferred, filename);
  assert.deepEqual(deferredMsgs, [], JSON.stringify(deferredMsgs));
});
