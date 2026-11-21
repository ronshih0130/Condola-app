import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import { ACCOUNT_PHONE_MASK, accountRead, type AccountRead } from "./b073-account";
import { FlowError } from "./errors";
import { brandV3AcctCopy } from "../i18n/lanes/brand-v3-r5-acct";
import { brandV3NotifyCopy } from "../i18n/lanes/brand-v3-r5-notify";
import { makeT } from "../i18n";
import { ACCOUNT_CSS_HREF, AccountError, AccountLayout, AccountLoading, accountLocaleHref } from "../components/v3/m/settings/account";
import type { OrgRole, Session } from "./types";

// B-073 / R5-ACCT (設定 › 我的帳號, MGT-137-AC1…AC4). Synthetic data only; nothing outbound.
const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001";
const IDS: Record<OrgRole, string> = { admin: "00000000-0000-4000-8000-0000000000a1", manager: "00000000-0000-4000-8000-0000000000a2",
  accountant: "00000000-0000-4000-8000-0000000000a3", maintenance: "00000000-0000-4000-8000-0000000000a4" } as Record<OrgRole, string>;
const ROLES = ["admin", "manager", "accountant", "maintenance"] as const;
const staff = (role: OrgRole, locale: "zh-TW" | "en" = "zh-TW"): Session => ({ kind: "staff", role, orgId: ORG, liveOrgId: ORG,
  userId: IDS[role], sessionId: `00000000-0000-4000-8000-0000000000${role === "admin" ? "b1" : "b2"}`, name: `Synthetic ${role}`,
  email: `${role}@example.invalid`, environment: "live", locale, calendar: "gregorian", leaseId: null });
const text = (html: string) => html.replace(/<[^>]+>/g, "");
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
const box = (name: string) => function Box(props: Record<string, unknown>) {
  return <div data-test={name}>{JSON.stringify(props, (_k, v) => typeof v === "function" ? undefined : React.isValidElement(v) ? "[element]" : v)}</div>;
};

test("MGT-137 copy: zh-TW verbatim from the approved frame 「設定・我的帳號」 (PR-018); GS-02 state lines; EN exists", () => {
  const zh = brandV3AcctCopy("zh-TW");
  assert.equal(zh.lead, "我的帳號：只放跟你自己有關的設定。");
  assert.deepEqual([zh.basics, zh.name, zh.email, zh.phone, zh.edit], ["基本資料", "名字", "Email", "手機", "修改"]);
  assert.deepEqual([zh.security, zh.password, zh.line, zh.linked, zh.notLinked], ["登入與安全", "密碼", "LINE", "已連結", "尚未連結"]);
  assert.deepEqual([zh.mfa, zh.mfaOn, zh.mfaOff, zh.devices, zh.deviceCount(2), zh.language], ["兩步驟驗證", "已開啟", "未開啟", "登入中的裝置", "2 台", "介面語言"]);
  assert.deepEqual([zh.readFailed, zh.retry], ["這裡暫時讀不到，請再試一次。", "再試一次"]);
  const t = makeT("zh-TW");
  assert.deepEqual([t("i_lang_zh"), t("i_lang_en")], ["繁中", "EN"]);
  // The footer line is the R5-NOTIFY lane's, reused verbatim.
  const moved = brandV3NotifyCopy("zh-TW");
  assert.equal(moved.movedBefore + moved.movedLink + moved.movedAfter, "提醒信的開關在「通知設定」；全公司的兩步驟驗證規則在「團隊」。");
  const en = brandV3AcctCopy("en");
  assert.deepEqual(Object.keys(en), Object.keys(zh));
  for (const value of Object.values(en)) if (typeof value === "string") assert.doesNotMatch(value, /[一-鿿]/);
  assert.deepEqual([en.deviceCount(1), en.deviceCount(2)], ["1 device", "2 devices"]);
});

const slots = { nameEdit: <form data-testid="slot-name" />, basicsNote: null, password: <form data-testid="slot-password" />,
  mfa: <div data-testid="slot-mfa" />, devices: <div data-testid="slot-devices" /> };
const layout = (over: Partial<React.ComponentProps<typeof AccountLayout>> = {}) => renderToStaticMarkup(<AccountLayout locale="zh-TW" t={makeT("zh-TW")}
  name="陳志明" email="chen@example.invalid" phone="0912-•••-678" line={true} mfaOn={true} deviceCount={2} footer={true} {...slots} {...over} />);

test("MGT-137-AC1 content: 基本資料 and 登入與安全 in the frame's order; masked phone; no solid primary", () => {
  const html = layout();
  assert.equal(text(html), "基本資料名字陳志明Emailchen@example.invalid手機0912-•••-678修改登入與安全密碼修改LINE已連結兩步驟驗證已開啟登入中的裝置2 台介面語言繁中EN"
    + "提醒信的開關在「通知設定」；全公司的兩步驟驗證規則在「團隊」。");
  assert.doesNotMatch(html, /btn pri|class="pri"|btn-primary/);
  assert.match(html, /<summary class="btn sm">修改<\/summary>/);
  assert.match(html, /提醒信的開關在「<a href="\/m\/notify">通知設定<\/a>」；全公司的兩步驟驗證規則在「團隊」。/);
  // Google: the app has no staff Google sign-in, so the row never renders.
  assert.doesNotMatch(html, /Google/);
  // The page's own stylesheet path.
  assert.equal(ACCOUNT_CSS_HREF, "/brand/v3/settings-account.css");
});

test("MGT-137-AC1 rows reflect existing state: MFA on/off, LINE linked/not linked/omitted, device count, phone omitted", () => {
  assert.match(text(layout({ mfaOn: false })), /兩步驟驗證未開啟/);
  assert.match(text(layout({ mfaOn: true })), /兩步驟驗證已開啟/);
  assert.match(text(layout({ line: false })), /LINE尚未連結/);
  assert.doesNotMatch(layout({ line: null }), /LINE|account-line/);
  assert.match(text(layout({ deviceCount: 0 })), /登入中的裝置0 台/);
  assert.match(text(layout({ deviceCount: 5 })), /登入中的裝置5 台/);
  const noPhone = layout({ phone: null });
  assert.doesNotMatch(noPhone, /手機|account-phone/);
  // No 「修改」 under 基本資料 when today's page would not offer the name form.
  assert.doesNotMatch(layout({ nameEdit: null }), /data-testid="account-edit"/);
  // SH-NONAME: an empty name stays empty (no placeholder name).
  assert.match(layout({ name: "" }), /data-testid="account-name"><span class="v3-acct-k">名字<\/span><span class="v3-acct-v"><\/span>/);
  // Footer only where it is given (admin, manager — the roles with personal reminders).
  assert.doesNotMatch(layout({ footer: false }), /notify-moved|通知設定/);
  // EN.
  const en = renderToStaticMarkup(<AccountLayout locale="en" t={makeT("en")} name="N" email="e@example.invalid" phone={null} line={null}
    mfaOn={false} deviceCount={1} footer={true} {...slots} />);
  assert.match(text(en), /^Basic info.*Sign-in and security.*Two-step verificationOff.*Signed-in devices1 device.*Language繁中EN/);
});

test("MGT-137-AC1 each row opens today's flow; the locale pill uses today's mechanism (/api/demo/locale)", () => {
  const html = layout({ mfaOpen: true });
  for (const [row, slot] of [["account-password", "slot-password"], ["account-mfa", "slot-mfa"], ["account-devices", "slot-devices"]]) {
    const at = html.indexOf(`data-testid="${row}"`);
    assert.ok(at > 0 && html.indexOf(`data-testid="${slot}"`) > at, row);
  }
  assert.match(html, /<details class="v3-acct-more" data-testid="account-mfa" open="">/);
  assert.match(html, /<details class="v3-acct-more" data-testid="account-password">/);
  assert.ok(html.indexOf('data-testid="slot-name"') > html.indexOf('data-testid="account-edit"'));
  assert.equal(accountLocaleHref("en"), "/api/demo/locale?set=en&next=%2Fm%2Faccount");
  assert.match(html, /<a href="\/api\/demo\/locale\?set=zh-TW&amp;next=%2Fm%2Faccount" lang="zh-TW" aria-current="true" data-testid="account-locale-zh-TW">繁中<\/a>/);
  assert.match(html, /<a href="\/api\/demo\/locale\?set=en&amp;next=%2Fm%2Faccount" lang="en" data-testid="account-locale-en">EN<\/a>/);
  // The same cookie route the SH-ME pill (LocaleLinks) uses; it sets condola_locale and returns to `next`.
  assert.match(read("src/components/chrome.tsx"), /\/api\/demo\/locale\?set=zh-TW&next=/);
  assert.match(read("src/app/api/demo/locale/route.ts"), /jar\.set\("condola_locale", set/);
});

test("MGT-137-AC4 loading: skeletons hold the layout; no values, counts, switches, links or buttons", () => {
  const html = renderToStaticMarkup(<AccountLoading locale="zh-TW" />);
  assert.match(html, /aria-busy="true"/);
  assert.equal(text(html), "");
  assert.doesNotMatch(html, /<(form|button|a|input|details)\b|role="switch"/);
  assert.equal((html.match(/v3-acct-skeleton/g) ?? []).length, 9);
});

test("MGT-137-AC4 read error: GS-02 sentence + outline 「再試一次」 back to this page; no values", () => {
  const html = renderToStaticMarkup(<AccountError locale="zh-TW" />);
  assert.equal(text(html), "這裡暫時讀不到，請再試一次。再試一次");
  assert.match(html, /<a class="btn" href="\/m\/account">再試一次<\/a>/);
  assert.match(html, /role="alert"/);
});

// ---- accountRead: own data only, fail closed. ----
const own = { phone: "0912-•••-678", line: true };
function deps(calls: string[], over: Record<string, unknown> = {}) {
  return {
    readOwn: async (id: string) => { calls.push(`own:${id}`); return own; },
    readMfa: async (id: string) => { calls.push(`mfa:${id}`); return { enabled: true, required: false }; },
    readDevices: async (id: string) => { calls.push(`devices:${id}`); return [{ id: "d1", userAgent: "UA", ip: null }, { id: "d2", userAgent: null, ip: "IP" }]; },
    readProfile: async (s: Session) => { calls.push(`profile:${s.userId}`); return { state: "ready" as const, name: s.name, version: "v1" }; },
    readChallenge: async (id: string) => { calls.push(`challenge:${id}`); return { secret: "S", otpauth: "O" }; },
    lineSupported: () => true,
    ...over,
  };
}

test("MGT-137-AC1 / AC4 each staff role reads only its own account (user id from the session, never input)", async () => {
  for (const role of ROLES) {
    const calls: string[] = [];
    const result = await accountRead(staff(role), {}, deps(calls));
    assert.equal(result.state, "ready", role);
    const id = IDS[role];
    assert.deepEqual(calls.sort(), [`devices:${id}`, `mfa:${id}`, `own:${id}`, `profile:${id}`].sort(), role);
    if (result.state === "ready") {
      assert.equal(result.devices.length, 2);
      assert.deepEqual(result.mfa, { enabled: true, required: false });
      assert.equal(result.line, true);
      assert.equal(result.challenge, null);
    }
  }
  // The enrollment cookie is read only when the page passes it (today's ?enroll=1).
  const calls: string[] = [];
  const enrolling = await accountRead(staff("manager"), { challengeId: "cookie" }, deps(calls));
  assert.ok(calls.includes("challenge:cookie"));
  assert.deepEqual(enrolling.state === "ready" && enrolling.challenge, { secret: "S", otpauth: "O" });
});

test("MGT-137 accountRead: LINE omitted where the app has no staff LINE Login; never an unmasked phone; failures → unavailable", async () => {
  const off = await accountRead(staff("admin"), {}, deps([], { lineSupported: () => false }));
  assert.equal(off.state === "ready" && off.line, null);
  const none = await accountRead(staff("admin"), {}, deps([], { readOwn: async () => ({ phone: null, line: false }) }));
  assert.equal(none.state === "ready" && none.phone, null);
  for (const raw of ["+886912345678", "0912345678", "0912-345-678", "09xx-•••-678"])
    assert.deepEqual(await accountRead(staff("admin"), {}, deps([], { readOwn: async () => ({ phone: raw, line: false }) })), { state: "unavailable" } satisfies AccountRead, raw);
  for (const masked of ["0912-•••-678", "•••-•••-123", "•••-•••-•••"]) assert.match(masked, ACCOUNT_PHONE_MASK);
  assert.deepEqual(await accountRead(staff("admin"), {}, deps([], { readMfa: async () => { throw new Error("db down"); } })), { state: "unavailable" });
  assert.deepEqual(await accountRead(staff("admin"), {}, deps([], { readOwn: async () => { throw new FlowError("errors.forbidden"); } })), { state: "unavailable" });
  // The real LINE gate is the login page's: never for a live firm.
  const source = read("src/server/b073-account.ts");
  assert.match(source, /demo\.showDemoLineCopy\(session\.environment\) && demo\.lineLoginEnabled\(\)/);
  // The mask is applied inside the database; the full number is never selected.
  assert.doesNotMatch(source, /SELECT[^;]*\bphone_e164 AS\b/);
  assert.match(source, /'09' \|\| substr\(phone_e164, 6, 2\) \|\| '-•••-' \|\| right\(phone_e164, 3\)/);
});

// ---- The v3 page: today's forms and actions, no company-wide controls. ----
function pageMocks(read: AccountRead, cookies: Record<string, string> = {}) {
  const calls: { session?: Session; options?: unknown } = {};
  const mocks = {
    "next/headers": { cookies: async () => ({ get: (key: string) => key in cookies ? { value: cookies[key] } : undefined }) },
    "../../../ui": { PageHeader: ({ title }: { title: React.ReactNode }) => <div className="ph"><h1>{title}</h1></div>, ErrorBanner: box("error-banner") },
    "../../../pending-submit": { PendingSubmit: box("pending-submit") },
    "../../../backup-codes": { BackupCodes: box("backup-codes") },
    "../../../password-field": { PasswordFields: box("password-fields") },
    "../../../../i18n": requireHere("../i18n"),
    "../../../../i18n/lanes/brand-v3-r5-acct": { brandV3AcctCopy },
    "../../../../i18n/staff-profile": requireHere("../i18n/staff-profile"),
    "../../../../server/b073-account": { accountRead: async (session: Session, options: unknown) => { calls.session = session; calls.options = options; return read; } },
    "../../../../server/auth-actions": { actionBeginMfa: "actionBeginMfa", actionChangePassword: "actionChangePassword", actionConfirmMfa: "actionConfirmMfa",
      actionDisableMfa: "actionDisableMfa", actionRevokeOthers: "actionRevokeOthers", actionRevokeSession: "actionRevokeSession" },
    "../../../../server/staff-profile-actions": { actionSaveStaffDisplayName: "actionSaveStaffDisplayName" },
    "../../../../server/auth": { CHALLENGE_COOKIE: "challenge" },
    "../../../../server/backup": { BACKUP_COOKIE: "backup", backupDisplay: (value?: string) => ({ codes: value ? [value] : [], clearCookie: true }) },
    "../../../../server/perms": requireHere("./perms"),
    "./account": requireHere("../components/v3/m/settings/account"),
  };
  return { mocks, calls };
}
const ready = (over: Partial<Extract<AccountRead, { state: "ready" }>> = {}): AccountRead => ({ state: "ready", phone: "0912-•••-678", line: null,
  mfa: { enabled: false, required: false }, devices: [{ id: "00000000-0000-4000-8000-0000000000b1", userAgent: "UA-1", ip: "IP-1" }, { id: "d2", userAgent: null, ip: null }],
  profile: { state: "ready", name: "Synthetic", version: "v1" }, challenge: null, ...over });
async function section(session: Session, read_: AccountRead, params: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  const { mocks, calls } = pageMocks(read_, cookies);
  const mod = compile(read("src/components/v3/m/settings/account-page.tsx"), mocks) as {
    AccountSection: (p: { session: Session; params: Record<string, string> }) => Promise<React.ReactElement>;
    AccountV3Page: (p: { session: Session; params: Record<string, string> }) => React.ReactElement;
  };
  return { html: renderToStaticMarkup(await mod.AccountSection({ session, params })), calls, mod };
}

test("MGT-137 v3 page per role: own session facts, today's actions wired, footer for admin/manager only", async () => {
  for (const role of ROLES) {
    const session = staff(role);
    const { html, calls } = await section(session, ready());
    assert.equal(calls.session, session, role);
    assert.match(html, new RegExp(`Synthetic ${role}`)); assert.match(html, new RegExp(`${role}@example\\.invalid`));
    for (const other of ROLES.filter(r => r !== role)) assert.doesNotMatch(html, new RegExp(`${other}@example`), `${role} sees ${other}`);
    assert.match(html, /0912-•••-678/);
    // Each action is today's server action, unchanged.
    for (const action of ["actionSaveStaffDisplayName", "actionChangePassword", "actionBeginMfa", "actionRevokeOthers", "actionRevokeSession"])
      assert.match(html, new RegExp(`action="${action}"`), `${role} ${action}`);
    assert.equal((html.match(/action="actionRevokeSession"/g) ?? []).length, 2);
    assert.match(text(html), /登入中的裝置2 台/);
    assert.match(text(html), /兩步驟驗證未開啟/);
    assert.equal(/data-testid="notify-moved"/.test(html), role === "admin" || role === "manager", role);
    // No solid primary; every form button is outline.
    assert.doesNotMatch(html, /btn pri|chip pri/);
    // MGT-137-AC2: no company-wide switches.
    assert.doesNotMatch(html, /require-mfa|i_require_mfa|actionRequireMfa|name="require"|mail-lease|mail-overdue|actionEmailPrefs|actionOrgMail|i_mail_heading|role="switch"/);
  }
});

test("MGT-137 v3 page: today's MFA states (setup, reset + off, locked, enroll, backup codes) and the name-form returns", async () => {
  const s = staff("manager");
  const on = (await section(s, ready({ mfa: { enabled: true, required: false } }))).html;
  const zt = makeT("zh-TW");
  assert.match(on, new RegExp(`action="actionBeginMfa"><button class="btn" type="submit" data-testid="mfa-start">${zt("i_mfa_reset")}</button>`)); assert.match(on, /action="actionDisableMfa"/); assert.match(text(on), /兩步驟驗證已開啟/);
  const locked = (await section(s, ready({ mfa: { enabled: true, required: true } }))).html;
  assert.match(locked, /data-testid="mfa-locked"/); assert.doesNotMatch(locked, /actionDisableMfa|actionBeginMfa/);
  const enroll = await section(s, ready({ challenge: { secret: "SECRETX", otpauth: "otpauth://x" } }), { enroll: "1" }, { challenge: "cookie-id" });
  assert.deepEqual(enroll.calls.options, { challengeId: "cookie-id" });
  assert.match(enroll.html, /action="actionConfirmMfa"/); assert.match(enroll.html, /<details class="v3-acct-more" data-testid="account-mfa" open="">/);
  assert.deepEqual((await section(s, ready())).calls.options, {});
  const backup = (await section(s, ready(), { backup: "1" }, { backup: "CODE1" })).html;
  assert.match(backup, /data-test="backup-codes"/); assert.match(backup, /CODE1/);
  const stale = (await section(s, ready(), { profile: "stale" })).html;
  assert.match(stale, /role="status">名稱已變更，請重新檢查後再儲存。/); assert.match(stale, /data-testid="account-edit" open=""/);
  // No name form when today's page would not offer it; the sandbox note and live link stay.
  const sandbox = (await section({ ...s, environment: "sandbox" }, ready({ profile: { state: "unavailable" } }))).html;
  assert.doesNotMatch(sandbox, /actionSaveStaffDisplayName|account-edit/); assert.match(sandbox, /\/api\/env\?set=live&amp;next=%2Fm%2Faccount/);
  // This device is marked (outline chip), as today.
  const mine = (await section(staff("admin"), ready())).html;
  assert.equal((mine.match(new RegExp(`<span class="chip">${zt("i_this_device")}</span>`, "g")) ?? []).length, 1);
  // A failed read shows the read error, no values.
  const failed = (await section(s, { state: "unavailable" })).html;
  assert.match(failed, /data-testid="account-error"/); assert.doesNotMatch(failed, /0912|action=/);
});

test("MGT-137 v3 page shell: own stylesheet, the lead as the header, today's result lines, skeleton while reading", async () => {
  const { mod } = await section(staff("admin"), ready());
  const tree = mod.AccountV3Page({ session: staff("admin"), params: { error: "errors.forbidden", saved: "1" } });
  const html = renderToStaticMarkup(<>{(tree.props as { children: React.ReactElement[] }).children.slice(0, 4)}</>);
  assert.match(html, /^<link rel="stylesheet" href="\/brand\/v3\/settings-account.css"\/>/);
  assert.match(html, /<h1[^>]*>我的帳號：只放跟你自己有關的設定。<\/h1>/);
  assert.match(html, /data-test="error-banner">\{&quot;error&quot;:&quot;errors.forbidden&quot;\}/); assert.match(html, /class="alert ok"/);
  const suspense = (tree.props as { children: React.ReactElement[] }).children[4] as React.ReactElement<{ fallback: React.ReactElement }>;
  assert.equal(suspense.type, React.Suspense);
  assert.match(renderToStaticMarkup(suspense.props.fallback), /data-testid="account-loading"/);
  // The stylesheet is loaded only by the v3 page; the flag-OFF page never references it.
  assert.doesNotMatch(read("src/app/m/account/page.tsx"), /settings-account\.css/);
});

test("MGT-137-AC2 sources: the v3 page imports no company-wide control and no reminder read; no new API route", () => {
  const page = read("src/components/v3/m/settings/account-page.tsx") + read("src/components/v3/m/settings/account.tsx") + read("src/server/b073-account.ts");
  assert.doesNotMatch(page, /actionRequireMfa|actionEmailPrefs|actionOrgMail|memberEmailPrefs|orgMailSettings|setRequireMfa|requireMfa\(/);
  // Read only: no INSERT/UPDATE/DELETE and no write helper in the R5-ACCT reader.
  assert.doesNotMatch(read("src/server/b073-account.ts"), /\b(INSERT|UPDATE|DELETE)\b|writeAudit|\btx\(/);
});

test("R5-ACCT CSS: v3-scoped, tokens only, ≥44px targets, visible focus", () => {
  const css = read("public/brand/v3/settings-account.css");
  postcss.parse(css).walkRules(rule => { for (const s of rule.selectors) assert.ok(s.startsWith('html[data-brand="v2"][data-brand-v3] .v3-acct'), s); });
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/i);
  assert.match(css, /\.v3-acct-row\{[^}]*min-height:44px/);
  assert.match(css, /\.v3-acct-pill a\{[^}]*min-width:44px/);
  assert.match(css, /\.v3-acct :is\(a,\.btn,summary\):focus-visible\{ outline:2px solid var\(--c-focus\)/);
});
