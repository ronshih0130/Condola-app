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
import { b056TrialCopy } from "../i18n/b056-trial";
import { formatTrialDate } from "./b056-trial-rules";
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

test("PLT-46-AC1 / MGT-47-AC1: SH-SANDBOX root OFF is byte-identical to 529b4fa, ON only replaces staff /m header", async () => {
  const old = execFileSync("git", ["show", "529b4fa:src/app/layout.tsx"], { encoding: "utf8" });
  for (const locale of ["zh-TW", "en"] as const) for (const kind of ["staff", "tenant", "owner"] as const) for (const environment of ["live", "sandbox"] as const) for (const path of ["/m", "/m/payments", "/t", "/consent"]) {
    let on = false;
    const actor = { ...session, locale, kind, environment };
    const mocks = {
      "next/headers": { headers: async () => ({ get: () => path }) }, "next/link": link,
      "@/i18n": i18n,
      "@/components/auth-hash": { AuthHashForward: stub }, "@/components/chunk-reload": { ChunkReloadListener: stub },
      "@/components/chrome": { BrandLink: stub, LocaleLinks: stub, ResetButton: stub, SignOutButton: stub },
      "@/components/required-validity": { RequiredValidity: stub }, "@/components/env-mode": { EnvBanner: () => <div data-testid="legacy-env-banner" /> },
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
    assert.equal(html.includes('data-testid="legacy-env-banner"'), environment === "sandbox" && !(kind === "staff" && path.startsWith("/m")));
  }
});

test("PLT-46-AC1 / PLT-44-AC8: SH-ME/SH-ORG/SH-TRIAL manager OFF preserves markup, readers and redirect order", async () => {
  const old = execFileSync("git", ["show", "529b4fa:src/app/m/layout.tsx"], { encoding: "utf8" });
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) for (const environment of ["live", "sandbox"] as const) for (const hidden of [false, true]) for (const demo of [false, true]) for (const path of (role === "maintenance" ? ["/m/tickets", "/m/account"] : ["/m", "/m/payments", "/m/account"])) {
    const actor = { ...session, role, environment };
    let calls: string[] = [];
    let on = false;
    let shellProps: Record<string, unknown> = {};
    const mocks = {
      "next/headers": { headers: async () => ({ get: () => path }), cookies: async () => { calls.push("cookies"); return { get: () => ({ value: hidden ? "1" : "0" }) }; } },
      "next/navigation": { redirect: (to: string) => { throw new Error(to); } }, "@/build-info": { BUILD_SHA: "fixture" },
      "@/components/chrome": { Sidebar: stub, TaskPanel: stub },
      "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); } },
      "@/server/demo": { demoModeEnabled: () => demo }, "@/server/perms": { noPermHref: (p: string, s: Session) => { calls.push("permission"); return noPermHref(p, s); } },
      "@/server/queries": { loadManagerChrome: async () => { calls.push("chrome"); return { flags: { property: true }, firm: { name: "fixture" }, badge: { pending: 2, tickets: 3 } }; } },
      "@/server/session": { getSession: async () => actor },
      "@/server/b056-trial": { trialBannerFor: async () => { calls.push("trial"); return { kind: "fixture" }; } },
      "@/components/b056-trial-banner": { TrialBanner: stub }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => on },
      "@/i18n/lanes/brand-v3": copy, "@/server/nav-v3": nav, "@/components/v3/shell/manager-shell": { ManagerShellV3: (props: Record<string, unknown>) => { shellProps = props; return stub(props); } },
    };
    const baseline = await renderLayout(old, mocks); const baselineCalls = calls;
    calls = []; assert.equal(await renderLayout(source("src/app/m/layout.tsx"), mocks), baseline);
    assert.deepEqual(calls, baselineCalls);
    on = true; calls = [];
    const html = await renderLayout(source("src/app/m/layout.tsx"), mocks);
    assert.deepEqual(calls, baselineCalls);
    assert.equal(shellProps.showReset, demo && role === "admin");
    assert.equal(shellProps.canSwitchCompany, true);
    assert.equal(shellProps.hasLiveCompany, true);
    assert.equal(Boolean(shellProps.trialBanner), path === "/m" && role === "admin" && environment === "live");
    assert.doesNotMatch(html, /class="app"|id="nav-open"/);
    assert.ok(html.includes('data-testid="content"'));
  }
});

test("SH-ORG / PLT-44-AC13: layout uses existing env eligibility, including missing live company and custom-role refusal", async () => {
  for (const liveOrgId of ["org", ""]) for (const assigned of [undefined, false, true]) {
    const actor: Session = { ...session, liveOrgId, customRole: assigned === undefined ? undefined : { orgId: "org", userId: "user", sessionId: "session", nativeRole: "admin", assigned, keys: ["props.view"], audit: false, photos: false } };
    let props: Record<string, unknown> = {};
    const mocks = {
      "next/headers": { headers: async () => ({ get: () => "/m/account" }), cookies: async () => ({ get: () => undefined }) },
      "next/navigation": { redirect: (to: string) => { throw new Error(to); } }, "@/build-info": { BUILD_SHA: "fixture" },
      "@/components/chrome": { Sidebar: stub, TaskPanel: stub }, "@/server/consent-gate": { requireCurrentConsent: async () => {} },
      "@/server/demo": { demoModeEnabled: () => false }, "@/server/perms": { noPermHref },
      "@/server/queries": { loadManagerChrome: async () => ({ flags: {}, firm: { name: "fixture" }, badge: {} }) },
      "@/server/session": { getSession: async () => actor }, "@/server/b056-trial": { trialBannerFor: async () => null },
      "@/components/b056-trial-banner": { TrialBanner: stub }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => true },
      "@/i18n/lanes/brand-v3": copy, "@/server/nav-v3": nav,
      "@/components/v3/shell/manager-shell": { ManagerShellV3: (value: Record<string, unknown>) => { props = value; return stub(value); } },
    };
    await renderLayout(source("src/app/m/layout.tsx"), mocks);
    assert.equal(props.canSwitchCompany, Boolean(liveOrgId) && assigned !== true);
    assert.equal(props.hasLiveCompany, Boolean(liveOrgId));
  }
});

// Render real shared controls. State is injected only for open-state SSR assertions;
// browser tests below cover actual click, focus, keyboard, and dismiss behaviour.
function chromeMocks(locale: i18n.Locale, path: string) {
  return {
    "next/link": link, "next/navigation": { usePathname: () => path },
    "@/server/perms": {}, "@/line-copy": {}, "./brand": {},
    "./locale": { useT: () => i18n.makeT(locale), useLocale: () => locale },
  };
}
function renderShell({ path = "/m", open = null, ...overrides }: Record<string, unknown> & { path?: string; open?: "avatar" | "org" | null } = {}) {
  const locale = (overrides.locale || "zh-TW") as i18n.Locale;
  const chrome = compile(source("src/components/chrome.tsx"), chromeMocks(locale, path));
  const mocks = {
    "next/link": link, "next/navigation": { usePathname: () => path }, "../../../i18n": i18n,
    "../../../i18n/lanes/brand-v3": copy, "../../../server/nav-v3": nav,
    "../../chrome": chrome, "../role-avatar": { RoleAvatar }, "./icon": { ShellIcon },
    ...(open ? { react: { ...React, useState: () => [{ kind: open, top: 64, left: 8 }, () => {}] } } : {}),
  };
  const Shell = compile(source("src/components/v3/shell/manager-shell.tsx"), mocks).ManagerShellV3 as React.ComponentType<Record<string, unknown>>;
  return renderToStaticMarkup(<Shell areas={nav.areasFor(session)} tabs={nav.tabsFor(session)} locale={locale} name={session.name} role="admin" firm="安居代管"
    sandbox={false} showReset={true} hasLiveCompany={true} canSwitchCompany={true} todayTitle={copy.shellTodayTitle(new Date("2026-11-13T00:00:00+08:00"), locale)}
    buildSha="fixture" trialBanner={<p data-testid="trial-banner">trial</p>} {...overrides}><h1>content</h1></Shell>);
}

test("SH-DESK/SH-PHONE/SH-ME / PLT-44, PLT-48-AC2: identity, current nav, default-closed menus and bottom build SHA", () => {
  for (const path of ["/m", "/m/payments", "/m/more", "/m/units"]) {
    const html = renderShell({ path });
    assert.match(html, /安居代管｜陳小明（管理員）/);
    assert.match(html, /party-name" aria-hidden="true">陳/);
    assert.match(html, /<span class="page-title-desk">/);
    assert.equal((html.match(/data-testid="avatar-menu-trigger"[^>]+aria-expanded="false"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /data-testid="avatar-menu"|data-testid="org-menu"|shell-tools|data-testid="sign-out"/);
    assert.equal((html.match(/data-testid="build-sha"/g) ?? []).length, 1);
    assert.ok(html.indexOf('data-testid="build-sha"') > html.indexOf("<h1>content</h1>"));
    assert.doesNotMatch(html, /class="top"|class="side"|tryout-panel|href="\/m\/(properties|leases)\/new"/);
    const activeTab = path === "/m" ? "today" : path === "/m/units" ? "properties" : "more";
    assert.match(html.split('data-testid="v3-phone-tabs"')[1], new RegExp(`data-area="${activeTab}" class="on" aria-current="page"`));
    const title = path === "/m" ? "今天・11 月 13 日（五）" : nav.crumbFor(path, session).join(" › ");
    assert.ok(html.includes(`<span class="page-title-desk">${title}</span>`));
  }
});

test("SH-ME: open avatar menu uses approved bilingual strings, current language, POST logout, admin/demo-only reset", () => {
  assert.match(renderShell({ locale: "en", name: "Alex Chen" }), /party-name" aria-hidden="true">A<\/span>/);
  for (const locale of ["zh-TW", "en"] as const) for (const role of ["admin", "manager", "accountant", "maintenance"] as const) for (const showReset of [false, true]) {
    const html = renderShell({ open: "avatar", locale, role, showReset, path: "/m/units" });
    const menu = html.split('data-testid="avatar-menu"')[1].split('<nav class="tabbar"')[0];
    const t = i18n.makeT(locale);
    for (const key of ["i_account", "s_ae41d00", "s_66ab2dd", "i_lang_zh", "i_lang_en"]) assert.ok(menu.includes(t(key)), key);
    assert.ok(menu.includes(copy.brandV3ShellCopy(locale).menuContext.replace("{role}", t(`i_role_${role}`)).replace("{company}", "安居代管")));
    assert.match(menu, /href="\/m\/account"/);
    assert.match(menu, new RegExp(`aria-current="true" data-testid="locale-${locale === "en" ? "en" : "zh"}"`));
    assert.equal((menu.match(/aria-current="true"/g) ?? []).length, 1);
    assert.match(menu, /href="\/api\/demo\/locale\?set=zh-TW&amp;next=%2Fm%2Funits"/);
    assert.match(menu, /href="\/api\/demo\/locale\?set=en&amp;next=%2Fm%2Funits"/);
    assert.match(menu, /<form action="\/api\/auth\/sign-out" method="post">/);
    assert.equal(menu.includes('data-testid="reset-demo"'), role === "admin" && showReset);
    if (role === "admin" && showReset) assert.ok(menu.indexOf('data-testid="reset-demo"') > menu.indexOf('data-testid="sign-out"'));
  }
});

test("SH-ORG / PLT-44-AC12/AC13: context is plain without switching; current checkmark, divider and sample company last", () => {
  const plain = renderShell({ canSwitchCompany: false, hasLiveCompany: false });
  assert.match(plain, /<div class="cap">安居代管｜陳小明（管理員）<\/div>/);
  assert.doesNotMatch(plain, /▾|data-testid="org-switch"/);
  for (const sandbox of [false, true]) {
    const html = renderShell({ open: "org", sandbox, path: "/m/units" });
    assert.match(html, /▾/);
    const menu = html.split('data-testid="org-menu"')[1].split('<nav class="tabbar"')[0];
    assert.match(menu, /org-pick-live[^>]*>安居代管/);
    assert.match(menu, /href="\/api\/env\?set=live&amp;next=%2Fm%2Funits"/);
    assert.match(menu, /href="\/api\/env\?set=sandbox&amp;next=%2Fm%2Funits"/);
    assert.ok(menu.indexOf('org-pick-live') < menu.indexOf('role="separator"'));
    assert.ok(menu.indexOf('role="separator"') < menu.indexOf('org-pick-sandbox'));
    assert.match(menu, new RegExp(`data-testid="org-pick-${sandbox ? "sandbox" : "live"}" aria-current="true"`));
    assert.equal((menu.match(/✓/g) ?? []).length, 1);
    assert.match(menu, /org-pick-sandbox[^>]*>範例公司/);
  }
});

test("SH-SANDBOX/SH-TRIAL / MGT-98-AC1: sandbox wins, return link needs live company, only Today live admin has trial", () => {
  for (const sandbox of [false, true]) for (const hasLiveCompany of [false, true]) for (const role of ["admin", "manager", "accountant", "maintenance"] as const) for (const path of ["/m", "/m/units", "/m/account"]) {
    const html = renderShell({ sandbox, hasLiveCompany, role, path });
    assert.equal(html.includes('data-testid="env-banner"'), sandbox);
    assert.equal(html.includes('data-testid="env-banner-live"'), sandbox && hasLiveCompany);
    assert.equal(html.includes('data-testid="trial-banner"'), !sandbox && path === "/m" && role === "admin");
    if (sandbox) {
      assert.match(html, /範例公司的練習資料，不受方案限制。/);
      if (hasLiveCompany) assert.ok(html.includes(`href="/api/env?set=live&amp;next=${encodeURIComponent(path)}"`));
      const banner = html.split('data-testid="env-banner"')[1].split('</div>')[0];
      assert.doesNotMatch(banner, /<button|dismiss/);
    }
  }
  assert.doesNotMatch(renderShell({ trialBanner: null }), /data-testid="trial-banner"/);
});

test("SH-DESK / OQ-047: Today date has unpadded month/day, every weekday, no year, and Taipei midnight", () => {
  for (let day = 2; day <= 8; day++) {
    const now = new Date(`2026-03-0${day}T00:00:00+08:00`);
    assert.equal(copy.shellTodayTitle(now, "zh-TW"), `今天・3 月 ${day} 日（${"一二三四五六日"[day - 2]}）`);
    assert.equal(copy.shellTodayTitle(now, "en"), `Today · ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 2]} ${day} Mar`);
  }
  assert.equal(copy.shellTodayTitle(new Date("2026-03-01T15:59:59Z"), "zh-TW"), "今天・3 月 1 日（日）");
  assert.equal(copy.shellTodayTitle(new Date("2026-03-01T16:00:00Z"), "zh-TW"), "今天・3 月 2 日（一）");
});

test("SH-ME/SH-TRIAL: shared controls and TrialBanner retain byte-identical default markup; v3 keeps dismiss action and thresholds", () => {
  const oldChrome = execFileSync("git", ["show", "7f84af172132870941ae3d36cc9e11688ea20e0a:src/components/chrome.tsx"], { encoding: "utf8" });
  const oldTrial = execFileSync("git", ["show", "7f84af172132870941ae3d36cc9e11688ea20e0a:src/components/b056-trial-banner.tsx"], { encoding: "utf8" });
  for (const locale of ["zh-TW", "en"] as const) {
    const before = compile(oldChrome, chromeMocks(locale, "/m/units"));
    const after = compile(source("src/components/chrome.tsx"), chromeMocks(locale, "/m/units"));
    for (const name of ["LocaleLinks", "SignOutButton", "ResetButton"]) {
      assert.equal(renderToStaticMarkup(React.createElement(after[name] as React.ComponentType)), renderToStaticMarkup(React.createElement(before[name] as React.ComponentType)));
    }
    const dismiss = () => {};
    const mocks = { "@/i18n/b056-trial": { b056TrialCopy }, "@/i18n/lanes/brand-v3": copy, "@/server/b056-trial-actions": { actionDismissTrialBanner: dismiss }, "@/server/b056-trial-rules": { formatTrialDate } };
    const Trial = compile(source("src/components/b056-trial-banner.tsx"), mocks).TrialBanner as React.ComponentType<Record<string, unknown>>;
    const Before = compile(oldTrial, mocks).TrialBanner as typeof Trial;
    for (const [daysLeft, kind] of [[14, "d14"], [3, "d3"], [1, "d1"]] as const) for (const plan of ["standard", "pro"] as const) {
      const props = { locale, next: "/m", banner: { daysLeft, kind, plan, endsAt: new Date("2026-11-28T00:00:00+08:00") } };
      assert.equal(renderToStaticMarkup(<Trial {...props} />), renderToStaticMarkup(<Before {...props} />));
      const html = renderToStaticMarkup(<Trial {...props} shellV3 />);
      assert.ok(html.includes((plan === "pro" ? b056TrialCopy(locale).banner_pro : b056TrialCopy(locale).banner_std)(daysLeft, "2026/11/28")));
      assert.match(html, new RegExp(`name="kind" value="${kind}"`));
      assert.match(html, /name="next" value="\/m"/);
      assert.ok(html.includes(`data-testid="trial-banner-dismiss">${copy.brandV3ShellCopy(locale).close}</button>`));
      const tree = (Trial as (props: Record<string, unknown>) => React.ReactElement<{ children: React.ReactElement<{ children: React.ReactElement<{ action?: unknown }>[] }>[] }> )({ ...props, shellV3: true });
      assert.equal(tree.props.children[1].props.children[1].props.action, dismiss);
    }
  }
});

test("SH-MORE / MGT-47-AC3: More is staff-only, navigation-only, admits custom roles, and is absent when OFF", async () => {
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
  await assert.rejects(Page, /404/); assert.deepEqual(calls, ["consent", "flag"]);  // consent first (consent-entrypoints scanner), then the flag
  on = true; const html = renderToStaticMarkup(await Page());
  assert.match(html, /href="\/m\/rent"/); assert.match(html, /href="\/m\/tickets"/); assert.match(html, /href="\/m\/settings"/);
  assert.doesNotMatch(html, /href="\/m\/properties"|href="\/m\/messages"|href="\/m\/account"|我的帳號/);
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    actor = { ...session, role };
    assert.doesNotMatch(renderToStaticMarkup(await Page()), /href="\/m\/account"|我的帳號/);
    assert.ok(nav.areasFor(actor).find(area => area.id === "settings")?.links.some(item => item.href === "/m/account"));
  }
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
