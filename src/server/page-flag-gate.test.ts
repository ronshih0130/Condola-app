import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { brandV3EnabledForOrg } from "./brand-v3";
import { maintUnitAssignEnabledForOrg } from "./b059-maint-unit-assign";
import { FLAG_GATE as REAL_FLAG_GATE } from "./flag-gate";

// Lauren 2c: withPageFlagGate (src/server/page-flag-gate.ts) unit tests. Gate pages today run, in this order:
//   await requireCurrentConsent(undefined, "page"); const session = await getSession(); if (!(await flag)) notFound();
// (see assertPageGuardOrder in b073-flag-off-endpoints.test.tsx). The wrapper must keep that order, read nothing from
// props before the gate, and let a throwing predicate propagate exactly as today's pages do.

const ORG = "00000000-0000-4000-8000-000000000001";
const UNIT = "00000000-0000-4000-8000-000000000002";

// ---- Loading page-flag-gate.ts in isolation (same transpile+mock style as flag-gate.test.ts) ----

function compileToExports(source: string, requireFn: (name: string) => unknown): Record<string, unknown> {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)(requireFn, exports);
  return exports;
}

function loadFlagGate() {
  return compileToExports(readFileSync(new URL("./flag-gate.ts", import.meta.url), "utf8"), (name) => {
    if (name === "@/server/consent-gate") return { requireCurrentConsent: async () => null };
    if (name === "@/server/session") return { readSession: async () => null };
    if (name === "@/server/errors") return { logServerError: () => {} };
    throw new Error(`Unmocked dependency in flag-gate.ts: ${name}`);
  });
}

function loadPageFlagGate() {
  const flagGate = loadFlagGate();
  return compileToExports(readFileSync(new URL("./page-flag-gate.ts", import.meta.url), "utf8"), (name) => {
    // Defaults are never exercised here (tests inject deps), but the module binds them at load.
    if (name === "next/navigation") return { notFound: () => { throw new Error("default notFound used"); } };
    if (name === "@/server/consent-gate") return { requireCurrentConsent: async () => { throw new Error("default consent used"); } };
    if (name === "@/server/session") return { getSession: async () => { throw new Error("default session used"); } };
    if (name === "@/server/flag-gate") return flagGate;
    throw new Error(`Unmocked dependency in page-flag-gate.ts: ${name}`);
  });
}

type Session = { orgId: string; kind: string; role: string | null };
type Props = Record<string, unknown>;
type Gated = ((props: Props) => Promise<unknown>) & Record<symbol, unknown>;
type WithPageFlagGate = (
  spec: { flagKey: string; flag: (session: Session) => boolean | Promise<boolean> },
  Page: (props: Props, session: Session) => unknown,
  deps?: Record<string, unknown>,
) => Gated;

const pageFlagGate = loadPageFlagGate();
const withPageFlagGate = pageFlagGate.withPageFlagGate as WithPageFlagGate;
const FLAG_GATE = REAL_FLAG_GATE as symbol;

// ---- Fakes ----

const SESSION: Session = { orgId: ORG, kind: "staff", role: "admin" };
const NOT_FOUND = "NEXT_NOT_FOUND";

/** Records every gate step in order. Each fake can be overridden per test. */
function harness(over: {
  consent?: (...args: unknown[]) => Promise<unknown>;
  session?: () => Promise<Session>;
  flag?: (session: Session) => boolean | Promise<boolean>;
  notFound?: () => never;
} = {}) {
  const calls: string[] = [];
  const seen: { consentArgs?: unknown[]; flagSession?: unknown; pageArgs?: unknown[] } = {};
  const deps = {
    requireCurrentConsent: async (...args: unknown[]) => {
      calls.push("consent"); seen.consentArgs = args;
      return over.consent ? over.consent(...args) : null;
    },
    getSession: async () => { calls.push("session"); return over.session ? over.session() : SESSION; },
    notFound: () => { calls.push("notFound"); if (over.notFound) return over.notFound(); throw new Error(NOT_FOUND); },
  };
  const spec = {
    flagKey: "brand_v3",
    flag: (session: Session) => { calls.push("flag"); seen.flagSession = session; return over.flag ? over.flag(session) : true; },
  };
  const Page = (...args: unknown[]) => { calls.push("page"); seen.pageArgs = args; return "rendered"; };
  return { calls, seen, deps, spec, Page };
}

/**
 * Next passes `{ params, searchParams }`, both Promises. Every trap on props and every property read on either promise
 * (including `then`, i.e. any await) is recorded, so "untouched" means the log stays empty.
 */
function trackedProps(log: string[]) {
  const thenable = (name: string, value: unknown) => {
    const promise = Promise.resolve(value);
    return new Proxy(promise, {
      get(target, key) { log.push(`${name}.${String(key)}`); const v = Reflect.get(target, key, target); return typeof v === "function" ? v.bind(target) : v; },
      has(target, key) { log.push(`${name} has ${String(key)}`); return Reflect.has(target, key); },
    });
  };
  const inner = { params: thenable("params", { id: UNIT }), searchParams: thenable("searchParams", { after: "x" }) };
  const handler: ProxyHandler<typeof inner> = {};
  for (const trap of ["get", "has", "ownKeys", "getOwnPropertyDescriptor", "set", "defineProperty", "deleteProperty", "getPrototypeOf"] as const) {
    (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
      log.push(`props.${trap}${args.length > 1 ? `:${String(args[1])}` : ""}`);
      return (Reflect[trap] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return new Proxy(inner, handler) as unknown as Props;
}

// ---- Module load and marker ----

test("the wrapper module loads without throwing, isolated and as the real module with its real dependencies", async () => {
  assert.equal(typeof pageFlagGate.withPageFlagGate, "function");
  const real = await import("./page-flag-gate");
  assert.equal(typeof real.withPageFlagGate, "function");
  // Wrapping with the REAL default deps must not call them: nothing runs until Next renders the page.
  const page = real.withPageFlagGate({ flagKey: "brand_v3", flag: () => { throw new Error("flag ran at wrap time"); } },
    () => { throw new Error("page ran at wrap time"); });
  assert.equal(typeof page, "function");
  assert.equal((page as unknown as Record<symbol, unknown>)[REAL_FLAG_GATE], "brand_v3");
});

test("the wrapped page carries the FLAG_GATE marker (the flag-gate.ts symbol) with the registry key, non-enumerable and frozen", () => {
  assert.equal(FLAG_GATE, Symbol.for("condola.flag-gate"));
  const { spec, Page, deps } = harness();
  const page = withPageFlagGate({ ...spec, flagKey: "maint_unit_assign" }, Page, deps);
  assert.equal(page[FLAG_GATE], "maint_unit_assign");
  assert.equal(typeof page[FLAG_GATE], "string");
  assert.deepEqual(Object.keys(page), []);
  assert.deepEqual(Object.getOwnPropertyDescriptor(page, FLAG_GATE),
    { value: "maint_unit_assign", enumerable: false, writable: false, configurable: false });
  assert.match(readFileSync("ops/flags.yaml", "utf8"), /^  maint_unit_assign:$/m, "fixture key is a registry key");
  // Next calls the default export with one argument (props); the wrapper does not change that arity.
  assert.equal(page.length, 1);
});

// ---- Gate order ----

test("flag ON: consent(undefined, \"page\") → getSession → flag(session) → Page(props, session); the page result is returned", async () => {
  const { calls, seen, deps, spec, Page } = harness();
  const log: string[] = [];
  const props = trackedProps(log);
  const result = await withPageFlagGate(spec, Page, deps)(props);
  assert.equal(result, "rendered");
  assert.deepEqual(calls, ["consent", "session", "flag", "page"]);
  assert.deepEqual(seen.consentArgs, [undefined, "page"]);
  assert.equal(seen.flagSession, SESSION);
  assert.equal(seen.pageArgs?.length, 2);
  assert.equal(seen.pageArgs?.[0], props, "the very props object Next passed");
  assert.equal(seen.pageArgs?.[1], SESSION, "the gate's session");
  assert.deepEqual(log, [], "the wrapper itself never touches props, params or searchParams");
});

test("flag OFF: consent → session → flag → notFound(); the page never runs", async () => {
  for (const off of [false, async () => false] as const) {
    const { calls, deps, spec, Page } = harness({ flag: typeof off === "function" ? off : () => off });
    await assert.rejects(() => withPageFlagGate(spec, Page, deps)({}), new RegExp(`^Error: ${NOT_FOUND}$`));
    assert.deepEqual(calls, ["consent", "session", "flag", "notFound"]);
  }
});

test("flag OFF stays closed even if notFound() were to return: the page is not rendered", async () => {
  const { calls, deps, spec, Page } = harness({ flag: () => false, notFound: (() => undefined) as unknown as () => never });
  assert.equal(await withPageFlagGate(spec, Page, deps)({}), undefined);
  assert.deepEqual(calls, ["consent", "session", "flag", "notFound"]);
});

test("a throwing or rejecting flag lookup propagates unchanged, as from today's pages (no notFound, no page, no fail-closed 404)", async () => {
  for (const [name, flag] of [
    ["sync throw", () => { throw new Error("flag lookup failed"); }],
    ["async reject", async () => { throw new Error("flag lookup failed"); }],
  ] as const) {
    const { calls, deps, spec, Page } = harness({ flag });
    await assert.rejects(() => withPageFlagGate(spec, Page, deps)({}), /^Error: flag lookup failed$/, name);
    assert.deepEqual(calls, ["consent", "session", "flag"], name);
  }
});

test("the gate is evaluated on every render (no caching across requests)", async () => {
  let on = true;
  const { calls, deps, spec, Page } = harness({ flag: () => on });
  const page = withPageFlagGate(spec, Page, deps);
  assert.equal(await page({}), "rendered");
  on = false;
  await assert.rejects(() => page({}), new RegExp(NOT_FOUND));
  assert.deepEqual(calls, ["consent", "session", "flag", "page", "consent", "session", "flag", "notFound"]);
});

// ---- Consent and session ----

test("consent denial: the guard's redirect propagates; session, flag and page never run", async () => {
  const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/consent?next=%2Fm%2Fassign;307;" });
  const { calls, deps, spec, Page } = harness({ consent: async () => { throw redirect; } });
  await assert.rejects(() => withPageFlagGate(spec, Page, deps)({}), (error) => error === redirect);
  assert.deepEqual(calls, ["consent"]);
});

test("consent return value is ignored exactly like today's pages (page mode only returns null or redirects)", async () => {
  const { calls, deps, spec, Page } = harness({ consent: async () => new Response(null, { status: 403 }) });
  assert.equal(await withPageFlagGate(spec, Page, deps)({}), "rendered");
  assert.deepEqual(calls, ["consent", "session", "flag", "page"]);
});

test("no session: getSession's redirect to /login propagates; a session read error propagates; flag and page never run", async () => {
  const toLogin = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
  for (const error of [toLogin, new Error("session read failed")]) {
    const { calls, deps, spec, Page } = harness({ session: async () => { throw error; } });
    await assert.rejects(() => withPageFlagGate(spec, Page, deps)({}), (e) => e === error);
    assert.deepEqual(calls, ["consent", "session"]);
  }
});

test("a page error propagates unchanged (the wrapper catches nothing)", async () => {
  const boom = new Error("page boom");
  const { deps, spec } = harness();
  await assert.rejects(() => withPageFlagGate(spec, () => { throw boom; }, deps)({}), (e) => e === boom);
  await assert.rejects(() => withPageFlagGate(spec, async () => { throw boom; }, deps)({}), (e) => e === boom);
});

// ---- props / params / searchParams ----

test("props, params and searchParams are never read, awaited or enumerated on any closed gate path", async () => {
  const redirect = new Error("NEXT_REDIRECT");
  const scenarios = [
    { name: "consent redirect", over: { consent: async () => { throw redirect; } } },
    { name: "no session", over: { session: async () => { throw redirect; } } },
    { name: "flag OFF", over: { flag: () => false } },
    { name: "flag OFF (async)", over: { flag: async () => false } },
    { name: "flag throws", over: { flag: () => { throw new Error("x"); } } },
    { name: "flag rejects", over: { flag: async () => { throw new Error("x"); } } },
  ];
  for (const { name, over } of scenarios) {
    const { calls, deps, spec, Page } = harness(over);
    const log: string[] = [];
    await assert.rejects(() => withPageFlagGate(spec, Page, deps)(trackedProps(log)), name);
    assert.ok(!calls.includes("page"), name);
    assert.deepEqual(log, [], `${name}: props touched before the gate`);
  }
  // Sanity: the tracker does see a page that reads them, so an empty log above is meaningful.
  const { deps, spec } = harness();
  const log: string[] = [];
  await withPageFlagGate(spec, async ({ params, searchParams }) => [await params, await searchParams], deps)(trackedProps(log));
  assert.ok(log.includes("props.get:params") && log.includes("params.then") && log.includes("searchParams.then"), log.join());
});

// ---- Several flags in one predicate (brand_v3 then an item flag, as the 2b maint-unit-assign route does) ----

test("brand_v3 && item flag: order is kept, the item flag is read only when brand_v3 is ON", async () => {
  const run = async (brand: boolean, item: boolean) => {
    const order: string[] = [];
    const { calls, deps, Page } = harness();
    const spec = { flagKey: "maint_unit_assign", flag: async (session: Session) => {
      calls.push("flag");
      return await (async () => { order.push(`brand_v3:${session.orgId}`); return brand; })()
        && await (async () => { order.push(`maint_unit_assign:${session.orgId}`); return item; })();
    } };
    const out = await withPageFlagGate(spec, Page, deps)({}).then(() => "rendered", (e: Error) => e.message);
    return { out, order, calls };
  };
  assert.deepEqual(await run(false, true), { out: NOT_FOUND, order: [`brand_v3:${ORG}`], calls: ["consent", "session", "flag", "notFound"] });
  assert.deepEqual(await run(true, false), { out: NOT_FOUND, order: [`brand_v3:${ORG}`, `maint_unit_assign:${ORG}`], calls: ["consent", "session", "flag", "notFound"] });
  assert.deepEqual(await run(true, true), { out: "rendered", order: [`brand_v3:${ORG}`, `maint_unit_assign:${ORG}`], calls: ["consent", "session", "flag", "page"] });
});

test("the real gate-page predicates under the wrapper: a failing lookup is OFF (404), never a propagated error", async () => {
  const lookups: string[] = [];
  const fail = (name: string) => async () => { lookups.push(name); throw new Error(`${name} lookup failed`); };
  for (const [name, flag, expected] of [
    ["brand_v3 lookup fails", (s: Session) => brandV3EnabledForOrg(s.orgId, {}, fail("brand_v3"), async () => true), ["brand_v3"]],
    ["item lookup fails", async (s: Session) => await brandV3EnabledForOrg(s.orgId, {}, async () => true, async () => true)
      && await maintUnitAssignEnabledForOrg(s.orgId, fail("maint_unit_assign")), ["maint_unit_assign"]],
  ] as const) {
    lookups.length = 0;
    const { calls, deps, spec, Page } = harness({ flag });
    await assert.rejects(() => withPageFlagGate(spec, Page, deps)({}), new RegExp(`^Error: ${NOT_FOUND}$`), name);
    assert.deepEqual(calls, ["consent", "session", "flag", "notFound"], name);
    assert.deepEqual(lookups, expected, name);
  }
});

test("a role precondition joined with && (e.g. /o/leases/[id]/settlement: kind !== \"owner\" || !brand_v3) skips the flag lookup", async () => {
  let lookups = 0;
  const brand = async () => { lookups += 1; return true; };
  for (const [kind, out, n] of [["staff", NOT_FOUND, 0], ["owner", "rendered", 1]] as const) {
    lookups = 0;
    const { deps, spec, Page } = harness({ session: async () => ({ ...SESSION, kind }) });
    const page = withPageFlagGate({ ...spec, flag: async (s) => s.kind === "owner" && await brand() }, Page, deps);
    assert.equal(await page({}).then(String, (e: Error) => e.message), out, kind);
    assert.equal(lookups, n, kind);
  }
});
