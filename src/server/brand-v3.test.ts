import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { brandV3EnabledForOrg, brandV3ReadForOrg } from "./brand-v3";
import { brandRoot } from "../lib/brand-root";
import { BRAND_V2_PAGE_STYLES, brandV2EnabledForOrg } from "./brand-v2";
import { RoleAvatar } from "../components/v3/role-avatar";

const requireHere = createRequire(import.meta.url);
function compile(source: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (name === "react/jsx-runtime") return requireHere(name);
    if (name.endsWith(".css")) return {};
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}

test("PLT-46-AC3 / AC4: v3 needs an organization, effective v2 and the exact JSON boolean true", async () => {
  for (const org of [undefined, null, "", "org-a"]) {
    for (const effective of [false, true]) {
      for (const flag of [undefined, null, false, "true", "false", 0, 1, {}, [], true]) {
        let reads = 0;
        const result = await brandV3EnabledForOrg(org, {}, async id => {
          assert.equal(id, "org-a"); reads++; return flag;
        }, async () => effective);
        assert.equal(result, Boolean(org) && effective && flag === true);
        assert.equal(reads, org && effective ? 1 : 0);
      }
    }
  }
});

test("PLT-46-AC4: environment switches alone never activate v3 and errors fail closed", async () => {
  for (const env of [{}, { BRAND_V2: "true" }, { BRAND_V2: "true", BRAND_V3: "true" }]) {
    assert.equal(await brandV3EnabledForOrg(null, env), false);
    assert.equal(await brandV3EnabledForOrg("org", env, async () => false, async () => true), false);
  }
  const error = async () => { throw new Error("lookup failed"); };
  assert.equal(await brandV3EnabledForOrg("org", {}, error, async () => true), false);
  assert.equal(await brandV3EnabledForOrg("org", {}, async () => true, error), false);
  for (const effective of [false, true]) {
    assert.equal(await brandV3EnabledForOrg("org", {}, async () => true,
      (id, env) => brandV2EnabledForOrg(id, env, async () => effective)), effective);
  }
  const reader = readFileSync(new URL("./brand-v3.ts", import.meta.url), "utf8");
  assert.doesNotMatch(reader, /env\.BRAND_V3|env\[.BRAND_V3/);
  assert.match(reader, /cache\(async \(orgId/);
  assert.doesNotMatch(readFileSync("wrangler.jsonc", "utf8"), /BRAND_V3/);
});

test("PLT-46-AC1: flag OFF preserves the exact legacy attributes and ordered v2 stylesheets", () => {
  assert.deepEqual(brandRoot({ v2: false, v3: false }), { attributes: {}, stylesheets: [] });
  assert.deepEqual(brandRoot({ v2: false, v3: true }), { attributes: {}, stylesheets: [] });
  const baseline = { attributes: { "data-brand": "v2" }, stylesheets: ["/brand/v2/theme.css", ...BRAND_V2_PAGE_STYLES] };
  assert.deepEqual(brandRoot({ v2: true, v3: false }), baseline);
  assert.deepEqual(brandRoot({ v2: true, v3: true }), {
    attributes: { "data-brand": "v2", "data-brand-v3": "1" },
    stylesheets: [...baseline.stylesheets, "/brand/v3/theme.css", "/brand/v3/shell.css", "/brand/v3/today.css", "/brand/v3/money.css"],
  });
});

test("PLT-46-AC1: actual root layout OFF serialization matches the pre-v3 commit, for both locales and shells", async () => {
  const baseline = execFileSync("git", ["show", "7fa0018:src/app/layout.tsx"], { encoding: "utf8" });
  const current = readFileSync("src/app/layout.tsx", "utf8");
  for (const locale of ["zh-TW", "en"] as const) for (const v2 of [false, true]) for (const signedIn of [false, true]) {
    const session = signedIn ? { orgId: "org", name: "陳小明", kind: "staff", role: "admin" } : null;
    const stub = () => null;
    const mocks = {
      "next/headers": { headers: async () => ({ get: () => "/m" }) },
      "next/link": { __esModule: true, default: "a" },
      "@/i18n": { makeT: () => (key: string) => key },
      "@/components/auth-hash": { AuthHashForward: stub },
      "@/components/chunk-reload": { ChunkReloadListener: stub },
      "@/components/chrome": { BrandLink: stub, LocaleLinks: stub, ResetButton: stub, SignOutButton: stub },
      "@/components/required-validity": { RequiredValidity: stub },
      "@/components/env-mode": { EnvBanner: stub },
      "@/components/locale": { LocaleProvider: ({ children }: { children: React.ReactNode }) => children },
      "@/server/demo": { demoModeEnabled: () => false },
      "@/server/brand-v2": { BRAND_V2_PAGE_STYLES, brandV2EnabledForOrg: async () => v2 },
      "@/server/brand-v3": { brandV3EnabledForOrg: async () => false },
      "@/server/sandbox": { sandboxChrome: async () => ({ environment: "live" }) },
      "@/server/session": { requestPrefs: async () => ({ locale }), readSession: async () => session },
      "@/lib/brand-root": { brandRoot },
      "@/components/v3/role-avatar": { RoleAvatar },
    };
    const render = async (source: string) => {
      const layout = compile(source, mocks).default as (props: { children: React.ReactNode }) => Promise<React.ReactNode>;
      return renderToStaticMarkup(await layout({ children: React.createElement("main", null, "fixture") }));
    };
    assert.equal(await render(current), await render(baseline), `${locale}/${v2}/${signedIn}`);
    mocks["@/server/brand-v3"].brandV3EnabledForOrg = async () => v2 && signedIn;
    const on = await render(current);
    assert.equal(on.includes('data-brand-v3="1"'), v2 && signedIn);
    assert.equal((on.match(/href="\/brand\/v3\/theme.css"/g) ?? []).length, v2 && signedIn ? 1 : 0);
    if (v2 && signedIn) assert.ok(on.indexOf('/brand/v3/theme.css') > on.indexOf('/brand/v2/pages/m-home.css'));
  }
});


test("brandV3ReadForOrg: same on/off rule as the page helper, but a failed read throws (readers report unavailable)", async () => {
  const flags = (v2: unknown, v3: unknown) => async () => ({ v2, v3 });
  assert.equal(await brandV3ReadForOrg(null, {}, flags(true, true)), false);
  assert.equal(await brandV3ReadForOrg("o", {}, flags(true, true)), true);
  assert.equal(await brandV3ReadForOrg("o", {}, flags(false, true)), false);
  assert.equal(await brandV3ReadForOrg("o", { BRAND_V2: "true" }, flags(false, true)), true);
  assert.equal(await brandV3ReadForOrg("o", { BRAND_V2: "true" }, flags(false, "true")), false, "only JSON true");
  assert.equal(await brandV3ReadForOrg("o", {}, async () => undefined), false, "unknown org is off");
  await assert.rejects(brandV3ReadForOrg("o", {}, async () => { throw new Error("db down"); }), /db down/);
});
