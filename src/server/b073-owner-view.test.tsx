import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import { ownerViewRead, saveOwnerView } from "./b073-owner-view";
import { FlowError } from "./errors";
import * as perms from "./perms";
import { brandV3OwnViewCopy } from "../i18n/lanes/brand-v3-r5-ownview";
import { OwnerViewError, OwnerViewLayout, OwnerViewLoading, OwnerViewSwitchRows } from "../components/v3/m/settings/owner-view";
import { afterToggleSave, initialOwnerViewState, startToggle, syncOwnerView } from "../components/v3/m/settings/owner-view-state";
import type { OrgRole, Session } from "./types";

// B-073 / R5-OWNVIEW (設定 › 規則與資料 › 屋主看得到什麼, MGT-138-AC1…AC4 + route move). Synthetic data only.
const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const read_ = read;
const BASE = "5cfeaa71612644697c4474f20bba0b42e074b65e"; // origin/main before this slice
const baseline = (p: string) => execFileSync("git", ["show", `${BASE}:${p}`], { encoding: "utf8" });
const ORG = "00000000-0000-4000-8000-000000000001";
const staff = (role: OrgRole, locale: "zh-TW" | "en" = "zh-TW"): Session => ({ kind: "staff", role, orgId: ORG, liveOrgId: ORG,
  userId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic",
  email: "fixture@example.invalid", environment: "live", locale, calendar: "gregorian", leaseId: null });
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const switches = (html: string) => [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(m => m[0]);
const checked = (html: string, field: string) => switches(html).find(s => s.includes(`data-field="${field}"`))?.match(/aria-checked="(true|false)"/)?.[1];
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

test("MGT-138 copy: zh-TW verbatim from the approved frame (PR-018); GS-02 state lines; EN exists", () => {
  const zh = brandV3OwnViewCopy("zh-TW");
  assert.equal(zh.lead, "規則與資料：公司資料、管理費規則，和屋主看得到什麼。");
  assert.equal(zh.title, "屋主看得到什麼");
  assert.equal(zh.description, "全公司一個設定，對所有屋主都一樣。");
  assert.deepEqual([zh.showName, zh.showNameSub], ["租客姓名", "屋主在月報和首頁看得到租客的名字。"]);
  assert.deepEqual([zh.showPhone, zh.showPhoneSub], ["租客電話", "屋主看得到租客的手機號碼。"]);
  assert.equal(zh.others, "這一頁的其他設定");
  assert.equal(zh.companyTaxId("安居物業", "12345678"), "安居物業・統編 12345678");
  assert.deepEqual([zh.company, zh.notify, zh.notifyWhere], ["公司資料", "提醒租客", "在「通知設定」"]);
  assert.deepEqual([zh.readFailed, zh.retry, zh.saveFailed], ["這裡暫時讀不到，請再試一次。", "再試一次", "沒有存成功，請再試一次。"]);
  const en = brandV3OwnViewCopy("en");
  assert.deepEqual(Object.keys(en), Object.keys(zh));
  for (const value of Object.values(en)) if (typeof value === "string") assert.doesNotMatch(value, /[一-鿿]/);
});

test("MGT-138-AC4 loading: skeletons hold the layout; no switches, buttons or values (nothing savable)", () => {
  const html = renderToStaticMarkup(<OwnerViewLoading locale="zh-TW" />);
  assert.match(html, /aria-busy="true"/);
  assert.equal(switches(html).length, 0);
  assert.doesNotMatch(html, /<button|<a |租客姓名|租客電話/);
  assert.ok((html.match(/v3-ownview-skeleton/g) ?? []).length >= 4);
});

test("MGT-138-AC4 read failure: 「這裡暫時讀不到，請再試一次。」 + 「再試一次」, switches hidden", () => {
  const html = renderToStaticMarkup(<OwnerViewError locale="zh-TW" />);
  assert.match(html, /這裡暫時讀不到，請再試一次。/);
  assert.match(html, /<a class="btn" href="\/m\/settings">再試一次<\/a>/);
  assert.equal(switches(html).length, 0);
  assert.doesNotMatch(html, /租客姓名|租客電話/);
});

test("MGT-138-AC1 ready: block, both accessible switches with the stored values, side card rows", () => {
  for (const privacy of [{ showName: true, showPhone: false }, { showName: false, showPhone: true }]) {
    const html = renderToStaticMarkup(<OwnerViewLayout locale="zh-TW" company={{ name: "安居物業", taxId: "12345678" }}>
      <OwnerViewSwitchRows locale="zh-TW" state={initialOwnerViewState(privacy)} />
    </OwnerViewLayout>);
    const t = text(html);
    for (const s of ["屋主看得到什麼", "全公司一個設定，對所有屋主都一樣。", "租客姓名", "屋主在月報和首頁看得到租客的名字。", "租客電話",
      "屋主看得到租客的手機號碼。", "這一頁的其他設定", "公司資料", "安居物業・統編 12345678", "提醒租客", "在「通知設定」"]) assert.ok(t.includes(s), s);
    assert.equal(switches(html).length, 2);
    assert.equal(checked(html, "showName"), String(privacy.showName));
    assert.equal(checked(html, "showPhone"), String(privacy.showPhone));
    for (const s of switches(html)) { assert.match(s, /type="button"/); assert.match(s, /aria-labelledby="v3-ownview-show(Name|Phone)"/); assert.doesNotMatch(s, /aria-disabled/); }
    assert.match(html, /<a href="\/m\/notify">在「通知設定」<\/a>/);
    // B-049 (管理費規則) is not built: the row is not shown. No solid primary, nothing sent to owners.
    assert.doesNotMatch(t, /管理費規則|依物件設定/);
    assert.doesNotMatch(html, /btn pri|<form/);
    assert.doesNotMatch(t, /沒有存成功/);
  }
  const noTax = text(renderToStaticMarkup(<OwnerViewLayout locale="zh-TW" company={{ name: "安居物業", taxId: null }}><i /></OwnerViewLayout>));
  assert.ok(noTax.includes("公司資料安居物業")); assert.doesNotMatch(noTax, /統編/);
  const noName = text(renderToStaticMarkup(<OwnerViewLayout locale="zh-TW" company={{ name: "", taxId: "12345678" }}><i /></OwnerViewLayout>));
  assert.doesNotMatch(noName, /公司資料|統編/); assert.match(noName, /提醒租客/);
  assert.match(renderToStaticMarkup(<OwnerViewLayout locale="en" company={{ name: "Anju", taxId: null }}><i /></OwnerViewLayout>), /What owners can see/);
});

test("MGT-138-AC4 save: a tap flips at once and locks both switches; failure returns the saved value with the line", () => {
  const start = initialOwnerViewState({ showName: true, showPhone: false });
  const saving = startToggle(start, "showPhone")!;
  assert.deepEqual(saving.shown, { showName: true, showPhone: true });
  assert.equal(saving.saving, "showPhone");
  assert.equal(startToggle(saving, "showName"), null, "no second save while one runs");
  const busy = renderToStaticMarkup(<OwnerViewSwitchRows locale="zh-TW" state={saving} />);
  assert.equal(switches(busy).filter(s => s.includes('aria-disabled="true"')).length, 2);
  assert.equal(checked(busy, "showPhone"), "true");
  for (const outcome of [{ ok: false as const, status: 500 as const }, { ok: false as const, status: 403 as const }, "threw" as const]) {
    const failed = afterToggleSave(saving, outcome);
    assert.deepEqual(failed, { saved: start.saved, shown: start.saved, saving: null, error: true });
    const html = renderToStaticMarkup(<OwnerViewSwitchRows locale="zh-TW" state={failed} />);
    assert.equal(checked(html, "showPhone"), "false");
    assert.match(html, /role="alert">沒有存成功，請再試一次。</);
    assert.equal(switches(html).filter(s => s.includes("aria-disabled")).length, 0);
  }
  const saved = afterToggleSave(saving, { ok: true, privacy: { showName: true, showPhone: true } });
  assert.deepEqual(saved, { saved: { showName: true, showPhone: true }, shown: { showName: true, showPhone: true }, saving: null, error: false });
  assert.equal(startToggle(afterToggleSave(saving, "threw"), "showName")!.error, false, "a new tap clears the line");
  assert.equal(syncOwnerView(saving, { showName: false, showPhone: false }), saving, "props never override a running save");
  assert.deepEqual(syncOwnerView(saved, { showName: false, showPhone: false }).shown, { showName: false, showPhone: false });
});

test("client switches: initial render from props; saves through POST /api/owner-view (no redirect, no router)", async () => {
  const source = read("src/components/v3/m/settings/owner-view-switches.tsx");
  assert.match(source, /^"use client";/);
  assert.match(source, /postOwnerView\(field, next\.shown\[field\]\)/);
  assert.doesNotMatch(source, /redirect\(|useRouter|sendMail|from "next\/|"use server"|b073-owner-view-actions/);
  const view = requireHere("../components/v3/m/settings/owner-view");
  const state = requireHere("../components/v3/m/settings/owner-view-state");
  const ui = compile(source, { "./owner-view": view, "./owner-view-state": state });
  const Switches = ui.OwnerViewSwitches as React.FC<{ locale: "zh-TW"; privacy: { showName: boolean; showPhone: boolean } }>;
  const html = renderToStaticMarkup(<Switches locale="zh-TW" privacy={{ showName: false, showPhone: true }} />);
  assert.equal(checked(html, "showName"), "false"); assert.equal(checked(html, "showPhone"), "true");
  // postOwnerView: same-origin JSON POST; any non-2xx (403 included) or malformed body fails; a network error is "threw".
  const calls: [string, RequestInit][] = [];
  const fake = (status: number, body: unknown = null) => (async (url: string, init: RequestInit) => { calls.push([url, init]);
    return new Response(body === null ? null : JSON.stringify(body), { status }); }) as unknown as typeof fetch;
  assert.deepEqual(await state.postOwnerView("showPhone", true, fake(200, { privacy: { showName: true, showPhone: true } })), { ok: true, privacy: { showName: true, showPhone: true } });
  assert.deepEqual(calls[0][0], "/api/owner-view");
  assert.equal(calls[0][1].method, "POST"); assert.equal(calls[0][1].body, JSON.stringify({ field: "showPhone", value: true }));
  assert.deepEqual((calls[0][1].headers as Record<string, string>)["Content-Type"], "application/json");
  for (const status of [400, 401, 403, 415, 500]) assert.deepEqual(await state.postOwnerView("showName", false, fake(status)), { ok: false, status });
  assert.deepEqual(await state.postOwnerView("showName", false, fake(200, { privacy: { showName: "no" } })), { ok: false, status: 200 });
  assert.equal(await state.postOwnerView("showName", false, (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch), "threw");
});

test("MGT-138-AC3 server: a non-admin is forbidden (403) before any read or write; bad input is 400", async () => {
  for (const role of ["manager", "accountant", "maintenance"] as const) {
    const trace: string[] = [];
    const deps = { read: async () => { trace.push("read"); return { settings: {}, name: "x", tax_id: null }; }, write: async () => { trace.push("write"); return { showName: true, showPhone: true }; } };
    assert.deepEqual(await saveOwnerView(staff(role), { field: "showName", value: false }, deps), { ok: false, status: 403 });
    assert.deepEqual(await ownerViewRead(staff(role), deps), { state: "forbidden" });
    assert.deepEqual(trace, [], role);
  }
  for (const input of [null, {}, { field: "showEmail", value: true }, { field: "showName", value: "on" }, "showName"]) {
    const trace: string[] = [];
    assert.deepEqual(await saveOwnerView(staff("admin"), input, { read: async () => { trace.push("read"); return undefined; }, write: async () => { trace.push("write"); return { showName: true, showPhone: true }; } }), { ok: false, status: 400 });
    assert.deepEqual(trace, []);
  }
  // A forbidden answer from the write's own in-transaction guard (authority changed mid-request) is also a 403.
  assert.deepEqual(await saveOwnerView(staff("admin"), { field: "showName", value: false },
    { write: async () => { throw new FlowError("errors.forbidden"); } }), { ok: false, status: 403 });
});

test("MGT-138-AC1/AC2 server: admin saves one switch; only that key is written, no read first", async () => {
  const writes: unknown[] = [];
  const read = async () => { throw new Error("the save must not read first"); };
  const write = async (_s: Session, field: string, value: boolean) => { writes.push([field, value]); return { showName: true, showPhone: value }; };
  assert.deepEqual(await saveOwnerView(staff("admin"), { field: "showPhone", value: true }, { read, write }), { ok: true, privacy: { showName: true, showPhone: true } });
  assert.deepEqual(writes, [["showPhone", true]]);
  // A failed write is a 500 result, never a redirect or a throw.
  assert.deepEqual(await saveOwnerView(staff("admin"), { field: "showName", value: false }, { write: async () => { throw new Error("db down"); } }), { ok: false, status: 500 });
  // The single-key statement: a closed key map, jsonb_set on one path, same guard + tx + owner_privacy audit; setOwnerPrivacy unchanged.
  const own = read_("src/server/b073-owner-view.ts");
  assert.match(own, /showName: "show_tenant_name", showPhone: "show_tenant_phone"/);
  assert.match(own, /SET settings = jsonb_set\(coalesce\(settings, '\{\}'::jsonb\), \$2::text\[\], to_jsonb\(\$3::boolean\), true\)/);
  assert.match(own, /requireEffectivePerm\(client, session, "settings\.edit"\)/);
  assert.match(own, /writeAudit\(session\.orgId, session\.userId, "owner_privacy", \{ showName: privacy\.showName, showPhone: privacy\.showPhone \}, client\)/);
  assert.match(own, /await audit\(client, session, privacy\);\n    return privacy;\n  \}, requireOrgScope\(session\)\)/);
  assert.doesNotMatch(own, /setOwnerPrivacy\(/);
  // The reader: same parse as ownerPrivacy; 統編 only when stored; failure → unavailable.
  assert.deepEqual(await ownerViewRead(staff("admin"), { read: async () => ({ settings: null, name: " 安居物業 ", tax_id: " " }) }),
    { state: "ready", privacy: { showName: true, showPhone: false }, company: { name: "安居物業", taxId: null } });
  assert.deepEqual(await ownerViewRead(staff("admin"), { read: async () => ({ settings: { show_tenant_name: false }, name: "安居物業", tax_id: "12345678" }) }),
    { state: "ready", privacy: { showName: false, showPhone: false }, company: { name: "安居物業", taxId: "12345678" } });
  assert.deepEqual(await ownerViewRead(staff("admin"), { read: async () => { throw new Error("db down"); } }), { state: "unavailable" });
  assert.deepEqual(await ownerViewRead(staff("admin"), { read: async () => undefined }), { state: "unavailable" });
  // setOwnerPrivacy (flag OFF, /m/roles form) is unchanged.
  const auth = read_("src/server/auth.ts");
  assert.equal(auth.slice(auth.indexOf("export async function setOwnerPrivacy"), auth.indexOf("export async function tenantDisplayNames")),
    baseline("src/server/auth.ts").slice(baseline("src/server/auth.ts").indexOf("export async function setOwnerPrivacy"), baseline("src/server/auth.ts").indexOf("export async function tenantDisplayNames")));
});

test("MGT-138-AC3 route: same-origin JSON only; non-admin → HTTP 403; bad body 400; admin 200 with the stored state", async () => {
  const source = read("src/app/api/owner-view/route.ts");
  const trace: unknown[] = [];
  let session: Session | null = staff("admin");
  let save: (s: Session, input: unknown) => Promise<unknown> = saveOwnerView as never;
  const route = compile(source, {
    "@/server/consent-gate": { requireCurrentConsent: async (_s: Session, mode: string) => { trace.push(`consent:${mode}`); return null; } },
    "@/server/session": { readSession: async () => { trace.push("session"); return session; } },
    "@/server/b073-owner-view": { saveOwnerView: (s: Session, input: unknown) => save(s, input) },
    "@/server/errors": { logServerError: () => { trace.push("logged"); } },
  }).POST as (r: Request) => Promise<Response>;
  const post = (body: unknown, init: { origin?: string | null; type?: string } = {}) => route(new Request("http://localhost/api/owner-view", { method: "POST",
    headers: { ...(init.origin === null ? {} : { Origin: init.origin ?? "http://localhost" }), "Content-Type": init.type ?? "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body) }));
  for (const origin of ["http://evil.example", null]) {
    trace.length = 0; const res = await post({ field: "showName", value: false }, { origin });
    assert.equal(res.status, 403); assert.deepEqual(trace, ["consent:api", "session"], "consent guard first, then the session; cross-origin is refused before the body is read");
  }
  assert.equal((await post({ field: "showName", value: false }, { type: "text/plain" })).status, 415);
  for (const role of ["manager", "accountant", "maintenance"] as const) {
    session = staff(role); const res = await post({ field: "showPhone", value: true });
    assert.equal(res.status, 403, role); assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  }
  session = staff("admin");
  for (const body of ["{", "null", JSON.stringify({ field: "showEmail", value: true }), JSON.stringify({ field: "showName", value: 1 })]) assert.equal((await post(body)).status, 400, body);
  save = async (_s, input) => { trace.push(input); return { ok: true, privacy: { showName: true, showPhone: true } }; };
  trace.length = 0;
  const ok = await post({ field: "showPhone", value: true });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { privacy: { showName: true, showPhone: true } });
  assert.deepEqual(trace, ["consent:api", "session", { field: "showPhone", value: true }]);
  save = async () => ({ ok: false, status: 500 }); assert.equal((await post({ field: "showPhone", value: true })).status, 500);
  save = async () => { throw new Error("boom"); }; trace.length = 0;
  assert.equal((await post({ field: "showPhone", value: true })).status, 500); assert.ok(trace.includes("logged"));
  session = null; assert.equal((await post({ field: "showPhone", value: true })).status, 401);
  assert.equal(JSON.parse(read("src/server/b017-entry-permissions.json"))["src/app/api/owner-view/route.ts#POST"], "settings.edit");
  assert.doesNotMatch(JSON.stringify(JSON.parse(read("src/server/b017-entry-permissions.json"))), /b073-owner-view-actions/);
  assert.deepEqual(perms.rolesFor("settings.edit"), ["admin"]);
  // 42501 from the database is also a 403.
  assert.deepEqual(await saveOwnerView(staff("admin"), { field: "showName", value: true }, { write: async () => { throw Object.assign(new Error("denied"), { code: "42501" }); } }), { ok: false, status: 403 });
});

// ---- Pages: flag OFF byte-for-byte; ON route move. ----
const box = (name: string) => function Box(props: Record<string, unknown>) {
  return <div data-test={name}>{JSON.stringify(props, (_k, v) => typeof v === "function" ? undefined : React.isValidElement(v) ? "[element]" : v)}</div>;
};
function settingsMocks(v3: boolean, trace: string[], session: Session) {
  return {
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => { trace.push("flag"); return v3; } },
    "@/components/v3/m/settings/owner-view": { OwnerViewLoading: box("owner-view-loading") },
    "@/components/v3/m/settings/page": { OwnerViewSection: box("owner-view-section") },
    "@/i18n/lanes/brand-v3-r5-ownview": { brandV3OwnViewCopy },
    "@/server/upgrade-gate": { upgradeGate: async () => ({ redirectTo: null }) },
    "@/server/billing": { FREE_UNITS: 5 },
    "@/server/b017-custom-role-governance": { guardEffectiveSession: async (s: Session, key: string) => { trace.push(`guard:${key}`); return s; } },
    "@/server/consent-gate": { requireCurrentConsent: async () => { trace.push("consent"); return null; } },
    "@/i18n": { makeT: () => (key: string) => key },
    "@/components/ui": { ErrorBanner: box("error"), PageHeader: box("header") },
    "@/server/auth-actions": { actionOrgMail: "actionOrgMail", actionOwnerPrivacy: "actionOwnerPrivacy" },
    "@/server/mail-settings": { orgMailSettings: async () => { trace.push("mail"); return { tenantLease: true, tenantOverdue: false, contactEmail: "a@example.invalid", contactPhone: "" }; } },
    "@/server/perms": perms,
    "@/server/platform": { isPlatformAdmin: () => false },
    "@/server/session": { getSession: async () => session },
    "@/components/partner-consent-history": { PartnerConsentHistory: box("pch") },
    "@/components/payee-settings": { PayeeSettings: box("payee") },
    "@/server/pricing-interim": { isPricingInterimEnabled: async () => false },
    "@/components/usage-card": { UsageCard: box("usage") },
    "@/server/seats": { commercialTier: async () => "free" },
    "@/server/sandbox": { countActiveUnits: async () => 0 },
    "@/server/b056-trial": { trialCardState: async () => null },
    "@/server/b056-trial-rules": { formatTrialDate: () => "", parseTrialPlan: () => null, previewTrialEnd: () => new Date(0) },
    "@/components/b056-trial-confirm": { TrialConfirm: box("trial-confirm") },
    "@/server/auth": { ownerPrivacy: async () => { trace.push("privacy"); return { showName: true, showPhone: false, name: "x" }; } },
    // R5-TEAM (MGT-133-AC1): under brand_v3 /m/roles opens 團隊 (b073-team.test.tsx covers it).
    "next/navigation": { redirect: (to: string) => { trace.push(`redirect:${to}`); throw Object.assign(new Error("NEXT_REDIRECT"), { to, trace: [...trace] }); } },
  };
}
async function renderPage(source: string, v3: boolean, session: Session, query: Record<string, string> = {}) {
  const trace: string[] = [];
  const page = compile(source, settingsMocks(v3, trace, session)).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>;
  const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve(query) }));
  return { html, trace: trace.filter(step => step !== "flag") };
}

test("MGT-138 flag OFF: /m/settings and /m/roles render byte-for-byte as before, same reads in the same order", async () => {
  for (const file of ["src/app/m/settings/page.tsx", "src/app/m/roles/page.tsx"]) {
    for (const session of [staff("admin"), staff("admin", "en"), { ...staff("admin"), environment: "sandbox" as const }, staff("manager")])
      for (const query of [{}, { saved: "1", error: "errors.forbidden" }] as Record<string, string>[]) {
        assert.deepEqual(await renderPage(read(file), false, session, query), await renderPage(baseline(file), false, session, query), `${file} ${session.role} ${JSON.stringify(query)}`);
      }
  }
  const off = (await renderPage(read("src/app/m/roles/page.tsx"), false, staff("admin"))).html;
  assert.match(off, /data-testid="privacy-name"/); assert.match(off, /data-testid="privacy-phone"/);
  // The legacy form action is kept for OFF.
  assert.match(read("src/server/auth-actions.ts"), /export async function actionOwnerPrivacy/);
});

test("MGT-138 route move (brand_v3 ON): /m/roles has no privacy checkboxes and does not read them; /m/settings opens with the block", async () => {
  // R5-TEAM (MGT-133-AC1) later moved /m/roles under brand_v3 to 團隊: an admin is redirected before any privacy read.
  const roles = await renderPage(read("src/app/m/roles/page.tsx"), true, staff("admin")).then(() => null, (error: { to?: string; trace?: string[] }) => error);
  assert.equal(roles?.to, "/m/team?perms=1#v3-team-perms");
  assert.ok(!roles?.trace?.includes("privacy"));
  const settings = await renderPage(read("src/app/m/settings/page.tsx"), true, staff("admin"));
  const header = settings.html.indexOf('data-test="header"'), section = settings.html.indexOf('data-test="owner-view-section"'), mail = settings.html.indexOf('data-testid="tenant-lease-mail"');
  assert.ok(header >= 0 && header < section && section < mail, "lead, then the block, then the rest of today's page");
  assert.ok(settings.html.includes(JSON.stringify({ title: "規則與資料：公司資料、管理費規則，和屋主看得到什麼。" }).replace(/"/g, "&quot;")));
  assert.doesNotMatch(settings.html, /i_nav_settings/);
  for (const id of ["settings-plan", "idv-retain-days", "org-contact-email"]) assert.match(settings.html, new RegExp(`data-testid="${id}"`), id);
  assert.equal((settings.html.match(/data-test="owner-view-section"/g) ?? []).length, 1);
});

test("R5-OWNVIEW CSS: v3-scoped, tokens only, ≥44px switch, white focus ring", () => {
  const css = read("public/brand/v3/shell.css");
  const block = css.slice(css.indexOf("/* R5-OWNVIEW"));
  assert.ok(block.length > 100);
  postcss.parse(block).walkRules(rule => { for (const s of rule.selectors) assert.ok(s.startsWith('html[data-brand="v2"][data-brand-v3] .v3-ownview'), s); });
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/i);
  assert.match(block, /\.v3-ownview-switch\{[^}]*min-width:44px; min-height:44px/);
  assert.match(block, /\.v3-ownview-switch:focus-visible \.v3-ownview-knob\{ box-shadow:0 0 0 2px var\(--c-on-primary\),0 0 0 4px var\(--c-focus\); \}/);
});
