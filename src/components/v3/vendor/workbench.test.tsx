import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as i18n from "../../../i18n";
import * as copy from "../../../i18n/lanes/brand-v3";
import * as own from "../../../i18n/lanes/brand-v3-own-status";
import * as token from "../../../i18n/lanes/brand-v3-vendor-token";
import * as lane from "../../../i18n/lanes/brand-v3-vendor-workbench";
import * as paths from "../../../lib/vendor-workbench-paths";
import * as nav from "../../../server/nav-v3";
import { Illustration } from "../illustrations";
import { RoleAvatar } from "../role-avatar";
import { ShellIcon } from "../shell/icon";
import { VendorEmpty, VendorHome, VendorJobs, VendorNoPerm, VendorPayments, VendorWorkbenchError, VendorWorkbenchLoading } from "./workbench";
import type { VendorJobRow, VendorPaymentRow } from "../../../server/vendor-workbench";

// B-063 component tests: V-HOME, V-EMPTY, V-JOBS, V-RECV (rows, empty, loading, error), B1-NOPERM and the
// vendor shell (OV-SH-PHONE / DESK / MORE / ME / NONAME / ORG / NOTI), plus the /vendor-account OFF parity.
const requireHere = createRequire(import.meta.url);
const source = (file: string) => readFileSync(file, "utf8");
function compile(text: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (name === "react" || name === "react/jsx-runtime") return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}
const jobs: VendorJobRow[] = [
  { jobId: "11111111-1111-4111-8111-111111111111", property: "信義路 2 樓", item: "浴室天花板滴水", status: "visit", href: "/vendor-account/jobs/11111111-1111-4111-8111-111111111111" },
  { jobId: "22222222-2222-4222-8222-222222222222", property: "松仁匯 7F", item: "冷氣不冷", status: "working", href: null },
];
const payments: VendorPaymentRow[] = [
  { jobId: "33333333-3333-4333-8333-333333333333", property: "忠孝大樓 3F", item: "門鎖完工", amount: "NT$2,400", href: "/vendor-account/jobs/33333333-3333-4333-8333-333333333333" },
];
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const solid = (markup: string) => (markup.match(/vendor-primary|vendor-noperm-home/g) ?? []).length;
const BANNED = ["收租", "代收", "欠租", "入帳", "待入帳", "本月實收", "房東", "房客"];

test("V-HOME / VEN-14-AC1…AC3: two cards, approved labels and the note, outline 查看, no solid primary", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const markup = html(<VendorHome jobs={jobs} payments={payments} locale={locale} />);
    const w = lane.vendorWorkbenchCopy(locale), o = own.ownStatusCopy(locale);
    assert.match(markup, /data-testid="vendor-home"/);
    for (const text of [w.openJobs, o.vendorListTitle, w.visit, w.working, o.vendorStatus, w.note, "NT$2,400"]) assert.ok(markup.includes(text), text);
    assert.ok(markup.includes("信義路 2 樓・浴室天花板滴水")); assert.ok(markup.includes("忠孝大樓 3F・門鎖完工"));
    assert.equal((markup.match(/data-testid="vendor-job-row"/g) ?? []).length, 2);
    assert.equal((markup.match(/data-testid="vendor-payment-row"/g) ?? []).length, 1);
    // A row opens that job's own page; a job without an openable page has no 查看.
    assert.equal((markup.match(/class="vendor-action" href="\/vendor-account\/jobs\/[0-9a-f-]+"/g) ?? []).length, 2);
    assert.equal(solid(markup), 0);
    assert.doesNotMatch(markup, /data-v3-illustration/);
  }
  const zh = html(<VendorHome jobs={jobs} payments={payments} locale="zh-TW" />);
  for (const label of ["未結案件", "待收款紀錄", "待到場", "處理中", "待收款", "查看", "這是已記錄的應付狀態，不是代付款。"]) assert.ok(zh.includes(label), label);
  for (const word of BANNED) assert.ok(!zh.includes(word), word);
});

test("V-HOME-ONE (round 7 batch 4): one empty card keeps its title + one line, no illustration, note only with rows; both empty is V-EMPTY", () => {
  const card = (markup: string, id: string) => markup.slice(markup.indexOf(`data-testid="${id}"`), markup.indexOf("</section>", markup.indexOf(`data-testid="${id}"`)));
  const noPay = html(<VendorHome jobs={jobs} payments={[]} locale="zh-TW" />);
  assert.ok(card(noPay, "vendor-home-payments").includes('<h2 id="vendor-home-payments">待收款紀錄</h2><p class="vendor-card-empty">還沒有待收款紀錄</p>'));
  assert.doesNotMatch(noPay, /這是已記錄的應付狀態|data-v3-illustration|<button/);
  assert.equal((noPay.match(/data-testid="vendor-job-row"/g) ?? []).length, 2);
  const noJobs = html(<VendorHome jobs={[]} payments={payments} locale="zh-TW" />);
  assert.ok(card(noJobs, "vendor-home-jobs").includes('<h2 id="vendor-home-jobs">未結案件</h2><p class="vendor-card-empty">目前沒有未結案件</p>'));
  assert.doesNotMatch(noJobs, /管理方派工給你後|data-v3-illustration/, "the V-JOBS sentence and drawing belong to the full-page empty states");
  assert.ok(noJobs.includes("NT$2,400")); assert.ok(noJobs.includes("這是已記錄的應付狀態，不是代付款。"));
  const en = html(<VendorHome jobs={[]} payments={payments} locale="en" />);
  assert.ok(en.includes('<p class="vendor-card-empty">No open jobs</p>'));
  const empty = html(<VendorHome jobs={[]} payments={[]} locale="zh-TW" />);
  assert.equal(empty, `<div class="v3-vendor-workbench" data-testid="vendor-home">${html(<VendorEmpty locale="zh-TW" />)}</div>`);
});

test("V-EMPTY / VEN-14-AC4: drawing 21, the approved heading and reason, no button", () => {
  const markup = html(<VendorEmpty locale="zh-TW" />);
  assert.match(markup, /data-v3-illustration="21"/);
  assert.ok(markup.includes("目前沒有未結案件"));
  assert.ok(markup.includes("目前沒有未結案件，也沒有待收款。免下載 App，用這個網頁就行。"));
  assert.doesNotMatch(markup, /<a |<button/);
});

test("V-JOBS: the 未結案件 list; empty is drawing 21 + heading + the round 7 sentence, no button", () => {
  const list = html(<VendorJobs jobs={jobs} locale="zh-TW" />);
  assert.ok(list.includes("未結案件")); assert.equal((list.match(/data-testid="vendor-job-row"/g) ?? []).length, 2);
  assert.doesNotMatch(list, /vendor-payment-row|待收款/); assert.equal(solid(list), 0);
  const empty = html(<VendorJobs jobs={[]} locale="zh-TW" />);
  assert.match(empty, /data-testid="vendor-jobs-empty"/); assert.match(empty, /data-v3-illustration="21"/);
  assert.ok(empty.includes("目前沒有未結案件")); assert.ok(empty.includes("管理方派工給你後，案件會出現在這裡。"));
  assert.doesNotMatch(empty, /<a |<button|待收款/);
});

test("V-RECV: rows with 待收款 + amount + the note, title only in the page lead; empty is drawing 22 + 還沒有待收款紀錄", () => {
  const list = html(<VendorPayments payments={payments} locale="zh-TW" />);
  assert.ok(list.includes("待收款")); assert.ok(list.includes("NT$2,400")); assert.ok(list.includes("這是已記錄的應付狀態，不是代付款。"));
  assert.doesNotMatch(list, /<h2>/, "the title 待收款紀錄 is shown once, as the page lead");
  assert.equal(solid(list), 0);
  const empty = html(<VendorPayments payments={[]} locale="zh-TW" />);
  assert.match(empty, /data-v3-illustration="22"/); assert.ok(empty.includes("<h2>還沒有待收款紀錄</h2>"));
  assert.doesNotMatch(empty, /<a |<button|NT\$/);
});

test("GS-02 / VEN-14-AC5: loading is skeletons with no number, count or NT$0", () => {
  for (const screen of ["home", "jobs", "payments"] as const) for (const locale of ["zh-TW", "en"] as const) {
    const markup = html(<VendorWorkbenchLoading screen={screen} locale={locale} />);
    assert.match(markup, /aria-busy="true"/); assert.match(markup, /class="vendor-skeleton"/);
    assert.doesNotMatch(markup.replace(/<[^>]+>/g, ""), /\d|NT\$/);
    assert.doesNotMatch(markup, /vendor-job-row|vendor-payment-row|<a |<button/);
    assert.equal((markup.match(/class="vendor-card"/g) ?? []).length, screen === "home" ? 2 : 1);
  }
});

test("GS-02 / VEN-14-AC6: read error in place with one solid 再試一次 that reloads the same page", () => {
  const markup = html(<VendorWorkbenchError locale="zh-TW" retryHref="/vendor-account/jobs" />);
  assert.ok(markup.includes("這裡暫時讀不到，請再試一次。"));
  assert.match(markup, /<a class="vendor-action vendor-primary" href="\/vendor-account\/jobs">再試一次<\/a>/);
  assert.match(markup, /role="alert"/); assert.equal(solid(markup), 1);
  assert.doesNotMatch(markup, /NT\$|vendor-job-row/);
});

test("GS-03 / B1-NOPERM for a wrong persona: drawing 26, the approved sentence, one home action, scoped tokens", () => {
  const markup = html(<VendorNoPerm locale="zh-TW" />);
  assert.match(markup, /data-v3-illustration="26"/);
  assert.ok(markup.includes("你目前的角色看不到這一頁，需要的話請公司管理員幫你開。"));
  assert.match(markup, /<a class="vendor-noperm-home" href="\/">回到首頁<\/a>/);
  assert.match(markup, /--c-primary:/); assert.match(markup, /href="\/brand\/v3\/vendor\.css"/);
  assert.doesNotMatch(markup, /工作台|未結案件|待收款/);
});

test("PLT-47-AC5: drawings 21 and 22 match the approved hub geometry with theme variables only", () => {
  const hub: Record<string, string> = {
    "21": "M72 58V48a8 8 0 0 1 8-8h16a8 8 0 0 1 8 8v10", "22": "M148 42l-18 44",
  };
  for (const name of ["21", "22"] as const) {
    const svg = html(<Illustration name={name} />);
    assert.match(svg, /viewBox="0 0 176 120"/); assert.match(svg, /aria-hidden="true"/); assert.match(svg, /focusable="false"/);
    assert.ok(svg.includes(hub[name]));
    assert.equal((svg.match(/var\(--c-brand\)/g) ?? []).length, 1);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|<title|aria-label/i);
    for (const match of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) assert.ok(match[1] === "none" || match[1].startsWith("var(--c-"), match[1]);
  }
});

test("vendor.css: tokens only, 44px targets, scoped to the v3 shell (B1-NOPERM carries its own scope)", () => {
  const css = source("public/brand/v3/vendor.css");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  assert.match(css, /\.vendor-action \{[^}]*min-height:44px/); assert.match(css, /\.vendor-noperm-home \{[^}]*min-height:44px/);
  for (const line of css.split("\n").filter(line => line.includes(" { "))) {
    assert.ok(line.startsWith('html[data-brand="v2"][data-brand-v3] ') || line.startsWith(".vendor-noperm"), line);
  }
});

// ---- Shell: compiled with the same mocks the owner shell test uses, with the pathname under test.
const link = { __esModule: true, default: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <a {...props}>{children}</a> };
function shell(locale: i18n.Locale, path: string, open: "avatar" | "more" | null = null) {
  const base = {
    "next/link": link, "next/navigation": { usePathname: () => path, useRouter: () => ({ refresh() {} }) },
    "./locale": { useT: () => i18n.makeT(locale), useLocale: () => locale },
    "@/server/perms": {}, "@/line-copy": {}, "./brand": { BrandImage: () => <span /> }, "@/i18n/lanes/repair-owner-policy": {},
  };
  const chrome = compile(source("src/components/chrome.tsx"), base);
  const sharedMocks = {
    ...base, "../../../i18n": i18n, "../../../i18n/lanes/brand-v3": copy, "../../../server/nav-v3": nav,
    "../../chrome": chrome, "../role-avatar": { RoleAvatar }, "./icon": { ShellIcon },
    ...(open ? { react: { ...React, useState: () => [{ kind: open, top: 64, left: 8 }, () => {}] } } : {}),
  };
  const shared = compile(source("src/components/v3/shell/shared-shell.tsx"), sharedMocks);
  return compile(source("src/components/v3/vendor/workbench-shell.tsx"), {
    ...base, "../../../i18n": i18n, "../../../i18n/lanes/brand-v3": copy, "../../../i18n/lanes/brand-v3-own-status": own,
    "../../../i18n/lanes/brand-v3-vendor-token": token, "../../../i18n/lanes/brand-v3-vendor-workbench": lane,
    "../../../lib/vendor-workbench-paths": paths, "../shell/shared-shell": shared,
  });
}
function renderShell({ path = "/vendor-account", locale = "zh-TW", name = "陳師傅", open = null }: { path?: string; locale?: i18n.Locale; name?: string; open?: "avatar" | "more" | null } = {}) {
  const Shell = shell(locale, path, open).VendorShellV3 as React.ComponentType<Record<string, unknown>>;
  return html(<Shell locale={locale} name={name} company="安居物業"><p data-testid="content">content</p></Shell>);
}

test("OV-SH-PHONE / OV-SH-DESK / OV-SH-ORG: vendor wordmark, plain context, phone tabs and desktop areas", () => {
  const markup = renderShell();
  assert.match(markup, /data-testid="vendor-shell-v3"/); assert.match(markup, /class="v3-shell v3-owner-shell"/);
  assert.ok(markup.includes("租多啦・廠商")); assert.match(markup, /<div class="cap">陳師傅 你好｜管理方：安居物業<\/div>/);
  assert.doesNotMatch(markup, /data-testid="org-switch"|▾/);
  const tabs = markup.slice(markup.indexOf('data-testid="v3-phone-tabs"'));
  assert.deepEqual([...tabs.matchAll(/data-area="([a-z]+)"/g)].map(m => m[1]), ["home", "jobs", "payments", "more"]);
  for (const label of ["工作台", "工單", "收款", "更多"]) assert.ok(tabs.includes(label), label);
  const side = markup.slice(markup.indexOf('data-testid="v3-sidebar-nav"'), markup.indexOf("</nav>", markup.indexOf('data-testid="v3-sidebar-nav"')));
  assert.deepEqual([...side.matchAll(/data-area="([a-z]+)"/g)].map(m => m[1]), ["home", "jobs", "payments", "account"]);
  assert.ok(side.includes("我的帳號"));
  assert.match(markup, /href="\/brand\/v3\/vendor\.css"/); assert.match(markup, /data-testid="content"/);
});

test("OV-SH-NOTI: a signed-in vendor has no notification page, so no bell and no 通知 tab", () => {
  const markup = renderShell();
  assert.doesNotMatch(markup, /data-testid="shell-bell"|通知|notifications/);
});

test("OV-SH-DESK-HEAD: the title row names the area, the sand lead keeps the phone heading (V-RECV 收款 / 待收款紀錄)", () => {
  for (const [path, area, desk, lead] of [["/vendor-account", "home", "工作台", "工作台"], ["/vendor-account/jobs", "jobs", "工單", "工單"],
    ["/vendor-account/payments", "payments", "收款", "待收款紀錄"], ["/vendor-account/account", "account", "我的帳號", "我的帳號"]] as const) {
    const markup = renderShell({ path });
    assert.ok(markup.includes(`<div class="shell-phone-lead"><h1>${lead}</h1></div>`), path);
    assert.ok(markup.includes(`<span class="page-title-desk">${desk}</span>`), path);
    assert.match(markup, new RegExp(`data-area="${area}" class="on" aria-current="page"`));
    if (area === "account") assert.match(markup, /data-area="more" class="on" aria-current="page"/);
  }
  const en = renderShell({ path: "/vendor-account/payments", locale: "en" });
  assert.ok(en.includes('<span class="page-title-desk">Payments</span>')); assert.ok(en.includes('<div class="shell-phone-lead"><h1>Awaiting payment</h1></div>'));
});

test("OV-SH-DESK-HEAD CSS: owner/vendor show the sand lead on desktop (managers have none); O-HOME's sentence is that lead; 44px kept", () => {
  const shellCss = source("public/brand/v3/shell.css"), ownerCss = source("public/brand/v3/owner.css");
  const desktop = shellCss.slice(shellCss.lastIndexOf("@media(min-width:64em) {"));
  assert.match(desktop, /\.v3-owner-shell \.shell-phone-lead\{ display:block;/);
  assert.match(desktop, /\.v3-owner-shell \.page-title-desk\{ font-size:1rem;/);
  assert.doesNotMatch(shellCss, /\.v3-shell \.shell-phone-lead\{ display:none; \}/);
  assert.match(ownerCss, /\.v3-owner-shell:has\(\.v3-owner-home\) \.shell-phone-lead \{ display:none; \}/);
  assert.match(ownerCss, /\.v3-owner-shell \.v3-owner-home > h2 \{ background:var\(--c-tint-soft\); color:var\(--c-text\);/);
  for (const css of [shellCss, ownerCss]) assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  // Managers render no sand lead at all, so the desktop rule cannot reach them.
  const managerShell = source("src/components/v3/shell/shared-shell.tsx");
  assert.match(managerShell, /\{party !== "m" \? <div className="shell-phone-lead"><h1>\{lead \?\? title\}<\/h1><\/div> : null\}/);
  assert.match(source("public/brand/v3/vendor.css"), /\.vendor-action \{[^}]*min-width:44px; min-height:44px/);
});

test("OV-SH-MORE (ven-more): 我的帳號 only; 登入與歸戶 stays hidden until its page is live", () => {
  const markup = renderShell({ open: "more" });
  const menu = markup.slice(markup.indexOf('data-testid="more-menu"'));
  assert.match(menu, /href="\/vendor-account\/account"/); assert.ok(menu.includes("我的帳號"));
  assert.doesNotMatch(markup, /登入與歸戶/);
});

test("OV-SH-ME / OV-SH-NONAME: avatar menu header, 我的帳號, language, sign out; no name drops the greeting", () => {
  const markup = renderShell({ open: "avatar" });
  const menu = markup.slice(markup.indexOf('data-testid="avatar-menu"'));
  assert.ok(menu.includes("<b>陳師傅</b>")); assert.ok(menu.includes("廠商・安居物業"));
  assert.match(menu, /data-testid="avatar-account" href="\/vendor-account\/account"/);
  assert.match(menu, /data-testid="locale-zh"/); assert.match(menu, /action="\/api\/auth\/sign-out"/);
  const noName = renderShell({ name: " " });
  assert.match(noName, /<div class="cap">管理方：安居物業<\/div>/); assert.match(noName, /data-testid="avatar-noname"/);
  assert.doesNotMatch(noName, /你好/);
  const en = renderShell({ locale: "en" });
  assert.ok(en.includes("Condola · Vendor")); assert.ok(en.includes("Workbench"));
});

test("Vendor shell copy stays inside the approved lanes; no banned word in any new source", () => {
  for (const file of ["src/components/v3/vendor/workbench.tsx", "src/components/v3/vendor/workbench-shell.tsx", "src/components/v3/vendor/workbench-page.tsx",
    "src/components/v3/vendor/account-sync.tsx", "src/i18n/lanes/brand-v3-vendor-workbench.ts", "src/server/vendor-workbench.ts", "src/lib/vendor-workbench-paths.ts",
    "src/app/vendor-account/page.tsx", "src/app/vendor-account/jobs/page.tsx", "src/app/vendor-account/payments/page.tsx", "src/app/vendor-account/account/page.tsx",
    "src/app/vendor-account/jobs/[jobId]/route.ts", "public/brand/v3/vendor.css", "supabase/migrations/20261116100000_b063_vendor_workbench.sql"]) {
    const text = source(file);
    for (const word of [...BANNED, "收款"]) assert.ok(!text.includes(word), `${file}: ${word}`);
  }
});

// ---- Pages: /vendor-account OFF parity and the /vendor-account/* admission.
const Panel = () => <main>B-026 account page</main>;
const Screen = (props: Record<string, unknown>) => <div data-screen={String(props.screen)} />;
test("PLT-46-AC1 / VEN-14-AC8: /vendor-account OFF renders exactly the B-026 page; ON renders V-HOME", async () => {
  for (const state of ["anonymous", "consent", "other", "off", "on"] as const) {
    const access = state === "on" ? { state, scope: { orgId: "org", name: "陳師傅", company: "安居物業" } } : { state };
    let prefs = 0;
    const page = compile(source("src/app/vendor-account/page.tsx"), {
      "./panel": { __esModule: true, default: Panel },
      "@/components/v3/vendor/workbench-page": { VendorWorkbenchScreen: Screen },
      "@/server/vendor-workbench": { currentVendorWorkbench: async () => access },
      "@/server/session": { requestPrefs: async () => { prefs++; return { locale: "zh-TW" }; } },
    }).default as () => Promise<React.ReactElement>;
    const element = await page();
    if (state === "on") { assert.equal(element.type, Screen); assert.equal((element.props as { screen: string }).screen, "home"); }
    else {
      assert.equal(element.type, Panel); assert.deepEqual(element.props, {});
      assert.equal(html(element), html(<Panel />)); assert.equal(prefs, 0, "OFF reads nothing else");
    }
  }
  // The pre-B-063 page body, for reference: one element, no props.
  assert.match(source("src/app/vendor-account/page.tsx"), /if \(access\.state !== "on"\) return <VendorAccountPanel \/>;/);
});

test("VEN-14-AC7 / GS-03: /vendor-account/* sends no session to sign-in, stale terms to consent, wrong persona to B1-NOPERM, OFF to 404", async () => {
  const thrown = (kind: string) => { throw Object.assign(new Error(kind), { kind }); };
  for (const state of ["anonymous", "consent", "other", "off", "on"] as const) {
    const access = state === "on" ? { state, scope: { orgId: "org", name: "", company: "安居物業" } } : { state };
    const loaded = compile(source("src/components/v3/vendor/workbench-page.tsx"), {
      "next/navigation": { redirect: (to: string) => thrown(`redirect:${to}`), notFound: () => thrown("notFound") },
      "../../../lib/vendor-workbench-paths": paths,
      "../../../server/vendor-workbench": { currentVendorWorkbench: async () => access, currentVendorWorkbenchView: async () => assert.fail("no read before admission") },
      "./account-sync": { VendorAccountSync: () => null }, "./workbench-shell": { VendorShellV3: ({ children }: React.PropsWithChildren) => <>{children}</> },
      "./workbench": { VendorNoPerm: () => <p>noperm</p>, VendorHome: () => null, VendorJobs: () => null, VendorPayments: () => null, VendorWorkbenchError: () => null, VendorWorkbenchLoading: () => null },
    });
    const route = loaded.vendorWorkbenchRoute as (locale: i18n.Locale) => Promise<{ scope?: unknown; page?: React.ReactElement }>;
    if (state === "on") { assert.deepEqual(await route("zh-TW"), { scope: access.scope }); continue; }
    if (state === "other") { assert.equal(html((await route("zh-TW")).page!), "<p>noperm</p>"); continue; }
    const expected = state === "anonymous" ? "redirect:/login?next=%2Fvendor-account" : state === "consent" ? "redirect:/consent?next=%2Fvendor-account" : "notFound";
    await assert.rejects(route("zh-TW"), (error: unknown) => (error as { kind?: string }).kind === expected);
  }
});
