import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const ORG = "00000000-0000-4000-8000-000000000001";
const BASE = "http://localhost";

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
