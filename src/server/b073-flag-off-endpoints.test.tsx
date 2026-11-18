import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { brandV3EnabledForOrg } from "./brand-v3";
import { maintUnitAssignEnabledForOrg } from "./b059-maint-unit-assign";
import { NOTIFY_BLOCKS } from "./b073-notify-settings";
import { readCappedJson } from "./read-capped-json";

const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001";
const UNIT = "00000000-0000-4000-8000-000000000002";
const URL = "http://localhost";
function compile(source: string, mocks: Record<string, unknown> | ((name: string) => unknown)) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (typeof mocks === "function") return mocks(name);
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}

const cases = [
  { path: "src/app/api/owner-view/route.ts", input: { field: "showPhone", value: true } },
  { path: "src/app/api/team-security/route.ts", input: { required: true } },
  ...NOTIFY_BLOCKS.map(block => ({ path: "src/app/api/notify-settings/route.ts", input: { block, field: "leaseExpiry", value: true } })),
  { path: "src/app/o/units/[unitId]/page.tsx" },
  // B-059 (MGT-118): brand_v3 first, then maint_unit_assign (second table below).
  { path: "src/app/api/maint-unit-assign/route.ts", input: { requestId: UNIT, target: UNIT, units: [UNIT] } },
  { path: "src/app/m/assign/page.tsx" },
  { path: "src/app/m/assign/[id]/page.tsx" },
];
/** Routes behind brand_v3 AND their own flag: with brand_v3 ON, the item flag OFF (or a throwing lookup) is the 404. */
const itemCases = [
  { path: "src/app/api/maint-unit-assign/route.ts", input: { requestId: UNIT, target: UNIT, units: [UNIT] }, guard: "maintUnitAssignEnabledForOrg" },
  { path: "src/app/m/assign/page.tsx", guard: "maintUnitAssignEnabledForOrg" },
  { path: "src/app/m/assign/[id]/page.tsx", guard: "maintUnitAssignEnabledForOrg" },
];
const encode = (text: string) => new TextEncoder().encode(text);
function streamed(chunks: Uint8Array[], contentLength?: string, path = "/api/owner-view") {
  const calls = { pulls: 0, cancels: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[calls.pulls++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { calls.cancels += 1; },
  }, { highWaterMark: 0 }); // Don't prefetch independently of the handler.
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half",
    headers: { Origin: URL, "Content-Type": "application/json", ...(contentLength === undefined ? {} : { "Content-Length": contentLength }) } };
  return { request: new Request(`${URL}${path}`, init), calls };
}

function recordingDependency(name: string, calls: string[], allowed?: Record<string, unknown>): unknown {
  return new Proxy(() => undefined, {
    get(_target, key) {
      if (allowed && Object.prototype.hasOwnProperty.call(allowed, key)) return Reflect.get(allowed, key);
      const member = `${name}.${String(key)}`;
      calls.push(`read:${member}`);
      return recordingDependency(member, calls);
    },
    apply() {
      calls.push(`read:${name}`);
      return undefined;
    },
  });
}

function trackPageInput<T>(name: string, value: T, calls: string[]) {
  const promise = Promise.resolve(value);
  return new Proxy({ then: promise.then.bind(promise) }, {
    get(target, key, receiver) {
      calls.push(name);
      return Reflect.get(target, key, receiver);
    },
  });
}

function assertPageGuardOrder(path: string, source: string,
  expected: string[] = ["requireCurrentConsent", "getSession", "brandV3EnabledForOrg"], nth = 1) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const page = file.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  assert.ok(page && ts.isFunctionDeclaration(page) && page.body, `${path}: expected a default page function with a body`);

  const calls: string[] = [];
  let foundNotFound = false, seen = 0;
  function visit(node: ts.Node): void {
    if (foundNotFound) return;
    // Visit arguments first so a call inside notFound(...) counts before the 404.
    ts.forEachChild(node, visit);
    if (foundNotFound || !ts.isCallExpression(node)) return;
    const callee = node.expression.getText(file);
    if (callee === "notFound") foundNotFound = ++seen === nth;
    else calls.push(callee);
  }
  for (const statement of page.body.statements) {
    visit(statement);
    if (foundNotFound) break;
  }

  assert.ok(foundNotFound, `${path}: expected a notFound() call in the default export`);
  assert.deepEqual(calls, expected, path);
}

test("brand_v3-only endpoints: OFF and a throwing lookup both return 404 before API permission or body, unit reads, writes or audit", async () => {
  for (const { path, input } of cases) for (const fail of [false, true]) {
    const label = `${path} ${JSON.stringify(input)} ${fail ? "lookup failure" : "flag OFF"}`;
    const calls: string[] = [], lookups: string[] = [];
    const record = (name: string) => () => { calls.push(name); };
    const write = record("write"), writeAudit = record("audit");
    const save = async () => { calls.push("save"); write(); writeAudit(); return { ok: false, status: 404 }; };
    const source = read(path);
    const mocks = {
      "@/server/brand-v3": { brandV3EnabledForOrg: (orgId: string) => brandV3EnabledForOrg(orgId, {}, async id => {
        calls.push("flag"); lookups.push(id);
        if (fail) throw new Error("flag lookup failed");
        return false;
      }, async () => true) },
      "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); return null; } },
      "@/server/session": {
        readSession: async () => { calls.push("session"); return { orgId: ORG, kind: input ? "staff" : "owner", role: input ? "admin" : null }; },
        getSession: async () => { calls.push("session"); return { orgId: ORG, kind: "owner", role: null }; },
      },
      "@/server/b073-owner-view": { authorizeSettingsEdit: record("permission"), saveOwnerView: save },
      "@/server/b073-team": { saveTeamSecurity: save },
      "@/server/b073-notify-settings": { authorizeNotifySettings: record("permission"), saveNotifySetting: save },
      "@/server/read-capped-json": { readCappedJson: (request: Request) => { calls.push("body"); return readCappedJson(request); } },
      "@/server/errors": { logServerError: record("log") },
      "@/server/b092-owner-unit": { ownerUnit: record("read") },
      "@/server/b059-maint-unit-assign": { maintUnitAssignEnabledForOrg: record("item-flag"), authorizeAssign: record("permission"), saveAssign: save, ASSIGN_BODY_LIMIT: 96 * 1024 },
      "@/components/v3/owner/unit": {},
      "@/components/v3/owner/units": {},
      "next/navigation": { notFound: () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); } },
    };
    if (input) {
      const route = compile(source, mocks);
      const { request, calls: stream } = streamed([encode(JSON.stringify(input))], undefined, path.slice("src/app".length, -"/route.ts".length));
      const response = await (route.POST as (request: Request) => Promise<Response>)(request);
      assert.equal(response.status, 404, label);
      assert.equal(request.bodyUsed, false, label);
      assert.deepEqual(stream, { pulls: 0, cancels: 0 }, label);
      assert.deepEqual(calls, ["consent", "session", "flag"], label);
    } else {
      assertPageGuardOrder(path, source);
      const allowed = new Map<string, Record<string, unknown>>([
        ["@/server/consent-gate", {
          requireCurrentConsent: async (...args: unknown[]) => {
            calls.push("consent");
            assert.deepEqual(args, [undefined, "page"], label);
            return null;
          },
        }],
        ["@/server/session", { getSession: mocks["@/server/session"].getSession }],
        ["@/server/brand-v3", mocks["@/server/brand-v3"]],
        ["next/navigation", mocks["next/navigation"]],
      ]);
      const route = compile(source, (name: string) => recordingDependency(name, calls, allowed.get(name)));
      const Page = route.default as (props: unknown) => Promise<unknown>;
      // Ignore module-load accesses; CJS export reads during Page still hit the proxies.
      calls.length = 0;
      await assert.rejects(() => Page({
        params: trackPageInput("params", { unitId: UNIT }, calls),
        searchParams: trackPageInput("searchParams", {}, calls),
      }), /^Error: NEXT_NOT_FOUND$/, label);
      // Destructuring binds the tracked values; reading a property or awaiting either records an access.
      assert.deepEqual(calls, ["consent", "session", "flag", "notFound"], label);
    }
    assert.deepEqual(lookups, [ORG], label);
  }
});

test("brand_v3 + item-flag endpoints: brand_v3 ON with the item flag OFF or its lookup throwing return 404 before permission, body, reads, writes or audit", async () => {
  for (const { path, input, guard } of itemCases) for (const fail of [false, true]) {
    const label = `${path} ${fail ? "item lookup failure" : "item flag OFF"}`;
    const calls: string[] = [], lookups: string[] = [];
    const record = (name: string) => () => { calls.push(name); };
    const save = async () => { calls.push("save", "write", "audit"); return { ok: false, status: 404 }; };
    const brand = { brandV3EnabledForOrg: (orgId: string) => brandV3EnabledForOrg(orgId, {}, async () => { calls.push("flag"); return true; }, async () => true) };
    const item = { [guard]: (orgId: string) => maintUnitAssignEnabledForOrg(orgId, async id => {
      calls.push("item-flag"); lookups.push(id);
      if (fail) throw new Error("item flag lookup failed");
      return false;
    }) };
    const session = { orgId: ORG, kind: "staff", role: "admin" };
    const source = read(path);
    const notFound = () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); };
    if (input) {
      const route = compile(source, {
        "@/server/brand-v3": brand,
        "@/server/b059-maint-unit-assign": { ...item, authorizeAssign: record("permission"), saveAssign: save, ASSIGN_BODY_LIMIT: 96 * 1024 },
        "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); return null; } },
        "@/server/session": { readSession: async () => { calls.push("session"); return session; } },
        "@/server/read-capped-json": { readCappedJson: (request: Request) => { calls.push("body"); return readCappedJson(request); } },
        "@/server/errors": { logServerError: record("log") },
      });
      const { request, calls: stream } = streamed([encode(JSON.stringify(input))], undefined, path.slice("src/app".length, -"/route.ts".length));
      const response = await (route.POST as (request: Request) => Promise<Response>)(request);
      assert.equal(response.status, 404, label);
      assert.equal(request.bodyUsed, false, label);
      assert.deepEqual(stream, { pulls: 0, cancels: 0 }, label);
      assert.deepEqual(calls, ["consent", "session", "flag", "item-flag"], label);
    } else {
      assertPageGuardOrder(path, source, ["requireCurrentConsent", "getSession", "brandV3EnabledForOrg", guard], 2);
      const allowed = new Map<string, Record<string, unknown>>([
        ["@/server/consent-gate", { requireCurrentConsent: async (...args: unknown[]) => {
          calls.push("consent"); assert.deepEqual(args, [undefined, "page"], label); return null; } }],
        ["@/server/session", { getSession: async () => { calls.push("session"); return session; } }],
        ["@/server/brand-v3", brand],
        ["@/server/b059-maint-unit-assign", item],
        ["next/navigation", { notFound }],
      ]);
      const route = compile(source, (name: string) => recordingDependency(name, calls, allowed.get(name)));
      const Page = route.default as (props: unknown) => Promise<unknown>;
      calls.length = 0;
      await assert.rejects(() => Page({ params: trackPageInput("params", { id: UNIT }, calls), searchParams: trackPageInput("searchParams", {}, calls) }),
        /^Error: NEXT_NOT_FOUND$/, label);
      assert.deepEqual(calls, ["consent", "session", "flag", "item-flag", "notFound"], label);
    }
    assert.deepEqual(lookups, [ORG], label);
  }
});

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const path = `${dir}/${e.name}`;
  return e.isDirectory() ? walk(path) : [path];
});
test("brand_v3 endpoint registry covers every added route and page importing the flag", () => {
  const prod = "a4bf67306147a14cbd5b6c463521d8cb34cba874";
  const added = new Set(execFileSync("git", ["diff", "--name-only", "--diff-filter=A", prod, "HEAD", "--", "src/app"], { encoding: "utf8" }).trim().split("\n"));
  const covered = new Set(cases.map(row => row.path));
  const flagged = walk("src/app").filter(path => /\/(?:route\.ts|page\.tsx)$/.test(path)).filter(path =>
    ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest).statements.some(s =>
      ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "@/server/brand-v3"));
  for (const path of flagged) if (added.has(path)) assert.ok(covered.has(path), `Missing flag-OFF case: ${path}`);
  // An added route or page behind an item flag as well (B-059 maint_unit_assign) also needs its item-flag case.
  const itemCovered = new Set(itemCases.map(row => row.path));
  const itemFlagged = walk("src/app").filter(path => /\/(?:route\.ts|page\.tsx)$/.test(path)).filter(path =>
    /maintUnitAssignEnabledForOrg\(/.test(read(path)));
  for (const path of itemFlagged) if (added.has(path)) assert.ok(itemCovered.has(path), `Missing item-flag OFF case: ${path}`);
});

test("existing management pages and layout keep their flag-OFF regression tests", () => {
  // /m/settings, /m/roles, /m/notify, /m/account, /m/team, /m/audit and /m/layout are not OFF 404s.
  for (const [file, labels] of [
    ["b073-owner-view.test.tsx", ["/m/settings", "/m/roles", "/m/notify", "/m/account"]],
    ["b073-team.test.tsx", ["/m/team"]],
    ["b073-audit.test.tsx", ["/m/audit"]],
    ["b073-notify-settings.test.tsx", ["/m/notify page and layout"]],
  ] as const) {
    const titles = read(`src/server/${file}`).split("\n").filter(line => line.startsWith('test("') && line.includes("flag OFF"));
    for (const label of labels) assert.ok(titles.some(title => title.includes(label)), `Missing flag OFF test for ${label} in ${file}`);
  }
});

test("readCappedJson cancels an oversized stream as soon as it crosses 1 KiB, without Content-Length", async () => {
  const { request, calls } = streamed([new Uint8Array(1024), new Uint8Array(1024)]);
  assert.equal(request.headers.has("content-length"), false);
  assert.deepEqual(await readCappedJson(request), { ok: false, status: 413 });
  assert.deepEqual(calls, { pulls: 2, cancels: 1 });
});

test("readCappedJson rejects declared Content-Length 5000 without a pull", async () => {
  const { request, calls } = streamed([encode("{}")], "5000");
  assert.deepEqual(await readCappedJson(request), { ok: false, status: 413 });
  assert.equal(request.bodyUsed, false);
  assert.equal(calls.pulls, 0);
});

test("readCappedJson accepts exactly 1024 bytes, rejects invalid JSON and decodes split UTF-8", async () => {
  const value = "x".repeat(1022), exact = encode(JSON.stringify(value));
  assert.equal(exact.byteLength, 1024);
  assert.deepEqual(await readCappedJson(streamed([exact]).request), { ok: true, value });
  assert.deepEqual(await readCappedJson(streamed([encode("{")]).request), { ok: false, status: 400 });
  const utf8 = encode('"屋🙂"');
  assert.deepEqual(await readCappedJson(streamed([utf8.slice(0, 2), utf8.slice(2, 6), utf8.slice(6)]).request), { ok: true, value: "屋🙂" });
});
