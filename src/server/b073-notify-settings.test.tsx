import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import { notifySettingsRead, saveNotifySetting } from "./b073-notify-settings";
import { FlowError } from "./errors";
import * as perms from "./perms";
import * as brand from "../i18n/lanes/brand-v3";
import { brandV3NotifyCopy } from "../i18n/lanes/brand-v3-r5-notify";
import { NotifyError, NotifyLayout, NotifyLoading, NotifyMovedLine, NotifySwitchRows } from "../components/v3/m/settings/notify";
import { afterNotifySave, initialNotifyState, startNotifyToggle, syncNotify } from "../components/v3/m/settings/notify-state";
import type { OrgRole, Session } from "./types";

// B-073 / R5-NOTIFY (設定 › 通知設定, MGT-135-AC1…AC5). Synthetic data only; nothing outbound.
const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const staff = (role: OrgRole, locale: "zh-TW" | "en" = "zh-TW"): Session => ({ kind: "staff", role, orgId: ORG, liveOrgId: ORG,
  userId: USER, sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic",
  email: "fixture@example.invalid", environment: "live", locale, calendar: "gregorian", leaseId: null });
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const switches = (html: string) => [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(m => m[0]);
const checked = (html: string, block: string, field: string) => switches(html)
  .find(s => s.includes(`data-block="${block}"`) && s.includes(`data-field="${field}"`))?.match(/aria-checked="(true|false)"/)?.[1];
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
const ON = { leaseExpiry: true, rentOverdue: true };

test("MGT-135 copy: zh-TW verbatim from the approved frame (PR-018); GS-02 state lines; EN exists", () => {
  const zh = brandV3NotifyCopy("zh-TW");
  assert.equal(zh.lead, "通知設定：決定你自己收哪些提醒，也決定租客收哪些。");
  assert.deepEqual([zh.mine, zh.mineLease, zh.mineLeaseSub, zh.mineOverdue, zh.mineOverdueSub],
    ["寄給我的", "租約快到期", "租約到期前提醒我。", "逾期未繳", "有租金逾期時提醒我。"]);
  assert.deepEqual([zh.tenant, zh.tenantNote, zh.tenantLease, zh.tenantLeaseSub, zh.tenantOverdue, zh.tenantOverdueSub],
    ["寄給租客的", "只有管理員看得到這一塊。", "租約到期", "租約快到期時提醒租客。", "租金逾期", "租金逾期時提醒租客。"]);
  assert.equal(zh.footer, "這一頁只存設定，改了不會因此多寄任何東西。");
  assert.deepEqual([zh.readFailed, zh.retry, zh.saveFailed], ["這裡暫時讀不到，請再試一次。", "再試一次", "沒有存成功，請再試一次。"]);
  // MGT-135-AC2 我的帳號 line: the first clause of the approved R5-ACCT sentence.
  assert.equal(zh.movedBefore + zh.movedLink + zh.movedAfter, "提醒信的開關在「通知設定」。");
  const en = brandV3NotifyCopy("en");
  assert.deepEqual(Object.keys(en), Object.keys(zh));
  for (const value of Object.values(en)) assert.doesNotMatch(value, /[一-鿿]/);
  // The nav label already says 通知設定 (i_nav_notify), matching the frame's 「設定 › 通知設定」.
  const lane = read("src/i18n/lanes/brand-v3-r5-notify.ts");
  for (const cite of ["MGT-135", "設定・通知設定", "PR-018"]) assert.ok(lane.includes(cite), cite);
  assert.ok(brand.brandV3NavigationCopy("zh-TW"));
});

test("MGT-135-AC5 loading: skeletons hold the layout; no switches, buttons or values (nothing savable)", () => {
  const html = renderToStaticMarkup(<NotifyLoading locale="zh-TW" />);
  assert.match(html, /aria-busy="true"/);
  assert.equal(switches(html).length, 0);
  assert.doesNotMatch(html, /<button|<a |租約快到期|逾期未繳|租約到期|租金逾期|寄給/);
  assert.ok((html.match(/v3-notify-skeleton/g) ?? []).length >= 4);
});

test("MGT-135 read failure: 「這裡暫時讀不到，請再試一次。」 + 「再試一次」, switches hidden", () => {
  const html = renderToStaticMarkup(<NotifyError locale="zh-TW" />);
  assert.match(html, /這裡暫時讀不到，請再試一次。/);
  assert.match(html, /<a class="btn" href="\/m\/notify">再試一次<\/a>/);
  assert.equal(switches(html).length, 0);
});

const ready = (tenant: boolean, me = { leaseExpiry: true, rentOverdue: false }, org = { leaseExpiry: false, rentOverdue: true }) =>
  renderToStaticMarkup(<NotifyLayout locale="zh-TW"
    mine={<NotifySwitchRows locale="zh-TW" block="me" state={initialNotifyState(me)} />}
    tenant={tenant ? <NotifySwitchRows locale="zh-TW" block="tenant" state={initialNotifyState(org)} /> : null} />);

test("MGT-135-AC1 admin: 寄給我的 and 寄給租客的, four accessible switches with the stored values, the footer", () => {
  const html = ready(true), t = text(html);
  for (const s of ["寄給我的", "租約快到期", "租約到期前提醒我。", "逾期未繳", "有租金逾期時提醒我。", "寄給租客的", "只有管理員看得到這一塊。",
    "租約到期", "租約快到期時提醒租客。", "租金逾期", "租金逾期時提醒租客。", "這一頁只存設定，改了不會因此多寄任何東西。"]) assert.ok(t.includes(s), s);
  assert.equal(switches(html).length, 4);
  assert.equal(checked(html, "me", "leaseExpiry"), "true"); assert.equal(checked(html, "me", "rentOverdue"), "false");
  assert.equal(checked(html, "tenant", "leaseExpiry"), "false"); assert.equal(checked(html, "tenant", "rentOverdue"), "true");
  for (const s of switches(html)) {
    assert.match(s, /type="button"/); assert.match(s, /aria-labelledby="v3-notify-(me|tenant)-(leaseExpiry|rentOverdue)"/);
    assert.match(s, /aria-describedby="v3-notify-(me|tenant)-(leaseExpiry|rentOverdue)-sub"/); assert.doesNotMatch(s, /aria-disabled/);
  }
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, "ids are unique across both blocks");
  // Order: 寄給我的 block, then 寄給租客的, then the footer.
  assert.ok(t.indexOf("寄給我的") < t.indexOf("寄給租客的") && t.indexOf("寄給租客的") < t.indexOf("這一頁只存設定"));
  // MGT-135-AC3: no manager LINE or Email push option; no solid primary or form.
  assert.doesNotMatch(t, /LINE|推播|Email/);
  assert.doesNotMatch(html, /btn pri|<form/);
  assert.doesNotMatch(t, /沒有存成功/);
});

test("MGT-135-AC1/AC4 non-admin (manager): only 寄給我的; 寄給租客的 is not shown", () => {
  const html = ready(false), t = text(html);
  assert.ok(t.includes("寄給我的")); assert.ok(t.includes("這一頁只存設定，改了不會因此多寄任何東西。"));
  assert.doesNotMatch(t, /寄給租客的|只有管理員看得到這一塊|提醒租客/);
  assert.equal(switches(html).length, 2);
  assert.ok(switches(html).every(s => s.includes('data-block="me"')));
  assert.match(renderToStaticMarkup(<NotifyLayout locale="en" mine={<i />} tenant={null} />), /Sent to me/);
});

test("MGT-135-AC5 save: a tap flips at once and locks the block; failure returns the saved value with the line", () => {
  const start = initialNotifyState({ leaseExpiry: true, rentOverdue: false });
  const saving = startNotifyToggle(start, "rentOverdue")!;
  assert.deepEqual(saving.shown, { leaseExpiry: true, rentOverdue: true });
  assert.equal(saving.saving, "rentOverdue");
  assert.equal(startNotifyToggle(saving, "leaseExpiry"), null, "no second save while one runs");
  const busy = renderToStaticMarkup(<NotifySwitchRows locale="zh-TW" block="me" state={saving} />);
  assert.equal(switches(busy).filter(s => s.includes('aria-disabled="true"')).length, 2);
  assert.equal(checked(busy, "me", "rentOverdue"), "true");
  for (const outcome of [{ ok: false as const, status: 500 }, { ok: false as const, status: 403 }, "threw" as const]) {
    const failed = afterNotifySave(saving, outcome);
    assert.deepEqual(failed, { saved: start.saved, shown: start.saved, saving: null, error: true });
    const html = renderToStaticMarkup(<NotifySwitchRows locale="zh-TW" block="tenant" state={failed} />);
    assert.equal(checked(html, "tenant", "rentOverdue"), "false");
    assert.match(html, /role="alert">沒有存成功，請再試一次。</);
    assert.equal(switches(html).filter(s => s.includes("aria-disabled")).length, 0);
  }
  const saved = afterNotifySave(saving, { ok: true, toggles: { leaseExpiry: true, rentOverdue: true } });
  assert.deepEqual(saved, { saved: ON, shown: ON, saving: null, error: false });
  assert.equal(startNotifyToggle(afterNotifySave(saving, "threw"), "leaseExpiry")!.error, false, "a new tap clears the line");
  assert.equal(syncNotify(saving, { leaseExpiry: false, rentOverdue: false }), saving, "props never override a running save");
  assert.deepEqual(syncNotify(saved, { leaseExpiry: false, rentOverdue: false }).shown, { leaseExpiry: false, rentOverdue: false });
});

test("client switches: initial render from props; saves through POST /api/notify-settings (no redirect, no router, no send)", async () => {
  const source = read("src/components/v3/m/settings/notify-switches.tsx");
  assert.match(source, /^"use client";/);
  assert.match(source, /postNotify\(block, field, next\.shown\[field\]\)/);
  assert.doesNotMatch(source, /redirect\(|useRouter|sendMail|from "next\/|"use server"/);
  const view = requireHere("../components/v3/m/settings/notify");
  const state = requireHere("../components/v3/m/settings/notify-state");
  const ui = compile(source, { "./notify": view, "./notify-state": state });
  const Switches = ui.NotifySwitches as React.FC<{ locale: "zh-TW"; block: "me" | "tenant"; toggles: { leaseExpiry: boolean; rentOverdue: boolean } }>;
  const html = renderToStaticMarkup(<Switches locale="zh-TW" block="tenant" toggles={{ leaseExpiry: false, rentOverdue: true }} />);
  assert.equal(checked(html, "tenant", "leaseExpiry"), "false"); assert.equal(checked(html, "tenant", "rentOverdue"), "true");
  const calls: [string, RequestInit][] = [];
  const fake = (status: number, body: unknown = null) => (async (url: string, init: RequestInit) => { calls.push([url, init]);
    return new Response(body === null ? null : JSON.stringify(body), { status }); }) as unknown as typeof fetch;
  assert.deepEqual(await state.postNotify("me", "rentOverdue", true, fake(200, { block: "me", toggles: ON })), { ok: true, toggles: ON });
  assert.equal(calls[0][0], "/api/notify-settings");
  assert.equal(calls[0][1].method, "POST"); assert.equal(calls[0][1].body, JSON.stringify({ block: "me", field: "rentOverdue", value: true }));
  assert.equal((calls[0][1].headers as Record<string, string>)["Content-Type"], "application/json");
  for (const status of [400, 401, 403, 415, 500]) assert.deepEqual(await state.postNotify("tenant", "leaseExpiry", false, fake(status)), { ok: false, status });
  assert.deepEqual(await state.postNotify("tenant", "leaseExpiry", false, fake(200, { block: "me", toggles: ON })), { ok: false, status: 200 }, "another block's answer fails");
  assert.deepEqual(await state.postNotify("me", "leaseExpiry", false, fake(200, { block: "me", toggles: { leaseExpiry: "no" } })), { ok: false, status: 200 });
  assert.equal(await state.postNotify("me", "leaseExpiry", false, (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch), "threw");
});

type Trace = string[];
const deps = (trace: Trace) => ({
  readMine: async (orgId: string, userId: string) => { trace.push(`readMine:${orgId === ORG && userId === USER}`); return { lease_expiry: false }; },
  readTenant: async () => { trace.push("readTenant"); return { email_tenant_rent_overdue: false }; },
  writeMine: async (s: Session, field: string, value: boolean) => { trace.push(`writeMine:${s.userId}:${field}:${value}`); return { leaseExpiry: value, rentOverdue: true }; },
  writeTenant: async (s: Session, field: string, value: boolean) => { trace.push(`writeTenant:${s.orgId}:${field}:${value}`); return { leaseExpiry: true, rentOverdue: value }; },
});

test("MGT-135-AC1/AC4 reader: admin both blocks; manager 寄給我的 only (tenant never read); others forbidden before any read", async () => {
  let trace: Trace = [];
  assert.deepEqual(await notifySettingsRead(staff("admin"), deps(trace)),
    { state: "ready", me: { leaseExpiry: false, rentOverdue: true }, tenant: { leaseExpiry: true, rentOverdue: false } });
  assert.deepEqual(trace, ["readMine:true", "readTenant"]);
  trace = [];
  assert.deepEqual(await notifySettingsRead(staff("manager"), deps(trace)), { state: "ready", me: { leaseExpiry: false, rentOverdue: true }, tenant: null });
  assert.deepEqual(trace, ["readMine:true"]);
  for (const role of ["accountant", "maintenance"] as const) {
    trace = [];
    assert.deepEqual(await notifySettingsRead(staff(role), deps(trace)), { state: "forbidden" }, role);
    assert.deepEqual(trace, [], role);
  }
  // Missing rows or a failing read: unavailable (the page shows the read error).
  assert.deepEqual(await notifySettingsRead(staff("admin"), { ...deps([]), readMine: async () => undefined }), { state: "unavailable" });
  assert.deepEqual(await notifySettingsRead(staff("admin"), { ...deps([]), readTenant: async () => undefined }), { state: "unavailable" });
  assert.deepEqual(await notifySettingsRead(staff("manager"), { ...deps([]), readMine: async () => { throw new Error("db down"); } }), { state: "unavailable" });
  // Same parse as the scheduled sender: absent keys are on.
  assert.deepEqual(await notifySettingsRead(staff("admin"), { readMine: async () => ({}), readTenant: async () => ({}) }), { state: "ready", me: ON, tenant: ON });
  // Who has personal reminders: admin and manager; an assigned custom role also needs settings.edit.
  assert.deepEqual((["admin", "manager", "accountant", "maintenance"] as const).map(r => perms.hasPersonalReminders(staff(r))), [true, true, false, false]);
  const customManager = { ...staff("manager"), customRole: { orgId: ORG, userId: USER, sessionId: staff("admin").sessionId, nativeRole: "manager" as const, keys: ["props.view"] as perms.PermKey[], photos: false, audit: false } };
  assert.equal(perms.hasPersonalReminders(customManager), false);
  assert.equal(perms.hasPersonalReminders({ ...staff("admin"), kind: "tenant" }), false);
});

test("MGT-135-AC4 save: a non-admin is refused (403) for 寄給租客的 and nothing is written; bad input is 400", async () => {
  for (const role of ["manager", "accountant", "maintenance"] as const) {
    const trace: Trace = [];
    for (const field of ["leaseExpiry", "rentOverdue"]) assert.deepEqual(await saveNotifySetting(staff(role), { block: "tenant", field, value: false }, deps(trace)), { ok: false, status: 403 }, role);
    assert.deepEqual(trace, [], role);
  }
  for (const role of ["accountant", "maintenance"] as const) {
    const trace: Trace = [];
    assert.deepEqual(await saveNotifySetting(staff(role), { block: "me", field: "leaseExpiry", value: false }, deps(trace)), { ok: false, status: 403 }, role);
    assert.deepEqual(trace, [], role);
  }
  for (const input of [null, {}, "me", { block: "owner", field: "leaseExpiry", value: true }, { block: "me", field: "contactEmail", value: true },
    { block: "tenant", field: "leaseExpiry", value: "on" }, { block: "me", field: "leaseExpiry" }]) {
    const trace: Trace = [];
    assert.deepEqual(await saveNotifySetting(staff("admin"), input, deps(trace)), { ok: false, status: 400 }, JSON.stringify(input));
    assert.deepEqual(trace, []);
  }
  // A forbidden answer from the write's own in-transaction guard, or 42501 from the database, is also a 403.
  assert.deepEqual(await saveNotifySetting(staff("admin"), { block: "tenant", field: "leaseExpiry", value: false },
    { writeTenant: async () => { throw new FlowError("errors.forbidden"); } }), { ok: false, status: 403 });
  assert.deepEqual(await saveNotifySetting(staff("admin"), { block: "tenant", field: "leaseExpiry", value: false },
    { writeTenant: async () => { throw Object.assign(new Error("denied"), { code: "42501" }); } }), { ok: false, status: 403 });
});

test("MGT-135-AC1/AC3 save: one key per save, no read first; 寄給我的 writes only the caller's own row", async () => {
  const noRead = { readMine: async () => { throw new Error("the save must not read first"); }, readTenant: async () => { throw new Error("the save must not read first"); } };
  let trace: Trace = [];
  assert.deepEqual(await saveNotifySetting(staff("admin"), { block: "tenant", field: "rentOverdue", value: false }, { ...deps(trace), ...noRead }),
    { ok: true, block: "tenant", toggles: { leaseExpiry: true, rentOverdue: false } });
  assert.deepEqual(trace, [`writeTenant:${ORG}:rentOverdue:false`]);
  for (const role of ["admin", "manager"] as const) {
    trace = [];
    assert.deepEqual(await saveNotifySetting(staff(role), { block: "me", field: "leaseExpiry", value: false, userId: "someone-else" }, { ...deps(trace), ...noRead }),
      { ok: true, block: "me", toggles: { leaseExpiry: false, rentOverdue: true } });
    assert.deepEqual(trace, [`writeMine:${USER}:leaseExpiry:false`], "the session's own user, never an id from input");
  }
  assert.deepEqual(await saveNotifySetting(staff("manager"), { block: "me", field: "leaseExpiry", value: false }, { writeMine: async () => { throw new Error("db down"); } }), { ok: false, status: 500 });
  // The statements: closed key maps, jsonb_set on one path each; org_id + user_id from the session; same tx + guard as R5-OWNVIEW.
  const own = read("src/server/b073-notify-settings.ts");
  assert.match(own, /leaseExpiry: "lease_expiry", rentOverdue: "rent_overdue"/);
  assert.match(own, /leaseExpiry: "email_tenant_lease_expiry", rentOverdue: "email_tenant_rent_overdue"/);
  assert.match(own, /SET email_prefs = jsonb_set\(coalesce\(email_prefs, '\{\}'::jsonb\), \$3::text\[\], to_jsonb\(\$4::boolean\), true\)/);
  assert.match(own, /WHERE org_id = \$1 AND user_id = \$2\n  RETURNING email_prefs`,\n    \[session\.orgId, session\.userId, \[MEMBER_KEY\[field\]\], value\]/);
  assert.match(own, /SET settings = jsonb_set\(coalesce\(settings, '\{\}'::jsonb\), \$2::text\[\], to_jsonb\(\$3::boolean\), true\)/);
  assert.match(own, /requireEffectivePerm\(client, session, "settings\.edit"\)/);
  // The scheduled sender reads the same keys with the same parsers.
  assert.match(own, /import \{ readMemberPrefs, readTenantToggles \} from "\.\/reminders";/);
  // MGT-135-AC3 nothing outbound: no mail, LINE, queue, notification or outbox call; no audit (the existing mail-settings writes have none).
  const code = own.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /from "\.\/mail"|sendMail|\bline\b|notification|outbox|email_log|enqueue|fetch\(|writeAudit/i);
  assert.doesNotMatch(read("src/server/mail-settings.ts"), /writeAudit/);
  assert.doesNotMatch(read("src/app/api/notify-settings/route.ts"), /sendMail|fetch\(|enqueue/);
});

test("MGT-135-AC4 route: same-origin JSON only; non-admin 寄給租客的 → HTTP 403; bad body 400; 200 with the stored block", async () => {
  const source = read("src/app/api/notify-settings/route.ts");
  const trace: unknown[] = [];
  let session: Session | null = staff("admin");
  let save: (s: Session, input: unknown) => Promise<unknown> = saveNotifySetting as never;
  const route = compile(source, {
    "@/server/consent-gate": { requireCurrentConsent: async (_s: Session, mode: string) => { trace.push(`consent:${mode}`); return null; } },
    "@/server/session": { readSession: async () => { trace.push("session"); return session; } },
    "@/server/b073-notify-settings": { saveNotifySetting: (s: Session, input: unknown) => save(s, input) },
    "@/server/errors": { logServerError: () => { trace.push("logged"); } },
  }).POST as (r: Request) => Promise<Response>;
  const post = (body: unknown, init: { origin?: string | null; type?: string } = {}) => route(new Request("http://localhost/api/notify-settings", { method: "POST",
    headers: { ...(init.origin === null ? {} : { Origin: init.origin ?? "http://localhost" }), "Content-Type": init.type ?? "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body) }));
  for (const origin of ["http://evil.example", null]) {
    trace.length = 0; const res = await post({ block: "tenant", field: "leaseExpiry", value: false }, { origin });
    assert.equal(res.status, 403); assert.deepEqual(trace, ["consent:api", "session"], "consent guard first, then the session; cross-origin refused before the body is read");
  }
  assert.equal((await post({ block: "me", field: "leaseExpiry", value: false }, { type: "text/plain" })).status, 415);
  assert.equal((await post("x".repeat(2048))).status, 413);
  for (const role of ["manager", "accountant", "maintenance"] as const) {
    session = staff(role); const res = await post({ block: "tenant", field: "rentOverdue", value: true });
    assert.equal(res.status, 403, role); assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  }
  session = staff("accountant"); assert.equal((await post({ block: "me", field: "rentOverdue", value: true })).status, 403);
  session = staff("admin");
  for (const body of ["{", "null", JSON.stringify({ block: "tenant", field: "contactEmail", value: true }), JSON.stringify({ block: "me", field: "leaseExpiry", value: 1 })])
    assert.equal((await post(body)).status, 400, body);
  save = async (_s, input) => { trace.push(input); return { ok: true, block: "tenant", toggles: ON }; };
  trace.length = 0;
  const ok = await post({ block: "tenant", field: "rentOverdue", value: true });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { block: "tenant", toggles: ON });
  assert.deepEqual(trace, ["consent:api", "session", { block: "tenant", field: "rentOverdue", value: true }]);
  save = async () => ({ ok: false, status: 500 }); assert.equal((await post({ block: "me", field: "rentOverdue", value: true })).status, 500);
  save = async () => { throw new Error("boom"); }; trace.length = 0;
  assert.equal((await post({ block: "me", field: "rentOverdue", value: true })).status, 500); assert.ok(trace.includes("logged"));
  session = null; assert.equal((await post({ block: "me", field: "rentOverdue", value: true })).status, 401);
  const entries = JSON.parse(read("src/server/b017-entry-permissions.json"));
  for (const id of ["src/app/api/notify-settings/route.ts#POST", "src/server/b073-notify-settings.ts#notifySettingsRead", "src/server/b073-notify-settings.ts#saveNotifySetting"])
    assert.equal(entries[id], "settings.edit", id);
});

test("MGT-135 page body: ready → both blocks for admin, one for manager; forbidden → nothing; failure → read error", async () => {
  let result: unknown = { state: "ready", me: ON, tenant: ON };
  const box = (name: string) => function Box(props: Record<string, unknown>) { return <div data-test={name} data-block={String(props.block)} />; };
  const page = compile(read("src/components/v3/m/settings/notify-page.tsx"), {
    "../../../ui": { PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> },
    "../../../../i18n/lanes/brand-v3-r5-notify": { brandV3NotifyCopy },
    "../../../../server/b073-notify-settings": { notifySettingsRead: async () => result },
    "./notify": requireHere("../components/v3/m/settings/notify"),
    "./notify-switches": { NotifySwitches: box("switches") },
  });
  const Section = page.NotifySection as (p: { session: Session }) => Promise<React.ReactElement | null>;
  const admin = renderToStaticMarkup((await Section({ session: staff("admin") }))!);
  assert.deepEqual([...admin.matchAll(/data-test="switches" data-block="(\w+)"/g)].map(m => m[1]), ["me", "tenant"]);
  result = { state: "ready", me: ON, tenant: null };
  const manager = renderToStaticMarkup((await Section({ session: staff("manager") }))!);
  assert.deepEqual([...manager.matchAll(/data-test="switches" data-block="(\w+)"/g)].map(m => m[1]), ["me"]);
  assert.doesNotMatch(text(manager), /寄給租客的/);
  result = { state: "forbidden" }; assert.equal(await Section({ session: staff("accountant") }), null);
  result = { state: "unavailable" }; assert.match(renderToStaticMarkup((await Section({ session: staff("admin") }))!), /data-testid="notify-error"/);
  // The v3 page: its own stylesheet, the approved lead as the header, the loading skeleton while the body reads.
  const V3 = page.NotifyV3Page as (p: { session: Session }) => React.ReactElement;
  const tree = V3({ session: staff("admin") });
  const kids = React.Children.toArray((tree.props as { children: React.ReactNode }).children) as React.ReactElement<Record<string, unknown>>[];
  assert.equal(kids[0].type, "link"); assert.deepEqual(kids[0].props, { rel: "stylesheet", href: "/brand/v3/settings-notify.css" });
  assert.equal(renderToStaticMarkup(kids[1]), "<h1>通知設定：決定你自己收哪些提醒，也決定租客收哪些。</h1>");
  assert.equal(kids[2].type, React.Suspense);
  assert.match(renderToStaticMarkup(kids[2].props.fallback as React.ReactElement), /data-testid="notify-loading"/);
});

test("MGT-135-AC1 /m/notify page and layout: brand_v3 opens it for admin and manager; OFF keeps today's route gate", async () => {
  // Page: flag ON renders the v3 page; OFF renders today's empty notice.
  const pageSource = read("src/app/m/notify/page.tsx");
  for (const v3 of [false, true]) {
    const trace: string[] = [];
    const Page = compile(pageSource, {
      "@/server/consent-gate": { requireCurrentConsent: async () => { trace.push("consent"); } }, "@/i18n": { makeT: () => (key: string) => key },
      "@/components/ui": { PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }, "@/server/session": { getSession: async () => staff("manager") },
      "@/server/brand-v3": { brandV3EnabledForOrg: async () => v3 }, "@/components/v3/m/settings/notify-page": { NotifyV3Page: () => <div data-test="notify-v3" /> },
    }).default as () => Promise<React.ReactElement>;
    const html = renderToStaticMarkup(await Page());
    if (v3) { assert.equal(html, '<div data-test="notify-v3"></div>'); } else { assert.match(html, /data-testid="notify-empty"/); assert.doesNotMatch(html, /notify-v3/); }
    assert.deepEqual(trace, ["consent"]);
  }
  // Layout admission (exact /m/notify only).
  type Layout = (p: { children: React.ReactNode }) => Promise<React.ReactNode>;
  const stub = () => null;
  for (const flag of [false, true]) for (const role of ["admin", "manager", "accountant", "maintenance"] as const) for (const path of ["/m/notify", "/m/notify/x"]) {
    const session = staff(role);
    const Layout = compile(read("src/app/m/layout.tsx"), {
      "@/i18n/lanes/brand-v3": brand, "@/server/brand-v3": { brandV3EnabledForOrg: async () => flag },
      "@/server/nav-v3": { areasFor: () => [], tabsFor: () => [] }, "@/components/v3/shell/manager-shell": { ManagerShellV3: stub },
      "next/headers": { headers: async () => ({ get: () => path }), cookies: async () => ({ get: () => undefined }) },
      "next/navigation": { redirect: (href: string) => { throw new Error(href); } }, "@/build-info": { BUILD_SHA: "fixture" },
      "@/components/chrome": { Sidebar: stub, TaskPanel: stub }, "@/server/consent-gate": { requireCurrentConsent: async () => {} },
      "@/server/demo": { demoModeEnabled: () => false }, "@/server/perms": perms,
      "@/server/queries": { loadManagerChrome: async () => ({ flags: {}, firm: { name: "Company" }, badge: {} }) },
      "@/server/session": { getSession: async () => session }, "@/server/b056-trial": { trialBannerFor: async () => null }, "@/components/b056-trial-banner": { TrialBanner: stub },
    }).default as Layout;
    const allowed = role === "admin" || (flag && role === "manager" && path === "/m/notify");
    if (allowed) await Layout({ children: null });
    else await assert.rejects(() => Layout({ children: null }), /\/m\/noperm\?need=settings\.edit/, `${role} ${flag} ${path}`);
  }
});

test("MGT-135-AC2 我的帳號 link line: one line linking to 通知設定", () => {
  const html = renderToStaticMarkup(<NotifyMovedLine locale="zh-TW" />);
  assert.equal(html, '<p class="card pad" data-testid="notify-moved">提醒信的開關在「<a href="/m/notify">通知設定</a>」。</p>');
  assert.match(renderToStaticMarkup(<NotifyMovedLine locale="en" />), /Reminder email switches are in <a href="\/m\/notify">Notifications<\/a>\./);
  // 規則與資料: the R5-OWNVIEW side-card row is that page's one link line; actionOrgMail keeps the stored values under brand_v3.
  const actions = read("src/server/auth-actions.ts");
  const orgMail = actions.slice(actions.indexOf("export async function actionOrgMail"), actions.indexOf("export async function actionAccept"));
  assert.match(orgMail, /const moved = await brandV3EnabledForOrg\(session\.orgId\);/);
  assert.match(orgMail, /tenantLease: moved \? null : formData\.get\("tenantLease"\) === "on",/);
  assert.match(orgMail, /tenantOverdue: moved \? null : formData\.get\("tenantOverdue"\) === "on",/);
});

test("R5-NOTIFY CSS: own file, v3-scoped, tokens only, ≥44px switch, white focus ring; loaded only by this page", () => {
  const css = read("public/brand/v3/settings-notify.css");
  postcss.parse(css).walkRules(rule => { for (const s of rule.selectors) assert.ok(s.startsWith('html[data-brand="v2"][data-brand-v3] .v3-notify'), s); });
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/i);
  assert.match(css, /\.v3-notify-switch\{[^}]*min-width:44px; min-height:44px/);
  assert.match(css, /\.v3-notify-switch:focus-visible \.v3-notify-knob\{ box-shadow:0 0 0 2px var\(--c-on-primary\),0 0 0 4px var\(--c-focus\); \}/);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const users = walk("src").filter(f => !/\.test\.tsx?$/.test(f) && /\.(ts|tsx|css)$/.test(f) && read(f).includes("settings-notify.css"));
  assert.deepEqual(users, ["src/components/v3/m/settings/notify.tsx"]);
  assert.doesNotMatch(read("public/brand/v3/shell.css"), /v3-notify/);
});
