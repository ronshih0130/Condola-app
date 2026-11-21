import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssignEmpty, AssignError, AssignListView, AssignLoading, AssignNoPerm, AssignNoUnits, ASSIGN_ADD_HREF, assignEditHref } from "../components/v3/m/settings/assign";
import { AssignFormView, toggleUnit } from "../components/v3/m/settings/assign-form";
import { createAssignFormController, type AssignSubmitInput } from "../lib/assign-form";
import { TeamRowActionsCell } from "../components/v3/m/settings/team-actions";
import { brandV3AssignCopy } from "../i18n/lanes/brand-v3-assign";
import {
  assignEdit, assignList, authorizeAssign, maintUnitAssignEnabledForOrg, parseAssignBody, parseAssignEdit, parseAssignList, saveAssign,
} from "./b059-maint-unit-assign";
import type { TeamRowV3 } from "./b073-team";
import { areasFor, navLabel, tabsFor } from "./nav-v3";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// MGT-118 (B-059 / DO-3) unit tests. Synthetic ids only; the database cases are in the integration test.
const O = "00000000-0000-4000-8000-0000000000a1", U = "00000000-0000-4000-8000-0000000000b1", S = "00000000-0000-4000-8000-0000000000c1";
const P1 = "00000000-0000-4000-8000-0000000000d1", P2 = "00000000-0000-4000-8000-0000000000d2";
const U1 = "00000000-0000-4000-8000-0000000000e1", U2 = "00000000-0000-4000-8000-0000000000e2", U3 = "00000000-0000-4000-8000-0000000000e3";
const R = "00000000-0000-4000-8000-0000000000f1";
const staff = (role: Session["role"]): Session => ({ kind: "staff", role, orgId: O, liveOrgId: O, userId: U, sessionId: S, name: "", email: "",
  environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
/** A fake service transaction answering the gateway with `result` (or throwing). Records the SQL it saw. */
function fakeTx(result: unknown, seen: string[] = []) {
  return (async (_user: string | null, fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) =>
    fn({ query: async (sql: string) => {
      seen.push(sql);
      if (result instanceof Error) throw result;
      return { rows: sql.includes("app.b059_") ? [{ result }] : [] };
    } })) as never;
}

test("MGT-118 copy: zh-TW verbatim from the approved frames and the daily-ops mockup; no banned words", () => {
  const c = brandV3AssignCopy("zh-TW");
  assert.equal(c.title, "單位分派");
  assert.equal(c.help, "管理員和經理一樣看得到全部；維修人員只看得到分派給自己的單位工單。單張工單還是可以再指定處理人。");
  assert.equal(c.person, "{name}・維修人員");
  assert.equal(c.assigned, "已分派 {n} 個單位");
  assert.equal(c.edit, "編輯");
  assert.equal(c.emptyTitle, "還沒有維修人員");
  assert.equal(c.emptyBody, "先到團隊頁加入維修人員。");
  assert.equal(c.emptyAdd, "新增同事");
  assert.equal(c.emptyManager, "還沒有維修人員，請管理員先加入。");
  assert.equal(c.noPermTitle, "你沒有權限看這頁");
  assert.equal(c.noPermBody, "單位分派只有管理員和經理能改。");
  assert.equal(c.editTitle, "負責的單位・{name}");
  assert.equal(c.editHelp, "勾選要分派給{name}的單位。");
  assert.equal(c.noUnitsBody, "建好單位後，才能分派給{name}。");
  assert.equal(c.teamLink, "負責的單位");
  for (const text of Object.values(c)) assert.doesNotMatch(text, /收款|收租|代收|入帳|已收|保證|員工頁|新增員工/);
  assert.deepEqual(Object.keys(brandV3AssignCopy("en")).sort(), Object.keys(c).sort());
});

test("MGT-118-AC1 list: one row per maintenance person, 「{名字}・維修人員」, 「已分派 {n} 個單位」, outline 「編輯」, no solid button", () => {
  const out = html(<AssignListView locale="zh-TW" canAdd people={[{ id: P1, kind: "member", name: "阿明", units: 2 }, { id: P2, kind: "invite", name: "lin@example.test", units: 0 }]} />);
  assert.match(out, /<h1[^>]*>單位分派<\/h1>/);
  assert.match(out, /管理員和經理一樣看得到全部/);
  assert.match(out, /阿明・維修人員/);
  assert.match(out, /已分派 2 個單位/);
  assert.match(out, /已分派 0 個單位/);
  assert.equal((out.match(/class="btn"[^>]*>編輯</g) ?? []).length, 2);
  assert.doesNotMatch(out, /btn pri/);
  assert.ok(out.includes(`href="${assignEditHref(P1)}"`));
  assert.ok(out.includes(`href="/m/assign/${P2}"`));
});

test("MGT-118-AC6 empty: admin gets illustration + 「新增同事」 to R5-ADD; manager only the sentence and no button", () => {
  const add = html(<AssignEmpty locale="zh-TW" canAdd />);
  assert.match(add, /還沒有維修人員/); assert.match(add, /先到團隊頁加入維修人員。/);
  assert.match(add, /<svg/);
  assert.match(add, /<a class="btn pri"[^>]*href="\/m\/team\?add=1#v3-team-panel"/);
  assert.equal(ASSIGN_ADD_HREF, "/m/team?add=1#v3-team-panel");
  assert.match(add, />新增同事</);
  const manager = html(<AssignEmpty locale="zh-TW" canAdd={false} />);
  assert.match(manager, /還沒有維修人員，請管理員先加入。/);
  assert.doesNotMatch(manager, /btn|<a |新增同事/);
  assert.match(html(<AssignListView locale="zh-TW" canAdd={false} people={[]} />), /還沒有維修人員，請管理員先加入。/);
});

test("MGT-118-AC7/AC8 states: no-permission has no edit; read failure keeps the page with 「再試一次」 to the same URL; skeleton has no text", () => {
  const perm = html(<AssignNoPerm locale="zh-TW" />);
  assert.match(perm, /你沒有權限看這頁/); assert.match(perm, /單位分派只有管理員和經理能改。/);
  assert.doesNotMatch(perm, /編輯|<a |<button/);
  const error = html(<AssignError locale="zh-TW" retryHref={assignEditHref(P1)} />);
  assert.match(error, /這裡暫時讀不到，請再試一次。/);
  assert.ok(error.includes(`href="/m/assign/${P1}"`));
  assert.match(error, />再試一次</);
  const loading = html(<AssignLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading.replace(/aria-label="[^"]*"/, ""), /[一-鿿]/);
});

test("assign-edit: h1 「負責的單位・{名字}」, help, a checkbox per unit, one solid 「儲存」; a failed save keeps every check (AC8)", () => {
  const units = [{ id: U1, label: "民生東路 1F" }, { id: U2, label: "民生東路 2F" }, { id: U3, label: "信義路 3F" }];
  const ok = html(<AssignFormView locale="zh-TW" name="阿明" units={units} checked={[U1, U3]} saving={false} failed={false} />);
  assert.match(ok, /勾選要分派給阿明的單位。/);
  assert.equal((ok.match(/type="checkbox"/g) ?? []).length, 3);
  assert.equal((ok.match(/checked=""/g) ?? []).length, 2);
  assert.equal((ok.match(/btn pri/g) ?? []).length, 1);
  assert.match(ok, /data-testid="assign-fail"><\/p>/);
  const failed = html(<AssignFormView locale="zh-TW" name="阿明" units={units} checked={[U1, U3]} saving={false} failed />);
  assert.match(failed, /沒有存成功，請再試一次。/);
  assert.equal((failed.match(/checked=""/g) ?? []).length, 2);
  assert.deepEqual(toggleUnit(units, [U3, U1], U2), [U1, U2, U3]);
  assert.deepEqual(toggleUnit(units, [U1, U2], U1), [U2]);
  const none = html(<AssignNoUnits locale="zh-TW" name="林志豪" />);
  assert.match(none, /負責的單位・林志豪/); assert.match(none, /建好單位後，才能分派給林志豪。/);
  assert.match(none, /還沒有單位/); assert.match(none, /href="\/m\/units\/new"[^>]*>建立單位</);
  assert.doesNotMatch(none, /儲存/);
});

test("GS-24: the 團隊 row shows 「負責的單位」 only when the section passes a link", () => {
  const row: TeamRowV3 = { key: P1, memberId: P1, invitationId: null, name: "阿明", contact: null, role: "maintenance", status: "active", inviteLive: false, self: false, lastAdmin: false };
  const actions = { primary: null, more: [] };
  const on = html(<TeamRowActionsCell locale="zh-TW" row={row} actions={actions} assignHref={assignEditHref(P1)} />);
  assert.match(on, /<a class="btn txt"[^>]*href="\/m\/assign\/[^"]+"[^>]*>負責的單位</);
  assert.doesNotMatch(html(<TeamRowActionsCell locale="zh-TW" row={row} actions={actions} />), /負責的單位/);
  const section = readFileSync(new URL("../components/v3/m/settings/team-page.tsx", import.meta.url), "utf8");
  assert.match(section, /assign && row\.role === "maintenance" && row\.status !== "disabled"/);
});

test("GS-46 nav: 「單位分派」 under 設定 for admin and manager only while maint_unit_assign is on", () => {
  const links = (s: Session, on: boolean) => areasFor(s, { maintAssign: on }).find(a => a.id === "settings")?.links.map(l => l.href) ?? [];
  for (const role of ["admin", "manager"] as const) {
    assert.ok(links(staff(role), true).includes("/m/assign"), role);
    assert.ok(!links(staff(role), false).includes("/m/assign"), role);
    assert.ok(!(areasFor(staff(role)).find(a => a.id === "settings")?.links ?? []).some(l => l.href === "/m/assign"), `${role} default`);
    // The area's own landing (first link) never moves to 單位分派.
    assert.equal(areasFor(staff(role), { maintAssign: true }).find(a => a.id === "settings")?.href,
      areasFor(staff(role)).find(a => a.id === "settings")?.href, role);
    assert.deepEqual(tabsFor(staff(role), { maintAssign: true }).map(t => t.id), tabsFor(staff(role)).map(t => t.id));
  }
  for (const role of ["accountant", "maintenance"] as const) assert.ok(!links(staff(role), true).includes("/m/assign"), role);
  assert.equal(navLabel("assign.nav", "zh-TW"), "單位分派");
});

test("flag helper fails closed; authorizeAssign admits native admin/manager only", async () => {
  assert.equal(await maintUnitAssignEnabledForOrg(O, async () => true), true);
  assert.equal(await maintUnitAssignEnabledForOrg(O, async () => false), false);
  assert.equal(await maintUnitAssignEnabledForOrg(O, async () => { throw new Error("down"); }), false);
  assert.equal(await maintUnitAssignEnabledForOrg(null, async () => true), false);
  assert.ok(await authorizeAssign(staff("admin")));
  assert.ok(await authorizeAssign(staff("manager")));
  assert.equal(await authorizeAssign(staff("accountant")), null);
  assert.equal(await authorizeAssign(staff("maintenance")), null);
  assert.equal(await authorizeAssign({ ...staff(null), kind: "owner" }), null);
});

test("body parser: exactly { requestId, target, units }, uuids, no duplicates, at most 2000", () => {
  assert.deepEqual(parseAssignBody({ requestId: R, target: P1, units: [U1, U2] }), { requestId: R, target: P1, units: [U1, U2] });
  assert.deepEqual(parseAssignBody({ requestId: R, target: P1, units: [] }), { requestId: R, target: P1, units: [] });
  for (const bad of [null, [], {}, { requestId: R, target: P1 }, { requestId: R, target: P1, units: [U1], extra: 1 }, { requestId: "x", target: P1, units: [] },
    { requestId: R, target: P1, units: [U1, U1] }, { requestId: R, target: P1, units: ["x"] }, { requestId: R, target: P1, units: U1 },
    { requestId: R, target: P1, units: Array.from({ length: 2001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }])
    assert.equal(parseAssignBody(bad), null, JSON.stringify(bad)?.slice(0, 80));
});

test("strict parsers: a malformed gateway answer is an error, never a guessed list", () => {
  assert.equal(parseAssignList(null), null);
  assert.deepEqual(parseAssignList({ people: [{ id: P1, kind: "member", name: "阿明", units: 2 }] }), [{ id: P1, kind: "member", name: "阿明", units: 2 }]);
  for (const bad of [{}, { people: [{ id: "x", kind: "member", name: "", units: 0 }] }, { people: [{ id: P1, kind: "manager", name: "", units: 0 }] },
    { people: [{ id: P1, kind: "member", name: "", units: -1 }] }]) assert.throws(() => parseAssignList(bad));
  assert.equal(parseAssignEdit(null), null);
  assert.deepEqual(parseAssignEdit({ person: { id: P1, kind: "invite", name: "a" }, units: [{ id: U1, property: "p", label: "1F", checked: true }] }),
    { person: { id: P1, kind: "invite", name: "a" }, units: [{ id: U1, property: "p", label: "1F", checked: true }] });
  for (const bad of [{ person: { id: P1, kind: "member", name: "a" } }, { person: { id: P1, kind: "member", name: "a" }, units: [{ id: U1, property: "p", label: "1F" }] }])
    assert.throws(() => parseAssignEdit(bad));
});

test("readers: forbidden roles never reach the database; OFF (NULL) is off; a failure is unavailable", async () => {
  const seen: string[] = [];
  assert.deepEqual(await assignList(staff("accountant"), { transaction: fakeTx(null, seen) }), { state: "forbidden" });
  assert.deepEqual(await assignEdit(staff("maintenance"), P1, { transaction: fakeTx(null, seen) }), { state: "forbidden" });
  assert.deepEqual(seen, []);
  assert.deepEqual(await assignList(staff("admin"), { transaction: fakeTx(null) }), { state: "off" });
  assert.deepEqual(await assignList(staff("admin"), { transaction: fakeTx({ people: [] }) }), { state: "ready", people: [] });
  assert.deepEqual(await assignEdit(staff("admin"), "not-a-uuid", { transaction: fakeTx(null, seen) }), { state: "forbidden" });
  assert.deepEqual(seen, []);
  const denied = Object.assign(new Error("denied"), { code: "42501" });
  assert.deepEqual(await assignEdit(staff("manager"), P1, { transaction: fakeTx(denied) }), { state: "forbidden" });
  assert.deepEqual(await assignList(staff("manager"), { transaction: fakeTx(new Error("timeout")) }), { state: "unavailable" });
  assert.deepEqual(await assignList(staff("manager"), { transaction: fakeTx({ people: "x" }) }), { state: "unavailable" });
});

test("saveAssign maps gateway statuses to HTTP: saved/unchanged 200, invalid 400, 42501 403, disabled 404, conflict 409, else 500; bad body never reaches SQL", async () => {
  const body = { requestId: R, target: P1, units: [U1] };
  const seen: string[] = [];
  assert.deepEqual(await saveAssign(staff("admin"), { ...body, units: [U1, U1] }, { transaction: fakeTx(null, seen) }), { ok: false, status: 400 });
  assert.deepEqual(seen, []);
  assert.deepEqual(await saveAssign(staff("admin"), body, { transaction: fakeTx({ status: "saved", units: 1, replayed: false }) }),
    { ok: true, status: "saved", units: 1, replayed: false });
  assert.deepEqual(await saveAssign(staff("admin"), body, { transaction: fakeTx({ status: "unchanged", units: 1, replayed: true }) }),
    { ok: true, status: "unchanged", units: 1, replayed: true });
  assert.deepEqual(await saveAssign(staff("admin"), body, { transaction: fakeTx({ status: "invalid", replayed: false }) }), { ok: false, status: 400 });
  assert.deepEqual(await saveAssign(staff("admin"), body, { transaction: fakeTx({ status: "disabled" }) }), { ok: false, status: 404 });
  assert.deepEqual(await saveAssign(staff("admin"), body, { transaction: fakeTx({ status: "conflict" }) }), { ok: false, status: 409 });
  assert.deepEqual(await saveAssign(staff("admin"), body, { transaction: fakeTx(Object.assign(new Error("x"), { code: "42501" })) }), { ok: false, status: 403 });
  assert.deepEqual(await saveAssign(staff("admin"), body, { transaction: fakeTx({ status: "saved" }) }), { ok: false, status: 500 });
  assert.deepEqual(await saveAssign(staff("admin"), body, { transaction: fakeTx(new Error("down")) }), { ok: false, status: 500 });
});

test("touch targets and tokens: every control is at least 44px; the CSS is scoped and uses tokens only", () => {
  const css = readFileSync(new URL("../../public/brand/v3/assign.css", import.meta.url), "utf8");
  assert.match(css, /\.v3-assign \.btn \{[^}]*min-height:44px; min-width:44px;/);
  assert.match(css, /\.v3-assign-check \{[^}]*min-height:44px;/);
  assert.match(css, /\.v3-assign-row \{[^}]*min-height:44px;/);
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").filter(r => r.includes("{") && !r.includes("@keyframes") && !/^\s*(50%|@media)/.test(r.trim()));
  for (const rule of rules) {
    const selector = rule.split("{")[0].trim();
    if (selector.startsWith("@media") || selector.startsWith("50%")) continue;
    assert.match(selector, /^html\[data-brand="v2"\]\[data-brand-v3\] \.v3-assign/, selector);
  }
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-f]{3,6}\b|rgb\(/i);
});

/** A submit whose answer the test decides later. */
function deferredSubmit() {
  const calls: { input: AssignSubmitInput; resolve: (ok: boolean) => void; reject: (error: Error) => void }[] = [];
  const submit = (input: AssignSubmitInput) => new Promise<boolean>((resolve, reject) => { calls.push({ input, resolve, reject }); });
  return { calls, submit };
}

test("AC8 save lifecycle (controller the form runs): failure keeps checks; unchanged retry reuses the id; a change gets a new id", async () => {
  const { calls, submit } = deferredSubmit();
  let done = 0, ids = 0;
  const c = createAssignFormController({ unitIds: [U1, U2, U3], checked: [U3], target: P1, submit, done: () => { done++; }, newId: () => `id-${++ids}` });
  assert.deepEqual(c.state().checked, [U3]);
  assert.equal(c.toggle(U1), true);
  const first = c.save();
  assert.equal(c.state().saving, true);
  assert.deepEqual(calls[0].input, { requestId: "id-1", target: P1, units: [U1, U3] });
  calls[0].resolve(false);
  assert.equal(await first, "failed");
  assert.deepEqual(c.state(), { checked: [U1, U3], saving: false, failed: true });
  // Unchanged retry: the same request id (the gateway replays it).
  const retry = c.save();
  assert.equal(calls[1].input.requestId, "id-1");
  calls[1].reject(new Error("network"));
  assert.equal(await retry, "failed");
  assert.deepEqual(c.state().checked, [U1, U3]);
  // A change after the failure gets a new id.
  c.toggle(U2);
  const changed = c.save();
  assert.deepEqual(calls[2].input, { requestId: "id-2", target: P1, units: [U1, U2, U3] });
  calls[2].resolve(true);
  assert.equal(await changed, "saved");
  assert.equal(done, 1);
  assert.equal(c.requestId(), "");
});

test("AC8 save lifecycle: while a save is pending the checks are frozen and a second save is refused, so no edit is silently dropped", async () => {
  const { calls, submit } = deferredSubmit();
  let done = 0;
  const c = createAssignFormController({ unitIds: [U1, U2], checked: [], target: P1, submit, done: () => { done++; }, newId: () => "only" });
  c.toggle(U1);
  const pending = c.save();
  assert.equal(c.toggle(U2), false, "toggle refused while saving");
  assert.deepEqual(c.state().checked, [U1]);
  assert.equal(await c.save(), "busy");
  assert.equal(calls.length, 1);
  calls[0].resolve(true);
  assert.equal(await pending, "saved");
  assert.deepEqual(calls[0].input.units, c.state().checked, "what was saved is exactly what is shown");
  assert.equal(done, 1);
  // The view disables the whole fieldset (every checkbox) while saving.
  const saving = html(<AssignFormView locale="zh-TW" name="阿明" units={[{ id: U1, label: "1F" }, { id: U2, label: "2F" }]} checked={[U1]} saving failed={false} />);
  assert.match(saving, /<fieldset class="v3-assign-units" disabled="" aria-disabled="true">/);
  assert.match(saving, /<form[^>]*aria-busy="true"/);
  assert.match(saving, /aria-disabled="true" data-testid="assign-save"/);
});

// Mounted: the real AssignForm in a local headless browser (React event handling, real fieldset disabling). Every
// request is local; next/navigation is a stub that records router.push. Skips (explicitly) when no browser exists,
// like vendor-document-ui.test.tsx.
test("AssignForm mounted: deferred save — pending edits blocked, failure keeps checks and id, change gets a new id, success navigates once", { timeout: 120000 }, async t => {
  const { build } = await import("esbuild");
  const { chromium } = await import("@playwright/test");
  const { existsSync } = await import("node:fs");
  const system = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = existsSync(chromium.executablePath()) ? undefined : existsSync(system) ? system : null;
  if (executablePath === null) { t.skip("No local Chromium or Chrome for the mounted form test"); return; }
  const bundle = await build({
    stdin: { contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { AssignForm } from "./src/components/v3/m/settings/assign-form";
      window.pushed = []; window.calls = [];
      window.submit = input => new Promise(resolve => window.calls.push({ input, resolve }));
      window.mount = () => createRoot(document.getElementById("root")).render(
        <AssignForm locale="zh-TW" target="${P1}" name="阿明" doneHref="/m/assign" checked={["${U3}"]}
          units={[{ id: "${U1}", label: "1F" }, { id: "${U2}", label: "2F" }, { id: "${U3}", label: "3F" }]}
          submit={input => window.submit(input)} />);
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "next-navigation-stub", setup(b) {
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-navigation", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const useRouter = () => ({ push: h => window.pushed.push(h), refresh: () => {} });", loader: "js" }));
    } }],
  });
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", route => route.request().url() === "http://127.0.0.1/"
    ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }) : route.abort());
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => (window as unknown as { mount: () => void }).mount());
  const box = (i: number) => page.locator('[data-testid="assign-unit"]').nth(i);
  const state = () => page.evaluate(() => {
    const w = window as unknown as { calls: { input: AssignSubmitInput }[]; pushed: string[] };
    return { calls: w.calls.map(c => c.input), pushed: [...w.pushed],
      checked: [...document.querySelectorAll<HTMLInputElement>('[data-testid="assign-unit"]')].map(i => i.checked),
      disabled: document.querySelector("fieldset")!.disabled, fail: document.querySelector('[data-testid="assign-fail"]')!.textContent };
  });
  const answer = (ok: boolean) => page.evaluate(v => { const w = window as unknown as { calls: { resolve: (v: boolean) => void }[] }; w.calls.at(-1)!.resolve(v); }, ok);
  await box(0).check();
  await page.click('[data-testid="assign-save"]');
  let s = await state();
  assert.equal(s.calls.length, 1); assert.deepEqual(s.calls[0].units, [U1, U3]); assert.equal(s.disabled, true);
  // A pending save: the boxes are disabled; a click changes nothing and a second 儲存 sends nothing.
  await box(1).click({ force: true });
  await page.click('[data-testid="assign-save"]', { force: true });
  s = await state();
  assert.deepEqual(s.checked, [true, false, true]); assert.equal(s.calls.length, 1);
  await answer(false);
  await page.waitForFunction(() => !document.querySelector("fieldset")!.disabled);
  s = await state();
  assert.deepEqual(s.checked, [true, false, true]); assert.equal(s.fail, "沒有存成功，請再試一次。"); assert.deepEqual(s.pushed, []);
  // Unchanged retry: same request id.
  await page.click('[data-testid="assign-save"]');
  s = await state();
  assert.equal(s.calls.length, 2); assert.equal(s.calls[1].requestId, s.calls[0].requestId);
  await answer(false);
  await page.waitForFunction(() => !document.querySelector("fieldset")!.disabled);
  // A change gets a new id; success navigates back to 單位分派 exactly once.
  await box(1).check();
  await page.click('[data-testid="assign-save"]');
  s = await state();
  assert.equal(s.calls.length, 3); assert.notEqual(s.calls[2].requestId, s.calls[0].requestId); assert.deepEqual(s.calls[2].units, [U1, U2, U3]);
  await answer(true);
  await page.waitForFunction(() => (window as unknown as { pushed: string[] }).pushed.length > 0);
  assert.deepEqual((await state()).pushed, ["/m/assign"]);
});
