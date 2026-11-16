import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as i18n from "../i18n";
import * as copy from "../i18n/lanes/brand-v3";
import { receiptTitleCopy } from "../i18n/owner-finance-replies";
import * as repairCopy from "../i18n/lanes/repair-owner-policy";
import * as nav from "./nav-v3";
import { RoleAvatar } from "../components/v3/role-avatar";
import { ShellIcon } from "../components/v3/shell/icon";
import { Illustration } from "../components/v3/illustrations";
import { WaitMark } from "../components/v3/wait-mark";
import * as approvalCopy from "../i18n/repair-approval";
import * as rules from "./repair-approval-rules";
import * as wire from "../app/o/approvals/decision-request";
import type { CenterAdmission } from "./notification-center";
import type { Session } from "./types";

const requireHere = createRequire(import.meta.url);
const source = (file: string) => readFileSync(file, "utf8");
function compile(source: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (name === "react" || name === "react/jsx-runtime") return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}
const owner: Session = { kind: "owner", role: null, orgId: "org", liveOrgId: "org", userId: "owner", sessionId: "session", name: "林小姐", email: "never-use-this@example.invalid", locale: "zh-TW", environment: "live", calendar: "gregorian", leaseId: null };
const properties = [{ id: "allowed", name: "松山公寓" }, { id: "hidden", name: "信義公寓" }];
const link = { __esModule: true, default: "a" };
function components(locale: i18n.Locale, path: string, open: "avatar" | "more" | null = null) {
  const base = {
    "next/link": link, "next/navigation": { usePathname: () => path },
    "./locale": { useT: () => i18n.makeT(locale), useLocale: () => locale },
    "@/server/perms": {}, "@/line-copy": {}, "./brand": { BrandImage: () => <span data-testid="brand-image" /> },
    "@/i18n/lanes/repair-owner-policy": repairCopy,
  };
  const chrome = compile(source("src/components/chrome.tsx"), base);
  const sharedMocks = {
    ...base, "../../../i18n": i18n, "../../../i18n/lanes/brand-v3": copy, "../../../server/nav-v3": nav,
    "../../chrome": chrome, "../role-avatar": { RoleAvatar }, "./icon": { ShellIcon },
    ...(open ? { react: { ...React, useState: () => [{ kind: open, top: 64, left: 8 }, () => {}] } } : {}),
  };
  const shared = compile(source("src/components/v3/shell/shared-shell.tsx"), sharedMocks);
  return {
    OwnerNav: compile(source("src/components/owner-nav.tsx"), base),
    OwnerShell: compile(source("src/components/v3/shell/owner-shell.tsx"), { ...sharedMocks, "./shared-shell": shared }),
  };
}
function renderOwner({ path = "/o", locale = "zh-TW", name = owner.name, admission = "enabled", open = null, navigation, receiptTitleAvailable = false, canSwitchToTenant = false, children }: {
  path?: string; locale?: i18n.Locale; name?: string; admission?: CenterAdmission; open?: "avatar" | "more" | null; navigation?: nav.OwnerNavigationV3; receiptTitleAvailable?: boolean; canSwitchToTenant?: boolean; children?: React.ReactNode;
} = {}) {
  const Shell = components(locale, path, open).OwnerShell.OwnerShellV3 as React.ComponentType<Record<string, unknown>>;
  return renderToStaticMarkup(<Shell canSwitchToTenant={canSwitchToTenant} locale={locale} name={name} firm="安居代管" navigation={navigation ?? nav.ownerNavigationV3({ ...owner, locale }, properties, ["allowed", "unassigned"], admission, receiptTitleAvailable)}>{children ?? <main data-testid="content">existing owner content</main>}</Shell>);
}

test("OV-SH-PHONE / PLT-46-AC1: owner OFF preserves old readers, order, markup and redirects", async () => {
  const old = execFileSync("git", ["show", "54fedb07f5cd851aa22683e585dbf1dbec2eb1ca:src/app/o/layout.tsx"], { encoding: "utf8" });
  for (const locale of ["zh-TW", "en"] as const) for (const kind of ["owner", "tenant", "staff"] as const) for (const v2 of [false, true]) for (const path of ["/o", "/o/statements/detail", "/o/approvals"]) {
    let calls: string[] = []; let flagReads = 0;
    const actor = { ...owner, locale, kind };
    const ui = components(locale, path);
    const mocks = {
      "next/headers": { headers: async () => { calls.push("headers"); return { get: () => path }; } },
      "next/navigation": { redirect: (to: string) => { calls.push(`redirect:${to}`); throw new Error(to); } },
      "@/server/session": { getSession: async () => { calls.push("session"); return actor; } },
      "@/server/brand-v2": { brandV2EnabledForOrg: async (id: string) => { calls.push(`v2:${id}`); return v2; } },
      "@/server/brand-v3": { brandV3EnabledForOrg: async () => { flagReads++; return false; } },
      "@/server/consent-gate": { requireCurrentConsent: async (s: Session, mode: string, p: string) => { assert.equal(s, actor); calls.push(`consent:${mode}:${p}`); } },
      "@/server/queries": { ownerPropertyNames: async (s: Session) => { assert.equal(s, actor); calls.push("properties"); return properties; } },
      "@/server/repair-owner-policy": { ownerRepairPolicyEntryIds: async (s: Session, ids: string[]) => { assert.equal(s, actor); assert.deepEqual(ids, ["allowed", "hidden"]); calls.push("repair"); return ["allowed"]; } },
      "@/server/auth": { ownerPrivacy: () => assert.fail("OFF must not read firm") },
      "@/server/owner-finance-replies": { ownerReceiptTitleView: () => assert.fail("OFF must not read receipt title") },
      "@/server/notification-center": { centerSessionAdmission: () => assert.fail("OFF must not read notification admission") },
      "@/server/repair-approval": { repairApprovalsEnabled: () => assert.fail("OFF must not read the 核准紀錄 rollout") },
      "@/server/nav-v3": nav, "@/components/owner-nav": ui.OwnerNav, "@/components/v3/shell/owner-shell": ui.OwnerShell,
    };
    const render = async (text: string) => {
      const Layout = compile(text, mocks).default as (p: { children: React.ReactNode }) => Promise<React.ReactNode>;
      try { return renderToStaticMarkup(await Layout({ children: <p>content</p> })); } catch (e) { return (e as Error).message; }
    };
    const before = await render(old); const beforeCalls = [...calls]; calls = [];
    assert.equal(await render(source("src/app/o/layout.tsx")), before);
    assert.deepEqual(calls, beforeCalls);
    assert.equal(flagReads, kind === "owner" ? 1 : 0);
    if (kind === "owner") assert.deepEqual(calls, ["session", "v2:org", "headers", `consent:page:${path}`, "properties", "repair"]);
    else assert.deepEqual(calls, ["session", "v2:org", "redirect:/m"]);
  }
});

test("OV-SH-ORG / OV-SH-NOTI: ON uses session firm and actual admission; read failures propagate", async () => {
  for (const admission of ["enabled", "busy", "disabled", "denied"] as const) for (const receiptTitleAvailable of [false, true]) for (const decided of [true, false, "throws"] as const) for (const portals of [undefined, { owner: false, tenant: false }, { owner: true, tenant: false }, { owner: false, tenant: true }, { owner: true, tenant: true }]) {
    const actor = { ...owner, portals };
    const ui = components("zh-TW", "/o", "avatar");
    const calls: string[] = []; let fail = false;
    const mocks = {
      "next/headers": { headers: async () => ({ get: () => "/o" }) }, "next/navigation": { redirect: () => assert.fail("owner admitted") },
      "@/server/session": { getSession: async () => actor }, "@/server/brand-v2": { brandV2EnabledForOrg: async () => false },
      "@/server/brand-v3": { brandV3EnabledForOrg: async () => true }, "@/server/consent-gate": { requireCurrentConsent: async () => {} },
      "@/server/queries": { ownerPropertyNames: async () => properties }, "@/server/repair-owner-policy": { ownerRepairPolicyEntryIds: async () => ["allowed"] },
      "@/server/auth": { ownerPrivacy: async (id: string) => { assert.equal(id, owner.orgId); calls.push("firm"); return { name: "安居代管" }; } },
      "@/server/notification-center": { centerSessionAdmission: async (s: Session) => { assert.equal(s, actor); calls.push("admission"); if (fail) throw new Error("reader unavailable"); return admission; } },
      "@/server/owner-finance-replies": { ownerReceiptTitleView: async (s: Session) => { assert.equal(s, actor); calls.push("receipt-title"); return receiptTitleAvailable ? { title: null, revisions: [] } : null; } },
      "@/server/repair-approval": { repairApprovalsEnabled: async (id: string) => { assert.equal(id, owner.orgId); calls.push("decided"); if (decided === "throws") throw new Error("flag read failed"); return decided; } },
      "@/server/nav-v3": nav, "@/components/owner-nav": ui.OwnerNav, "@/components/v3/shell/owner-shell": ui.OwnerShell,
    };
    const Layout = compile(source("src/app/o/layout.tsx"), mocks).default as (p: { children: React.ReactNode }) => Promise<React.ReactNode>;
    const html = renderToStaticMarkup(await Layout({ children: <p>retained</p> }));
    assert.deepEqual(calls, ["firm", "admission", "receipt-title", "decided"]);
    // RO-MORE / OV-SH-MORE (B-093): 核准紀錄 only while its page is live; a failed read hides it.
    assert.equal(html.includes('href="/o/decided"'), decided === true);
    assert.equal(html.includes('href="/o/receipt-title"'), receiptTitleAvailable);
    assert.equal(html.includes('data-testid="switch-role"'), Boolean(portals?.owner && portals.tenant));
    assert.match(html, /owner-shell-v3/); assert.match(html, /安居代管/); assert.match(html, /retained/);
    assert.equal(html.includes('data-testid="shell-bell"'), admission === "enabled" || admission === "busy");
    assert.equal(html.includes('href="/o/notifications"'), admission === "enabled" || admission === "busy");
    fail = true; await assert.rejects(Layout({ children: null }), /reader unavailable/);
  }
});

test("OV-SH-PHONE / OV-SH-DESK / OV-SH-ORG / PLT-44: shared markup, plain context and nested current area", () => {
  for (const path of ["/o", "/o/statements", "/o/statements/statement-id", "/o/notifications", "/o/repair-policy/allowed"]) {
    const html = renderOwner({ path });
    assert.match(html, /租多啦・屋主/); assert.match(html, /<div class="cap">林小姐 你好｜管理方：安居代管<\/div>/);
    assert.match(html, /class="appbar navy"/); assert.match(html, /class="sidebar"/); assert.match(html, /class="deskbar"/);
    // OV-SH-DESK-HEAD (batch 4): on 首頁 the page's O-HOME sentence is the h1 and sand lead; the shell adds none.
    assert.equal(html.includes('class="shell-phone-lead"'), path !== "/o", path); assert.match(html, /existing owner content/);
    assert.equal((html.match(/data-testid="shell-bell"/g) ?? []).length, 2);
    assert.equal((html.match(/data-testid="avatar-menu-trigger"/g) ?? []).length, 2);
    const active = path === "/o" ? "home" : path.startsWith("/o/statements") ? "statements" : path === "/o/notifications" ? "notifications" : "more";
    assert.match(html.split('data-testid="v3-phone-tabs"')[1], new RegExp(`data-area="${active}" class="on" aria-current="page"`));
    assert.doesNotMatch(html, /▾|org-switch|href="\/m|env-banner|trial-banner|avatar-menu"|總覽|待入帳|欠租/);
  }
});

test("OV-SH-NONAME / PLT-48-AC2: blank names use person icon, plain company line and no email local part", () => {
  for (const name of ["", "  "]) for (const locale of ["zh-TW", "en"] as const) {
    const html = renderOwner({ name, locale, open: "avatar" });
    assert.equal((html.match(/data-testid="avatar-noname"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /你好|Hello|never-use-this|example.invalid/);
    assert.match(html, locale === "en" ? /Managed by: 安居代管/ : /管理方：安居代管/);
    assert.doesNotMatch(html.split('class="shell-menu-heading"')[1].split("</div>")[0], /<b>/);
  }
});

test("OV-SH-ME: owner bilingual menu has language links and POST logout, no unshipped account or manager tools", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const html = renderOwner({ locale, path: "/o/statements/id", open: "avatar" });
    const menu = html.split('data-testid="avatar-menu"')[1].split('<nav class="tabbar"')[0];
    assert.match(menu, /<b>林小姐<\/b>/);
    assert.match(menu, locale === "en" ? /Owner · 安居代管/ : /屋主・安居代管/);
    assert.match(menu, /href="\/api\/demo\/locale\?set=zh-TW&amp;next=%2Fo%2Fstatements%2Fid"/);
    assert.match(menu, /href="\/api\/demo\/locale\?set=en&amp;next=%2Fo%2Fstatements%2Fid"/);
    assert.equal((menu.match(/aria-current="true"/g) ?? []).length, 1);
    assert.match(menu, /<form action="\/api\/auth\/sign-out" method="post">/);
    assert.doesNotMatch(menu, /avatar-account|reset-demo|api\/env|\/o\/account|\/m\/account/);
  }
});

test("OV-SH-MORE / OWN-27-AC5: only live entries, authorized property names, inline desktop order and empty hiding", () => {
  for (const locale of ["zh-TW", "en"] as const) for (const receiptTitleAvailable of [false, true]) {
    const html = renderOwner({ locale, open: "more", receiptTitleAvailable });
    const menu = html.split('data-testid="more-menu"')[1].split('<nav class="tabbar"')[0];
    assert.deepEqual([...menu.matchAll(/href="([^"]+)"/g)].map(m => m[1]), [...(receiptTitleAvailable ? ["/o/receipt-title"] : []), "/o/repair-policy/allowed"]);
    assert.equal(menu.includes(receiptTitleCopy(locale).title), receiptTitleAvailable);
    assert.equal(html.includes('href="/o/receipt-title"'), receiptTitleAvailable);
    if (receiptTitleAvailable) {
      const receiptPage = renderOwner({ locale, receiptTitleAvailable, path: "/o/receipt-title" });
      assert.ok(receiptPage.includes(`<div class="shell-phone-lead"><h1>${receiptTitleCopy(locale).title}</h1></div>`));
      assert.match(receiptPage, /data-area="receipt-title" class="on" aria-current="page"/);
    }
    assert.doesNotMatch(menu, /href="\/o\/approvals"/);
    assert.ok(menu.includes(`松山公寓 · ${repairCopy.ownerRepairCopy(locale).entry}`));
    assert.doesNotMatch(html, /信義公寓|unassigned|\/o\/(account|invoices|documents|export|ledger|prepay)|請款單|預付與押金|款項紀錄|年度匯出|文件/);
    const sidebar = html.split('data-testid="v3-sidebar-nav"')[1].split("</nav>")[0];
    assert.deepEqual([...sidebar.matchAll(/data-area="([^"]+)"/g)].map(m => m[1]), ["home", "statements", "notifications", ...(receiptTitleAvailable ? ["receipt-title"] : []), "repair-policy-allowed"]);
    const empty = renderOwner({ navigation: { areas: nav.ownerNavigationV3(owner, [], [], "disabled").areas, more: [] } });
    assert.doesNotMatch(empty, /data-area="more"|href=""/);
  }
});

test("OV-SH-NOTI / PLT-44: every admission matches the shipped owner entry and no manager areas leak", async () => {
  for (const admission of ["enabled", "busy", "disabled", "denied"] as const) {
    const model = nav.ownerNavigationV3(owner, [], [], admission);
    const oldEntry = compile(source("src/components/notification-center-entry.tsx"), {
      "next/link": link, "@/i18n/lanes/notification-center": { centerCopy: () => ({ title: "Notifications", busy: "Busy", retry: "Retry" }) },
      "@/server/notification-center": { centerSessionAdmission: async () => admission },
    }).NotificationCenterEntry as (p: { session: Session }) => Promise<React.ReactNode>;
    // Compare the real old entry's visibility, including busy, rather than inventing a stricter gate.
    assert.equal(Boolean(await oldEntry({ session: owner })), model.areas.some(a => a.id === "notifications"));
    assert.deepEqual(nav.areasFor(owner), []); assert.deepEqual(nav.tabsFor(owner), []);
    assert.ok([...model.areas, ...model.more].every(item => item.href === "/o" || item.href.startsWith("/o/")));
  }
});


test("OV-SH-ME: dual-role owners get the shipped tenant switch in the avatar menu only", () => {
  for (const locale of ["zh-TW", "en"] as const) for (const canSwitchToTenant of [false, true]) {
    const html = renderOwner({ locale, canSwitchToTenant, open: "avatar" });
    const menu = html.split('data-testid="avatar-menu"')[1].split('<nav class="tabbar"')[0];
    assert.equal(menu.includes('data-testid="switch-role"'), canSwitchToTenant);
    if (canSwitchToTenant) assert.ok(menu.includes(`href="/t">${i18n.makeT(locale)("i_switch_role_tenant")}</a>`));
    assert.doesNotMatch(renderOwner({ locale, canSwitchToTenant }), /data-testid="switch-role"/);
  }
});

test("OV-SH-PHONE: mounted marker, title-only lead, and surname initials in both locales", () => {
  for (const locale of ["zh-TW", "en"] as const) for (const [name, initial] of [["Jane Smith", "S"], ["  alex   chen  ", "C"], ["林小姐", "林"], ["𠮷田 太郎", "𠮷"], ["Alex", "A"]]) {
    const html = renderOwner({ locale, name, path: "/o/statements" });
    assert.match(html, /<div data-v3-shell="" class="v3-shell v3-owner-shell"/);
    assert.match(html, /<div class="shell-phone-lead"><h1>[^<]+<\/h1><\/div>/);
    assert.equal((html.match(new RegExp(`party-name" aria-hidden="true">${initial}</span>`, "gu")) ?? []).length, 2);
  }
});

test("RO-MORE / OV-SH-MORE / OWN-35 (B-093): 核准紀錄 tops 更多 only when live, and owns its list and decided-ticket paths", () => {
  for (const locale of ["zh-TW", "en"] as const) for (const decided of [false, true]) {
    const navigation = nav.ownerNavigationV3({ ...owner, locale }, properties, ["allowed"], "enabled", true, decided);
    const ids = navigation.more.map(item => item.id);
    assert.deepEqual(ids, [...(decided ? ["decided"] : []), "receipt-title", "repair-policy-allowed"]);
    assert.deepEqual(navigation.areas.map(area => area.id), ["home", "statements", "notifications"]);
    if (!decided) { assert.ok(!navigation.more.some(item => item.href === "/o/decided")); continue; }
    const title = locale === "en" ? "Approval history" : "核准紀錄";
    assert.deepEqual(navigation.more[0], { id: "decided", href: "/o/decided", label: title, icon: "doc" });
    const menu = renderOwner({ locale, open: "more", navigation }).split('data-testid="more-menu"')[1].split('<nav class="tabbar"')[0];
    assert.equal([...menu.matchAll(/href="([^"]+)"/g)].map(m => m[1])[0], "/o/decided");
    for (const path of ["/o/decided", "/o/approvals/10000000-0000-4000-8000-0000000000aa"]) {
      const page = renderOwner({ locale, path, navigation });
      assert.ok(page.includes(`<div class="shell-phone-lead"><h1>${title}</h1></div>`), path);
      assert.match(page, /data-area="decided" class="on" aria-current="page"/);
      assert.match(page, /data-area="more" class="on" aria-current="page"/);
    }
  }
  // Without the entry, an approvals path keeps today's 首頁 fallback.
  const legacy = renderOwner({ path: "/o/approvals/10000000-0000-4000-8000-0000000000aa" });
  assert.ok(legacy.includes('<div class="shell-phone-lead"><h1>首頁</h1></div>'));
});

// OV-SH-DESK-HEAD (round 7 batch 4) heading result: the same markup serves phone and desktop (CSS only moves it).
const headings = (html: string) => [...html.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/g)].map(m => [Number(m[1]), m[2].replace(/<[^>]+>/g, "")] as const);
function ownerHome() {
  const runtime = { "react": React, "react/jsx-runtime": requireHere("react/jsx-runtime"), "node:crypto": requireHere("node:crypto") };
  const load = (file: string, mocks: Record<string, unknown>) => compile(source(file), { ...runtime, ...mocks });
  const emergency = load("src/app/o/approvals/emergency.tsx", { "@/server/repair-approval-rules": rules });
  return load("src/components/v3/owner/home.tsx", { "../../../i18n": i18n, "../../../i18n/lanes/brand-v3": copy, "../../../i18n/repair-approval": approvalCopy,
    "../../../server/repair-approval-rules": rules, "../../../app/o/approvals/decision-request": wire, "../../../app/o/approvals/emergency": emergency,
    "../illustrations": { Illustration }, "../wait-mark": { WaitMark }, "next/navigation": { useRouter: () => ({ refresh() {}, replace() {} }) },
    "next/link": link }).OwnerHomeV3 as React.ComponentType<Record<string, unknown>>;
}
test("OV-SH-DESK-HEAD: owner 首頁 exposes exactly one h1, the O-HOME sentence; headings step down; the title row is not a heading", () => {
  const Home = ownerHome();
  const estimate = { ticketId: "t", versionId: "v", requestId: "r", version: "1", property: "仁愛路 6F", item: "門鎖卡住", amount: "NT$2,800", vendor: null, scope: "s", managementExplanation: null, emergency: null };
  for (const locale of ["zh-TW", "en"] as const) for (const [state, expected] of [
    [{ status: "ready", rows: [estimate] }, locale === "en" ? "林小姐, 1 items need your attention." : "林小姐，有 1 件事要你處理。"],
    [{ status: "ready", rows: [] }, locale === "en" ? "林小姐, nothing needs you right now." : "林小姐，目前沒有要你處理的事。"],
    [{ status: "error" }, locale === "en" ? "Home" : "首頁"],
  ] as const) {
    const html = renderOwner({ locale, children: <Home name="林小姐" locale={locale} state={state} /> });
    const list = headings(html);
    assert.deepEqual(list.filter(([level]) => level === 1), [[1, expected]], `${locale} ${state.status}`);
    assert.equal(list[0][0], 1, "the h1 comes first");
    for (let i = 1; i < list.length; i++) assert.ok(list[i][0] <= list[i - 1][0] + 1, `no skipped level: ${JSON.stringify(list)}`);
    assert.doesNotMatch(html, /class="shell-phone-lead"/);
    assert.ok(html.includes(`<span class="page-title-desk">${locale === "en" ? "Home" : "首頁"}</span>`), "title row names the area, as text");
  }
  // Nothing hides the sentence at either width: no display:none on it, and the shell has no hidden lead left to rely on.
  const css = source("public/brand/v3/owner.css") + source("public/brand/v3/shell.css");
  assert.doesNotMatch(css, /v3-owner-home[^{]*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /:has\(\.v3-owner-home\)/);
  assert.doesNotMatch(css, /\.shell-phone-lead\s*\{[^}]*display:\s*none/);
});
test("OV-SH-DESK-HEAD: every other owner page has exactly one h1, the shell's sand heading", () => {
  for (const path of ["/o/statements", "/o/statements/statement-id", "/o/notifications", "/o/repair-policy/allowed", "/o/approvals/x"]) {
    const html = renderOwner({ path });
    assert.equal(headings(html).filter(([level]) => level === 1).length, 1, path);
    assert.match(html, /<div class="shell-phone-lead"><h1>[^<]+<\/h1><\/div>/, path);
  }
});
