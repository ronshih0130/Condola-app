import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { brandV3EnabledForOrg } from "./brand-v3";
import { NOTIFY_BLOCKS } from "./b073-notify-settings";
import { readCappedJson } from "./read-capped-json";

const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001";
const UNIT = "00000000-0000-4000-8000-000000000002";
const URL = "http://localhost";
function compile(source: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
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

test("brand_v3-only endpoints: OFF and a throwing lookup both return 404 before body, writes, audit or page consent", async () => {
  for (const { path, input } of cases) for (const fail of [false, true]) {
    const label = `${path} ${JSON.stringify(input)} ${fail ? "lookup failure" : "flag OFF"}`;
    const calls: string[] = [], lookups: string[] = [];
    const record = (name: string) => () => { calls.push(name); };
    const write = record("write"), writeAudit = record("audit");
    const save = async () => { calls.push("save"); write(); writeAudit(); return { ok: false, status: 404 }; };
    const route = compile(read(path), {
      "@/server/brand-v3": { brandV3EnabledForOrg: (orgId: string) => brandV3EnabledForOrg(orgId, {}, async id => {
        calls.push("flag"); lookups.push(id);
        if (fail) throw new Error("flag lookup failed");
        return false;
      }, async () => true) },
      "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); return null; } },
      "@/server/session": {
        readSession: async () => { calls.push("session"); return { orgId: ORG, kind: input ? "staff" : "owner", role: input ? "admin" : null }; },
      },
      "@/server/b073-owner-view": { authorizeSettingsEdit: record("permission"), saveOwnerView: save },
      "@/server/b073-team": { saveTeamSecurity: save },
      "@/server/b073-notify-settings": { authorizeNotifySettings: record("permission"), saveNotifySetting: save },
      "@/server/read-capped-json": { readCappedJson: (request: Request) => { calls.push("body"); return readCappedJson(request); } },
      "@/server/errors": { logServerError: record("log") },
      "@/server/b092-owner-unit": { ownerUnit: record("read") },
      "@/components/v3/owner/unit": {},
      "@/components/v3/owner/units": {},
      "next/navigation": { notFound: () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); } },
    });
    if (input) {
      const { request, calls: stream } = streamed([encode(JSON.stringify(input))], undefined, path.slice("src/app".length, -"/route.ts".length));
      const response = await (route.POST as (request: Request) => Promise<Response>)(request);
      assert.equal(response.status, 404, label);
      assert.equal(request.bodyUsed, false, label);
      assert.deepEqual(stream, { pulls: 0, cancels: 0 }, label);
      assert.deepEqual(calls, ["consent", "session", "flag"], label);
    } else {
      const Page = route.default as (props: unknown) => Promise<unknown>;
      await assert.rejects(() => Page({ params: Promise.resolve({ unitId: UNIT }), searchParams: Promise.resolve({}) }), /^Error: NEXT_NOT_FOUND$/, label);
      assert.deepEqual(calls, ["session", "flag", "notFound"], label);
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
