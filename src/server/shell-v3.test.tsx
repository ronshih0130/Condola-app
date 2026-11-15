import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import * as i18n from "../i18n";
import * as copy from "../i18n/lanes/brand-v3";
import * as nav from "./nav-v3";
import { noPermHref, roleHome } from "./perms";
import { brandRoot } from "../lib/brand-root";
import { RoleAvatar } from "../components/v3/role-avatar";
import { ShellIcon } from "../components/v3/shell/icon";
import type { Session } from "./types";

const requireHere = createRequire(import.meta.url);
function compile(source: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (name === "react" || name === "react/jsx-runtime") return requireHere(name);
    if (name.endsWith(".css")) return {};
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}
const source = (file: string) => readFileSync(file, "utf8");
const stub = ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => <div data-props={JSON.stringify(props)}>{children}</div>;
const session: Session = { kind: "staff", role: "admin", orgId: "org", liveOrgId: "org", userId: "user", sessionId: "session", name: "陳小明", email: "fixture@example.invalid", locale: "zh-TW", environment: "live", calendar: "gregorian", leaseId: null };
const link = { __esModule: true, default: "a" };
async function renderLayout(text: string, mocks: Record<string, unknown>) {
  const layout = compile(text, mocks).default as (props: { children: React.ReactNode }) => Promise<React.ReactNode>;
  return renderToStaticMarkup(await layout({ children: <main data-testid="content">fixture</main> }));
}

test("PLT-46-AC1 / MGT-47-AC1: root OFF is byte-identical to 529b4fa, ON only replaces staff /m header", async () => {
  const old = execFileSync("git", ["show", "529b4fa:src/app/layout.tsx"], { encoding: "utf8" });
  for (const locale of ["zh-TW", "en"] as const) for (const kind of ["staff", "tenant", "owner"] as const) for (const environment of ["live", "sandbox"] as const) for (const path of ["/m", "/m/payments", "/t", "/consent"]) {
    let on = false;
    const actor = { ...session, locale, kind, environment };
    const mocks = {
      "next/headers": { headers: async () => ({ get: () => path }) }, "next/link": link,
      "@/i18n": i18n,
      "@/components/auth-hash": { AuthHashForward: stub }, "@/components/chunk-reload": { ChunkReloadListener: stub },
      "@/components/chrome": { BrandLink: stub, LocaleLinks: stub, ResetButton: stub, SignOutButton: stub },
      "@/components/required-validity": { RequiredValidity: stub }, "@/components/env-mode": { EnvBanner: stub },
      "@/components/locale": { LocaleProvider: stub }, "@/server/demo": { demoModeEnabled: () => true },
      "@/server/brand-v2": { brandV2EnabledForOrg: async () => true }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => on },
      "@/server/sandbox": { sandboxChrome: async () => ({ environment }) },
      "@/server/session": { requestPrefs: async () => ({ locale }), readSession: async () => actor },
      "@/lib/brand-root": { brandRoot }, "@/components/v3/role-avatar": { RoleAvatar },
    };
    assert.equal(await renderLayout(source("src/app/layout.tsx"), mocks), await renderLayout(old, mocks));
    on = true;
    const html = await renderLayout(source("src/app/layout.tsx"), mocks);
    assert.equal(html.includes('class="top"'), !(kind === "staff" && path.startsWith("/m")));
    assert.ok(html.includes('data-testid="site-footer"'));
  }
});

test("PLT-46-AC1 / PLT-44-AC8: manager OFF preserves markup, readers and redirect order", async () => {
  const old = execFileSync("git", ["show", "529b4fa:src/app/m/layout.tsx"], { encoding: "utf8" });
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) for (const environment of ["live", "sandbox"] as const) for (const hidden of [false, true]) {
    const actor = { ...session, role, environment };
    let calls: string[] = [];
    let on = false;
    const path = role === "maintenance" ? "/m/tickets" : "/m";
    const mocks = {
      "next/headers": { headers: async () => ({ get: () => path }), cookies: async () => { calls.push("cookies"); return { get: () => ({ value: hidden ? "1" : "0" }) }; } },
      "next/navigation": { redirect: (to: string) => { throw new Error(to); } }, "@/build-info": { BUILD_SHA: "fixture" },
      "@/components/chrome": { Sidebar: stub, TaskPanel: stub },
      "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); } },
      "@/server/demo": { demoModeEnabled: () => true }, "@/server/perms": { noPermHref: (p: string, s: Session) => { calls.push("permission"); return noPermHref(p, s); } },
      "@/server/queries": { loadManagerChrome: async () => { calls.push("chrome"); return { flags: { property: true }, firm: { name: "fixture" }, badge: { pending: 2, tickets: 3 } }; } },
      "@/server/session": { getSession: async () => actor },
      "@/server/b056-trial": { trialBannerFor: async () => { calls.push("trial"); return { kind: "fixture" }; } },
      "@/components/b056-trial-banner": { TrialBanner: stub }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => on },
      "@/server/nav-v3": nav, "@/components/v3/shell/manager-shell": { ManagerShellV3: stub },
    };
    const baseline = await renderLayout(old, mocks); const baselineCalls = calls;
    calls = []; assert.equal(await renderLayout(source("src/app/m/layout.tsx"), mocks), baseline);
    assert.deepEqual(calls, baselineCalls);
    on = true; calls = [];
    const html = await renderLayout(source("src/app/m/layout.tsx"), mocks);
    assert.deepEqual(calls, baselineCalls);
    assert.doesNotMatch(html, /class="app"|id="nav-open"/);
    assert.ok(html.includes('data-testid="content"'));
  }
});

test("PLT-44-AC2/AC6/AC10/AC11/AC13/AC15, PLT-48-AC2: shared identity, current nav and interim controls", () => {
  let path = "/m";
  const mocks = {
    "next/link": link, "next/navigation": { usePathname: () => path }, "../../../i18n": i18n,
    "../../../i18n/lanes/brand-v3": copy, "../../../server/nav-v3": nav,
    "../../chrome": { LocaleLinks: stub, ResetButton: stub, SignOutButton: stub },
    "../role-avatar": { RoleAvatar }, "./icon": { ShellIcon },
  };
  const Shell = compile(source("src/components/v3/shell/manager-shell.tsx"), mocks).ManagerShellV3 as React.ComponentType<Record<string, unknown>>;
  for (path of ["/m", "/m/payments", "/m/more", "/m/units"]) {
    const html = renderToStaticMarkup(<Shell areas={nav.areasFor(session)} tabs={nav.tabsFor(session)} locale="zh-TW" name={session.name} role="admin" firm="安居代管" sandbox={false} showReset={true} buildSha="fixture" trialBanner={<p>trial</p>}><h1>content</h1></Shell>);
    assert.match(html, /<div class="cap">安居代管｜陳小明（管理員）<\/div>/);
    assert.match(html, /party-name" aria-hidden="true">陳/);
    assert.match(html, /<span class="page-title-desk">/);
    assert.equal((html.match(/data-testid="org-switch"/g) ?? []).length, 1);
    assert.equal((html.match(/data-testid="build-sha"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /class="top"|class="side"|tryout-panel|href="\/m\/(properties|leases)\/new"/);
    const activeTab = path === "/m" ? "today" : path === "/m/units" ? "properties" : "more";
    assert.match(html.split('data-testid="v3-phone-tabs"')[1], new RegExp(`data-area="${activeTab}" class="on" aria-current="page"`));
  }
});

test("MGT-47-AC3: More is staff-only, navigation-only, admits custom roles, and is absent when OFF", async () => {
  let on = false; let actor: Session = session; const calls: string[] = [];
  const mocks = {
    "next/navigation": { notFound: () => { throw new Error("404"); } }, "next/link": link,
    "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); } },
    "@/server/session": { getSession: async () => actor },
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => { calls.push("flag"); return on; } },
    "@/server/nav-v3": nav, "@/i18n/lanes/brand-v3": copy, "@/components/v3/shell/icon": { ShellIcon },
  };
  assert.doesNotMatch(source("src/app/m/more/page.tsx"), /guardEffectiveSession|query\(|tx\(|svc\(/);
  const Page = compile(source("src/app/m/more/page.tsx"), mocks).default as () => Promise<React.ReactNode>;
  await assert.rejects(Page, /404/); assert.deepEqual(calls, ["consent", "flag"]);
  on = true; const html = renderToStaticMarkup(await Page());
  assert.match(html, /href="\/m\/rent"/); assert.match(html, /href="\/m\/tickets"/); assert.match(html, /href="\/m\/settings"/);
  assert.doesNotMatch(html, /href="\/m\/properties"|href="\/m\/messages"/);
  // A fully granted custom role reaches 更多 (it is one of its tabs) and sees only its permitted links.
  actor = { ...session, customRole: { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId, nativeRole: "admin",
    keys: ["dash.view", "props.view", "messages.send", "stmt.view", "pay.record", "tickets.update"], audit: false, photos: false } as Session["customRole"] };
  assert.ok(nav.tabsFor(actor).some((tab: { id: string }) => tab.id === "more"));
  const customHtml = renderToStaticMarkup(await Page());
  assert.match(customHtml, /href="\/m\/rent"/); assert.doesNotMatch(customHtml, /href="\/m\/bank"|href="\/m\/settings"/);
  actor = { ...session, kind: "tenant" }; await assert.rejects(Page, /404/);
});

test("PLT-46-AC1: consent actions read the brand flag only when `next` gives no destination", async () => {
  let reads = 0; let actor: Session = session;
  const mocks = {
    "@/server/b017-custom-role-governance": { guardEffectiveSession: async (s: Session) => s },
    "next/navigation": { redirect: (to: string) => { throw new Error(`redirect:${to}`); } },
    "./consent-gate": { passConsentGate: async () => ({ ok: true }), consentNextPath: (await import("./consent-gate")).consentNextPath },
    "./role-home-v3": { roleHomeForSession: async () => { reads++; return "/m/payments"; } },
    "./signup": { readSignupIdentity: async () => ({ user_id: "user" }) },
    "./session": { readSession: async () => actor },
  };
  const mod = compile(source("src/server/consent-actions.ts"), mocks) as Record<string, (f: FormData) => Promise<void>>;
  const form = (next: string) => { const f = new FormData(); f.set("next", next); f.set("consent", "on"); return f; };
  await assert.rejects(mod.actionAcceptReconsent(form("/m/leases")), /redirect:\/m\/leases/); assert.equal(reads, 0);
  await assert.rejects(mod.actionAcceptReconsent(form("")), /redirect:\/m\/payments/); assert.equal(reads, 1);
  actor = { ...session, kind: "tenant" };
  await assert.rejects(mod.actionAcceptPortalConsent(form("/t/pay")), /redirect:\/t\/pay/); assert.equal(reads, 1);
});

test("MGT-48-AC5 / MGT-49-AC5: session landing changes only for opted-in staff", async () => {
  let on = false; let reads = 0;
  const home = compile(source("src/server/role-home-v3.ts"), {
    "./brand-v3": { brandV3EnabledForOrg: async () => { reads++; return on; } }, "./nav-v3": nav, "./perms": { roleHome },
  }).roleHomeForSession as (s: Session) => Promise<string>;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    on = false; assert.equal(await home({ ...session, role }), roleHome("staff", role));
    on = true; assert.equal(await home({ ...session, role }), nav.landingV3({ ...session, role }));
  }
  reads = 0;
  assert.equal(await home({ ...session, kind: "tenant" }), "/t");
  assert.equal(await home({ ...session, kind: "owner" }), "/o"); assert.equal(reads, 0);
});

test("MGT-49-AC5: / keeps hash forwarding and OFF reset target, v3 staff goes to role home", async () => {
  let on = false;
  const mocks = {
    "@/components/auth-hash": { HashOrRedirect: stub }, "@/server/session": { readSession: async () => ({ ...session, role: "accountant" }) },
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => on }, "@/server/nav-v3": nav,
  };
  const Page = compile(source("src/app/page.tsx"), mocks).default as (p: { searchParams: Promise<{ reset?: string }> }) => Promise<React.ReactElement<{ next: string }>>;
  assert.equal((await Page({ searchParams: Promise.resolve({ reset: "1" }) })).props.next, "/m?demoReset=1");
  on = true;
  assert.equal((await Page({ searchParams: Promise.resolve({ reset: "1" }) })).props.next, "/m/payments?demoReset=1");
});

test("PLT-44-AC15 / PLT-47-AC4 / PLT-50-AC4: shell styles are fully scoped, flat, and use 64em", () => {
  const css = source("public/brand/v3/shell.css");
  const ast = postcss.parse(css);
  ast.walkRules(rule => {
    for (const selector of rule.selectors) assert.ok(selector.startsWith('html[data-brand="v2"][data-brand-v3] '), selector);
  });
  assert.match(css, /@media\(min-width:64em\)/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /gradient\(|#[a-f0-9]{3,8}\b/i);
});
