import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerenderToNodeStream } from "react-dom/static";
import ts from "typescript";
import { brandV3TenantLeaseRepairCopy } from "../i18n/lanes/brand-v3-tenant-lease-repair";
import * as repairComponents from "../components/v3/tenant/repair";
import * as leaseComponents from "../components/v3/tenant/lease";
import { TenantRepairError, TenantRepairListV3, TenantRepairLoading, TenantRepairProgressV3, repairLead } from "../components/v3/tenant/repair";
import { TenantLeaseError, TenantLeaseLoading, TenantLeaseV3 } from "../components/v3/tenant/lease";
import { tenantShellCurrent } from "../components/v3/tenant/shell";
import { homeRepairStep } from "./b090-tenant-home-rules";
import * as repairRules from "./repair-rules";
import { repairStage, repairSteps, tenantLeaseTerms, tenantLeaseView, tenantRepairView, type TenantRepairProgress } from "./b090-tenant-lease-repair";
import type { Session } from "./types";

// B-090 slice 3 re-land (PENDING-RON PR-043): RT-REPAIR (TEN-56-AC4/AC5, read part) and RT-LEASE (TEN-57-AC1, read part).
// Stories: hub 07-brand/brand-3.0-1113/stories.md TEN-56/TEN-57; screens RT-REPAIR, RT-LEASE (+ state rows); frames
// 「報修・進度（師傅想約時間）」 and 「更多・我的租約（快到期）」; wording PR-023, the five status sentences PR-042.
// The brand_v3 OFF pages are covered in b090-flag-off-sql-parity.test.ts and b073-flag-off-endpoints.test.tsx.

const requireHere = createRequire(import.meta.url);
const source = (path: string) => readFileSync(path, "utf8");
function compile(text: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}
async function prerender(node: React.ReactNode) {
  const { prelude } = await prerenderToNodeStream(<>{node}</>);
  let out = "";
  for await (const chunk of prelude) out += chunk;
  return out.replace(/<!--\/?\$-->/g, "");
}
const quietly = async <T,>(fn: () => Promise<T>) => { const q = console.error; console.error = () => undefined; try { return await fn(); } finally { console.error = q; } };

const session = { userId: "u", orgId: "org", locale: "zh-TW", calendar: "gregorian", name: "陳怡君", kind: "tenant", leaseId: null } as unknown as Session;
const ID = { open: "11111111-1111-4111-8111-111111111111", assigned: "22222222-2222-4222-8222-222222222222", working: "33333333-3333-4333-8333-333333333333",
  closed: "44444444-4444-4444-8444-444444444444", cancelled: "55555555-5555-4555-8555-555555555555", other: "66666666-6666-4666-8666-666666666666" };
const row = (id: string, status: string, number: string, title: string) => ({ id, number, title, status, category: "plumbing", created_at: `2026-11-1${number}T00:00:00Z` });
const rows = [row(ID.open, "open", "1", "浴室天花板滴水"), row(ID.assigned, "assigned", "2", "冷氣不冷"), row(ID.working, "on_hold", "3", "門鎖"),
  row(ID.closed, "closed", "4", "燈泡"), row(ID.cancelled, "cancelled", "5", "取消的")];
const detail = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  ticket: { id, number: rows.find(r => r.id === id)?.number ?? "9", title: "浴室天花板滴水", description: "浴室天花板在滴水，越來越嚴重。", status, category: "plumbing", place: "信義路", property_id: "p",
    property_name: "信義路", currency: "TWD", property_currency: "TWD", vendor_name: "陳師傅水電", estimated_cost: "450000", final_cost: "480000", cost_bearer: "owner",
    scheduled_on: "2026-11-21", completed_on: status === "closed" ? "2026-11-16" : null, expense_id: null, expense_status: null, ...over },
  comments: [{ id: "c1", body: "收到", internal: false, status_from: null, status_to: "open", at: "2026-11-15T00:40:00Z", author: "安居物業" },
    { id: "c2", body: "內部：估價 4500", internal: true, status_from: null, status_to: null, at: "2026-11-15T01:00:00Z", author: "王經理" }],
  photos: [{ id: "f1", name: "天花板_1.jpg", path: "x", mime: "image/jpeg", internal: false }, { id: "f2", name: "內部.jpg", path: "y", mime: "image/jpeg", internal: true }],
  hiddenPhotoCount: 0,
});
const statusOf = (id: string) => rows.find(r => r.id === id)?.status ?? "open";
const deps = (over: { repairs?: unknown; detail?: unknown } = {}) => ({
  repairs: (async () => over.repairs ?? rows) as never,
  detail: (async (_s: Session, id: string) => over.detail !== undefined ? over.detail : detail(id, statusOf(id))) as never,
  recovery: (async () => null) as never,
});
const progress = (status: string, over: Partial<TenantRepairProgress> = {}): TenantRepairProgress => {
  const stage = repairStage(status)!;
  return { id: ID.open, number: "1", title: "浴室天花板滴水", description: "浴室天花板在滴水，越來越嚴重。", category: "plumbing", status, stage,
    steps: repairSteps(stage, status === "closed" ? "2026-11-16" : null), ...over };
};
const progressHtml = (p: TenantRepairProgress, locale: "zh-TW" | "en" = "zh-TW") => renderToStaticMarkup(<TenantRepairProgressV3 repair={p} locale={locale} calendar="gregorian"
  company="安居物業" notices={<i data-n="notices" />} category={{ label: "問題類型", value: "水電" }} cancel={<i data-n="cancel" />} thread={<i data-n="thread" />} />);
/** Controls whose data (B-088 / B-089 / TEN-49) does not exist yet: never rendered on these pages. */
const OMITTED = /師傅想|可以嗎|>可以<|換個時間|取消授權進入|授權進入|師傅來的時候|約時間|約好時間|要續約|不續約|還沒決定|續約|你的回答會直接告訴|搬出|押金轉|保管/;

// ---------- RT-REPAIR rules and view ----------

test("TEN-56-AC4: every ticket status maps to one stage (open three = RT-HOME's steps); unknown statuses are not guessed", () => {
  const map: Record<string, string | null> = { open: "reported", triaged: "reported", assigned: "dispatched", in_progress: "working", on_hold: "working",
    resolved: "done", closed: "done", cancelled: "cancelled", vendor_proposed: null, "": null };
  for (const [status, stage] of Object.entries(map)) assert.equal(repairStage(status), stage, status);
  for (const status of ["open", "triaged", "assigned", "in_progress", "on_hold"]) assert.equal(repairStage(status), homeRepairStep(status), `${status}: same as the 首頁 card`);
});

test("TEN-56-AC4/AC5: steps 已回報 → 已派工 → 處理中 → 已完成 per stage (約好時間 waits for B-088); the date only on 已完成", () => {
  const shape = (stage: Parameters<typeof repairSteps>[0], on: string | null = null) => repairSteps(stage, on).map(s => `${s.id}:${s.state}${s.current ? "*" : ""}${s.date ? `@${s.date}` : ""}`);
  assert.deepEqual(shape("reported"), ["reported:now*", "dispatched:todo", "working:todo", "done:todo"]);
  assert.deepEqual(shape("dispatched"), ["reported:done", "dispatched:now*", "working:todo", "done:todo"]);
  assert.deepEqual(shape("working", "2026-11-16"), ["reported:done", "dispatched:done", "working:now*", "done:todo"], "a date on an unfinished repair is ignored");
  assert.deepEqual(shape("done", "2026-11-16"), ["reported:done", "dispatched:done", "working:done", "done:done*@2026-11-16"]);
  assert.deepEqual(shape("done", null), ["reported:done", "dispatched:done", "working:done", "done:done*"]);
  assert.deepEqual(shape("done", "16 Nov"), ["reported:done", "dispatched:done", "working:done", "done:done*"], "a malformed date is not shown");
  assert.deepEqual(repairSteps("cancelled", null), []);
});

test("TEN-56-AC4: the view opens only the tenant's own repair, drops internal lines and never carries costs or the vendor", async () => {
  const list = await tenantRepairView(session, "lease", undefined, deps());
  assert.equal(list.state, "list");
  assert.deepEqual(list.state === "list" && list.repairs.map(r => [r.number, r.stage]), [["1", "reported"], ["2", "dispatched"], ["3", "working"], ["4", "done"], ["5", "cancelled"]]);
  let detailReads = 0;
  const counting = { ...deps(), detail: (async (_s: Session, id: string) => { detailReads++; return detail(id, statusOf(id)); }) as never };
  // another lease's repair, a malformed id: the list, and the detail reader is not even called
  for (const id of [ID.other, "not-a-uuid", "", "1 OR 1=1"]) assert.equal((await tenantRepairView(session, "lease", id, counting)).state, "list", id);
  assert.equal(detailReads, 0);
  // the detail reader answering for a different id than asked (or nothing): still the list
  assert.equal((await tenantRepairView(session, "lease", ID.open, deps({ detail: detail(ID.other, "open") }))).state, "list");
  assert.equal((await tenantRepairView(session, "lease", ID.open, deps({ detail: null }))).state, "list");
  const view = await tenantRepairView(session, "lease", ID.closed, deps());
  assert.equal(view.state, "progress");
  if (view.state !== "progress") return;
  assert.equal(view.repair.stage, "done");
  assert.deepEqual(view.repair.steps.at(-1), { id: "done", state: "done", current: true, date: "2026-11-16" });
  assert.deepEqual(view.comments.map(c => c.id), ["c1"], "internal notes never reach the tenant view");
  assert.deepEqual(view.photos.map(p => p.id), ["f1"]);
  const json = JSON.stringify(view);
  for (const leak of ["450000", "480000", "陳師傅水電", "內部", "王經理", "owner", "2026-11-21"]) assert.ok(!json.includes(leak), leak);
});

test("G-ERR: a failing reader or an unknown status gives the error state, never a guessed one", async () => {
  await quietly(async () => {
    assert.deepEqual(await tenantRepairView(session, "lease", undefined, deps({ repairs: Promise.reject(new Error("db")) })), { state: "error" });
    const boom = { ...deps(), detail: (async () => { throw new Error("db"); }) as never };
    assert.deepEqual(await tenantRepairView(session, "lease", ID.open, boom), { state: "error" });
    assert.deepEqual(await tenantRepairView(session, "lease", ID.open, deps({ detail: detail(ID.open, "weird") })), { state: "error" });
  });
});

test("TEN-56-AC4 (PR-042): the progress lead says whose turn / what is next, per stage (verbatim zh-TW)", () => {
  const lead = (status: string) => repairLead(repairStage(status)!, "zh-TW", "安居物業");
  assert.equal(lead("open"), "已回報，等安居物業派師傅。");
  assert.equal(lead("triaged"), "已回報，等安居物業派師傅。");
  assert.equal(lead("assigned"), "安居物業已經派師傅。");
  assert.equal(lead("in_progress"), "師傅處理中。");
  assert.equal(lead("on_hold"), "師傅處理中。");
  assert.equal(lead("resolved"), "這件報修已經完成。");
  assert.equal(lead("closed"), "這件報修已經完成。");
  assert.equal(lead("cancelled"), "這件報修已取消。");
  assert.equal(repairLead("dispatched", "en", "Anju"), "Anju has sent a technician.");
});

test("TEN-56-AC4/AC5: progress page per status — steps, 你送出的內容, 有問題傳訊息; 新增報修 only once it has ended; omitted controls absent", () => {
  for (const status of ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"]) {
    const out = progressHtml(progress(status));
    const stage = repairStage(status)!;
    assert.match(out, new RegExp(`data-stage="${stage}"`));
    assert.match(out, new RegExp(`<h1 class="t-rp-lead" data-testid="tenant-repair-lead">${repairLead(stage, "zh-TW", "安居物業")}</h1>`), status);
    assert.match(out, /<h2>你送出的內容<\/h2><p>浴室天花板在滴水，越來越嚴重。<\/p><p class="t-rp-kv"><span>問題類型<\/span><b>水電<\/b><\/p>/);
    assert.match(out, /<a class="t-rp-text" data-testid="tenant-repair-message" href="\/t\/messages">有問題傳訊息<\/a>/);
    const ended = stage === "done" || stage === "cancelled";
    assert.equal(/data-testid="tenant-repair-new" href="\/t\/repair#new-repair">新增報修</.test(out), ended, status);
    assert.match(out, /<i data-n="notices"><\/i>.*<i data-n="cancel"><\/i>.*<i data-n="thread"><\/i>/);
    assert.doesNotMatch(out, OMITTED, status);
    assert.doesNotMatch(out, /NT\$|收款|入帳|btn pri|陳師傅/, status);
    if (stage === "cancelled") { assert.doesNotMatch(out, /t-rp-steps/); assert.match(out, /<span class="t-rp-badge">已取消<\/span>/); continue; }
    // list-style:none drops list semantics in some screen readers: the steps keep an explicit list role.
    assert.match(out, /<ol class="t-rp-steps" role="list" data-testid="tenant-repair-steps">/, status);
    const steps = [...out.matchAll(/<li class="(done|now|todo)"( aria-current="step")?><i aria-hidden="true"><\/i>([^<]+)<\/li>/g)].map(m => `${m[3]}:${m[1]}${m[2] ? "*" : ""}`);
    const expected: Record<string, string[]> = {
      reported: ["已回報:now*", "已派工:todo", "處理中:todo", "已完成:todo"],
      dispatched: ["已回報:done", "已派工:now*", "處理中:todo", "已完成:todo"],
      working: ["已回報:done", "已派工:done", "處理中:now*", "已完成:todo"],
      done: ["已回報:done", "已派工:done", "處理中:done", status === "closed" ? "已完成・2026年11月16日:done*" : "已完成:done*"],
    };
    assert.deepEqual(steps, expected[stage], status);
  }
  const en = progressHtml(progress("closed"), "en");
  assert.match(en, />Done · Nov 16, 2026<\/li>/);
  assert.match(en, />What you sent<\/h2>/);
  assert.doesNotMatch(progressHtml(progress("open", { description: null })), /<h2>你送出的內容<\/h2><p>/, "no description: no empty paragraph");
});

test("RT-REPAIR list: the RT-HOME card per repair (報修・{title}, step badge, 看進度); empty state is drawing 08 with today's words", () => {
  const repairs = rows.map(r => ({ id: r.id, number: r.number, title: r.title, category: r.category, stage: repairStage(r.status) }));
  const out = renderToStaticMarkup(<TenantRepairListV3 repairs={repairs} locale="zh-TW" notices={null} empty={{ title: "還沒有報修紀錄", hint: "hint" }} newForm={<form data-n="form" />} />);
  assert.match(out, /^<section class="v3-tenant-repair" data-testid="tenant-repair-v3" data-view="list"><h1 class="t-rp-lead">報修<\/h1>/);
  const cards = [...out.matchAll(/<h2>([^<]+)<\/h2><span class="t-rp-badge" data-testid="tenant-repair-status-\d">([^<]+)<\/span><\/div><a class="t-rp-text" href="([^"]+)">看進度<\/a>/g)].map(m => [m[1], m[2], m[3]]);
  assert.deepEqual(cards, [["報修・浴室天花板滴水", "已回報", `/t/repair?id=${ID.open}`], ["報修・冷氣不冷", "已派工", `/t/repair?id=${ID.assigned}`],
    ["報修・門鎖", "處理中", `/t/repair?id=${ID.working}`], ["報修・燈泡", "已完成", `/t/repair?id=${ID.closed}`], ["報修・取消的", "已取消", `/t/repair?id=${ID.cancelled}`]]);
  assert.match(out, /<div class="t-rp-card t-rp-form" id="new-repair"><form data-n="form"><\/form><\/div><\/section>$/, "today's 新增報修 form stays");
  assert.doesNotMatch(out, OMITTED);
  assert.doesNotMatch(out, /repair-tenant-empty/);
  const empty = renderToStaticMarkup(<TenantRepairListV3 repairs={[]} locale="zh-TW" notices={null} empty={{ title: "還沒有報修紀錄", hint: "家裡有東西壞了" }} newForm={null} />);
  assert.match(empty, /data-testid="repair-tenant-empty"><svg class="v3-illustration" data-v3-illustration="08"/);
  assert.match(empty, /<p><b>還沒有報修紀錄<\/b><\/p><p class="t-rp-muted">家裡有東西壞了<\/p>/);
  const unknown = renderToStaticMarkup(<TenantRepairListV3 repairs={[{ ...repairs[0], stage: null }]} locale="zh-TW" notices={null} empty={{ title: "", hint: "" }} newForm={null} />);
  assert.doesNotMatch(unknown, /t-rp-badge/, "no badge rather than a guessed one");
});

test("G-LOAD / G-ERR: skeletons carry no status, count or amount; errors show the approved pair with 「再試一次」", () => {
  for (const out of [renderToStaticMarkup(<TenantRepairLoading />), renderToStaticMarkup(<TenantLeaseLoading />)]) {
    assert.match(out, /aria-busy="true"/);
    assert.equal(out.replace(/<[^>]+>/g, ""), "", "no text at all while loading");
  }
  assert.equal(renderToStaticMarkup(<TenantRepairError locale="zh-TW" retryHref={`/t/repair?id=${ID.open}`} />),
    `<section class="v3-tenant-repair" data-testid="tenant-repair-error"><h1 class="t-rp-lead">報修</h1><div class="t-rp-card" role="alert"><p>這裡暫時讀不到，請再試一次。</p><a class="t-rp-outline" href="/t/repair?id=${ID.open}">再試一次</a></div></section>`);
  assert.equal(renderToStaticMarkup(<TenantLeaseError locale="zh-TW" />),
    '<section class="v3-tenant-lease" data-testid="tenant-lease-error"><h1 class="t-ls-lead">我的租約</h1><div class="t-ls-card" role="alert"><p>這裡暫時讀不到，請再試一次。</p><a class="t-ls-outline" href="/t/lease">再試一次</a></div></section>');
});

// ---------- RT-LEASE rules and view ----------

const money = (over: Record<string, unknown> = {}) => ({ currency: "TWD", lease: { place: "信義路四段 120 號 2 樓", start_date: "2026-05-01", end_date: "2027-04-30",
  rent: "1850000", deposit: "3700000", due_day: 5, ...over } }) as Parameters<typeof tenantLeaseTerms>[0];
const leaseMoney = { id: "lease-a", currency: "TWD", rent: "1850000", deposit: "3700000", due_day: 5, start_date: "2026-05-01", end_date: "2027-04-30", status: "active",
  place: "信義路四段 120 號 2 樓", firm: "安居物業", first_period_basis: null };
const fullMoney = { currency: "TWD", lease: leaseMoney } as never;
const signed = [{ id: "pdf1", current: true, created_at: "2026-05-01T00:00:00Z" }, { id: "pdf0", current: false, created_at: "2026-04-01T00:00:00Z" }];

test("TEN-57-AC1: 我的租約 terms 物件／租期／租金／繳租日／押金 from the existing lease reader, read-only; renewal and deposit card absent", () => {
  assert.deepEqual(tenantLeaseTerms(money()), { place: "信義路四段 120 號 2 樓", start: "2026-05-01", end: "2027-04-30", rentMinor: 1_850_000, depositMinor: 3_700_000, currency: "TWD", dueDay: 5 });
  for (const bad of [0, 32, 2.5, null, Number.NaN]) assert.equal(tenantLeaseTerms(money({ due_day: bad })).dueDay, null, String(bad));
  const html = (terms = tenantLeaseTerms(money()), locale: "zh-TW" | "en" = "zh-TW") => renderToStaticMarkup(<TenantLeaseV3 terms={terms} locale={locale} calendar="gregorian"
    place="«信義路四段 120 號 2 樓»" before={<i data-n="before" />} after={<i data-n="after" />} />);
  const out = html();
  assert.match(out, /^<section class="v3-tenant-lease" data-testid="tenant-lease-v3"><h1 class="t-ls-lead">我的租約<\/h1><i data-n="before"><\/i><div class="t-ls-card" data-testid="tenant-lease-terms">/);
  const kv = [...out.matchAll(/<p class="t-ls-kv"[^>]*><span>([^<]+)<\/span><b[^>]*>([^<]+)<\/b><\/p>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(kv, [["物件", "«信義路四段 120 號 2 樓»"], ["租期", "2026年5月1日～2027年4月30日"], ["租金", "NT$18,500／月"], ["繳租日", "每月 5 日"], ["押金", "NT$37,000"]]);
  assert.match(out, /data-testid="tenant-lease-rent" data-minor="1850000"/);
  assert.match(out, /<\/div><i data-n="after"><\/i><\/section>$/);
  assert.doesNotMatch(out, OMITTED);
  assert.doesNotMatch(out, /btn pri|<button|<form|<input|收款|入帳/, "no button, form or field on the terms");
  assert.doesNotMatch(html(tenantLeaseTerms(money({ due_day: null }))), /繳租日/, "no due day rather than a wrong one");
  const roc = renderToStaticMarkup(<TenantLeaseV3 terms={tenantLeaseTerms(money())} locale="zh-TW" calendar="roc" place="x" before={null} after={null} />);
  assert.match(roc, /<span>租期<\/span><b>民國 115 年 5 月 1 日～民國 116 年 4 月 30 日<\/b>/, "the tenant's calendar setting is respected");
  assert.match(html(undefined, "en"), /<span>Rent<\/span><b class="t-ls-num">NT\$18,500 \/ month<\/b>.*<span>Rent due<\/span><b>Day 5 of each month<\/b>/);
});

test("TEN-57-AC1: the lease view makes the existing page's four reads with its arguments; empty and error states", async () => {
  const calls: unknown[][] = [];
  const rec = <V,>(name: string, value: V | (() => V)) => (async (...args: unknown[]) => { calls.push([name, ...args]); return typeof value === "function" ? (value as () => V)() : value; }) as never;
  const leaseDeps = (over: Record<string, unknown> = {}) => ({ money: rec("money", fullMoney), idCheck: rec("id_check", { ready: false }), signed: rec("signed", signed),
    idRequired: rec("id_required", true), ...over });
  const view = await tenantLeaseView(session, "lease-a", leaseDeps());
  assert.deepEqual(calls, [["money", session, "lease-a"], ["id_check", session, "lease-a"], ["signed", session, "lease-a"], ["id_required", session]]);
  assert.equal(view.state, "ready");
  assert.ok(view.state === "ready" && view.idGate && view.signedPdfs.length === 2 && view.terms.dueDay === 5);
  assert.equal((await tenantLeaseView(session, "lease-a", leaseDeps({ idCheck: rec("id_check", { ready: true }) }))).state === "ready", true);
  const ready = await tenantLeaseView(session, "lease-a", leaseDeps({ idCheck: rec("id_check", null) }));
  assert.ok(ready.state === "ready" && !ready.idGate, "no ID check row: no gate");
  const notRequired = await tenantLeaseView(session, "lease-a", leaseDeps({ idRequired: rec("id_required", false) }));
  assert.ok(notRequired.state === "ready" && !notRequired.idGate);
  assert.deepEqual(await tenantLeaseView(session, "lease-a", leaseDeps({ money: rec("money", null) })), { state: "empty" });
  await quietly(async () => {
    for (const key of ["money", "idCheck", "signed", "idRequired"]) {
      assert.deepEqual(await tenantLeaseView(session, "lease-a", leaseDeps({ [key]: (async () => { throw new Error("db"); }) as never })), { state: "error" }, key);
    }
  });
});

test("TEN-55-AC1: aria-current is 報修 on the list and every progress page, 更多 (我的租約) on the lease page", () => {
  const more = [{ id: "lease", href: "/t/lease" }, { id: "history", href: "/t/history" }];
  for (const path of ["/t/repair", `/t/repair?id=${ID.open}`, `/t/repair?id=${ID.open}&cancel=1`, "/t/repair?done=1"]) assert.equal(tenantShellCurrent(path, more), "repair", path);
  for (const path of ["/t/lease", "/t/lease/"]) assert.equal(tenantShellCurrent(path, more), "lease", path);
});

test("Copy: the lane is complete in both locales, never says 收款 / 入帳 on the tenant side, and the slice-3 CSS is its own scoped tokens block", () => {
  const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => typeof v === "object" && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]);
  assert.deepEqual(keys(brandV3TenantLeaseRepairCopy("en")).sort(), keys(brandV3TenantLeaseRepairCopy("zh-TW")).sort());
  for (const file of ["src/i18n/lanes/brand-v3-tenant-lease-repair.ts", "src/components/v3/tenant/repair.tsx", "src/components/v3/tenant/lease.tsx",
    "src/components/v3/tenant/repair-route.tsx", "src/components/v3/tenant/lease-route.tsx", "src/server/b090-tenant-lease-repair.ts"]) assert.doesNotMatch(source(file), /收款|入帳|收租|代收/, file);
  const css = source("public/brand/v3/tenant.css");
  const start = css.indexOf("/* ===== B-090 slice 3");
  assert.ok(start > css.lastIndexOf(".v3-tenant-pay"), "the slice-3 block sits after every earlier rule");
  const block = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of block.split("}").map(r => r.trim()).filter(Boolean)) {
    const selectors = rule.replace(/^@media[^{]*\{/, "").split("{")[0].split(",").map(s => s.trim()).filter(Boolean);
    for (const s of selectors) assert.ok(/^html\[data-brand="v2"\]\[data-brand-v3\] \.v3-tenant-(repair|lease)\b/.test(s), s);
  }
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgb\(/i, "tokens only");
  assert.doesNotMatch(css.slice(0, start), /\.v3-tenant-(repair|lease)\b/, "nothing of slice 3 outside its block");
});

// ---------- the brand_v3 ON routes ----------
const link = { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> };
const tFn = () => (key: string, vars?: unknown) => vars ? `${key}:${JSON.stringify(vars)}` : key;
const actions = { ticket: "/ticket" as never, cancel: "/cancel" as never };
type RepairState = { repairs?: unknown[]; failRepairs?: boolean };
function repairRouteMocks(state: RepairState) {
  const readRepairs = async () => { if (state.failRepairs) throw new Error("db"); return state.repairs ?? rows; };
  const readDetail = async (_s: Session, id: string) => rows.some(r => r.id === id) || id === ID.other ? detail(id, statusOf(id)) : null;
  return {
    "next/link": link,
    "../../../i18n": { makeT: tFn },
    "../../../lib/repair-labels": { REPAIR_CAT_KEY: { plumbing: "i_cat_plumbing" } },
    "../../../server/b090-tenant-lease-repair": { tenantRepairView: (s: Session, l: string, id: string | undefined) => tenantRepairView(s, l, id,
      { repairs: readRepairs as never, detail: readDetail as never, recovery: (async () => null) as never }) },
    "../../../server/repair-rules": repairRules,
    "../../../server/types": {},
    "../../repair-thread": { RepairThread: (p: { ticketId: string; comments: { id: string }[]; photos: { id: string }[]; allowInternal: boolean; returnTo: string }) =>
      <i data-stub="thread" data-ticket={p.ticketId} data-comments={p.comments.map(c => c.id).join(",")} data-photos={p.photos.map(f => f.id).join(",")} data-internal={String(p.allowInternal)} data-return={p.returnTo} /> },
    "../../ui": { ErrorBanner: ({ error }: { error?: string }) => error ? <div data-stub="error-banner">{error}</div> : null },
    "./repair": repairComponents,
  };
}
const renderRepairRoute = async (params: Record<string, string>, state: RepairState = {}) => {
  const { TenantRepairV3Route } = compile(source("src/components/v3/tenant/repair-route.tsx"), repairRouteMocks(state)) as { TenantRepairV3Route: React.FC<Record<string, unknown>> };
  return prerender(<TenantRepairV3Route session={session} leaseId="lease-a" company="安居物業" params={params} actions={actions} />);
};

test("TEN-56 ON: /t/repair shows the list or the own repair's progress with today's form, cancel and thread; the error state on a failed read", async () => {
  const list = await renderRepairRoute({});
  assert.match(list, /data-view="list"/);
  assert.match(list, /id="new-repair"><form action="\/ticket"><input type="hidden" name="leaseId" value="lease-a"\/><h3>i_repair_new<\/h3>/);
  assert.ok(list.includes('<select class="inp" name="category" data-testid="repair-category"><option value="" selected="">i_choose</option><option value="plumbing">i_cat_plumbing</option>'
    + '<option value="electrical">i_cat_electrical</option><option value="appliance">i_cat_appliance</option><option value="hvac">i_cat_hvac</option><option value="other">i_cat_other</option></select>'
    + '</div><div class="fg"><label class="f">i_repair_short</label><input class="inp" data-testid="repair-title" placeholder="i_ph_title" name="title" value=""/></div>'
    + '<div class="fg"><label class="f">i_repair_detail_optional</label><textarea class="inp" name="description"></textarea></div>'
    + '<button class="btn pri block" type="submit" data-testid="submit-repair">i_submit_repair</button></form>'), "today's fields, names and options");
  assert.equal((list.match(/btn pri/g) ?? []).length, 1, "the only solid button is today's 送出報修");
  assert.match(await renderRepairRoute({}, { repairs: [] }), /data-testid="repair-tenant-empty"><svg class="v3-illustration" data-v3-illustration="08"[^>]*>.*?<\/svg><p><b>i_repair_tenant_empty<\/b><\/p><p class="t-rp-muted">i_repair_tenant_empty_hint<\/p>/);
  assert.match(await renderRepairRoute({ done: "1" }), /data-testid="repair-sent"><p>i_repair_success_hint<\/p>/);
  assert.match(await renderRepairRoute({ error: "errors.generic" }), /<div data-stub="error-banner">errors.generic<\/div>/);
  // another lease's repair or a malformed id: the list, never its detail
  for (const id of [ID.other, "nope"]) { const out = await renderRepairRoute({ id }); assert.match(out, /data-view="list"/); assert.doesNotMatch(out, /data-stub="thread"/); }
  const open = await renderRepairRoute({ id: ID.open });
  assert.match(open, /data-view="progress" data-stage="reported"><h1 class="t-rp-lead" data-testid="tenant-repair-lead">已回報，等安居物業派師傅。<\/h1>/);
  assert.match(open, /<a href="\/t\/repair\?id=[^"]+&amp;cancel=1" class="t-rp-text" data-testid="repair-cancel">i_repair_cancel<\/a>/);
  assert.match(open, new RegExp(`<i data-stub="thread" data-ticket="${ID.open}" data-comments="c1" data-photos="f1" data-internal="false" data-return="tenant"></i>`), "the thread gets no internal line");
  assert.match(open, /<span>i_repair_type<\/span><b>i_cat_plumbing<\/b>/);
  assert.doesNotMatch(open, /btn pri|id="new-repair"|i_repair_mine/);
  const confirming = await renderRepairRoute({ id: ID.open, cancel: "1" });
  assert.match(confirming, /data-testid="repair-cancel-dialog".*<form action="\/cancel"><input type="hidden" name="ticketId" value="11111111-1111-4111-8111-111111111111"\/>.*data-testid="repair-cancel-submit".*data-testid="repair-cancel-back"/);
  assert.doesNotMatch(confirming, /data-testid="repair-cancel"[ >]/);
  const assigned = await renderRepairRoute({ id: ID.assigned, cancel: "1" });
  assert.match(assigned, /安居物業已經派師傅。.*data-testid="repair-cancel-locked">i_repair_cancel_locked</);
  assert.doesNotMatch(assigned, /repair-cancel-dialog/, "cancel is only offered while the repair is open");
  const sent = await renderRepairRoute({ id: ID.open, done: "1" });
  assert.match(sent, /data-testid="repair-sent"><p>i_repair_success_title:\{&quot;number&quot;:&quot;1&quot;\}<\/p><p>i_repair_success_hint<\/p>/);
  const cancelled = await renderRepairRoute({ id: ID.cancelled, cancelled: "1" });
  assert.match(cancelled, /這件報修已取消。.*data-testid="repair-cancelled-toast">i_repair_cancelled_toast/);
  assert.match(cancelled, /data-testid="tenant-repair-new" href="\/t\/repair#new-repair">新增報修</);
  assert.doesNotMatch(cancelled, /repair-cancel-locked|data-testid="repair-cancel"/);
  assert.match(await renderRepairRoute({ id: ID.closed }), /這件報修已經完成。.*已完成・2026年11月16日/);
  for (const out of [list, open, confirming, assigned, cancelled]) { assert.doesNotMatch(out, OMITTED); assert.doesNotMatch(out, /陳師傅|450000|480000|內部|王經理|收款|入帳/); }
  await quietly(async () => {
    assert.match(await renderRepairRoute({ id: ID.open }, { failRepairs: true }), new RegExp(`data-testid="tenant-repair-error">.*這裡暫時讀不到，請再試一次。</p><a class="t-rp-outline" href="/t/repair\\?id=${ID.open}">再試一次</a>`));
    assert.match(await renderRepairRoute({ id: "nope" }, { failRepairs: true }), /href="\/t\/repair">再試一次</);
  });
  // the fallback while the readers run is the skeleton
  const { TenantRepairV3Route } = compile(source("src/components/v3/tenant/repair-route.tsx"), repairRouteMocks({})) as { TenantRepairV3Route: (p: unknown) => React.ReactElement };
  const element = TenantRepairV3Route({ session, leaseId: "lease-a", company: "安居物業", params: {}, actions });
  assert.equal(element.type, Suspense);
  assert.equal(renderToStaticMarkup((element.props as { fallback: React.ReactElement }).fallback), renderToStaticMarkup(<TenantRepairLoading />));
});

type LeaseState = { money?: unknown; idReady?: boolean; signed?: unknown[]; fail?: boolean };
function leaseRouteMocks(state: LeaseState) {
  const fail = async <T,>(value: T) => { if (state.fail) throw new Error("db"); return value; };
  return {
    "next/link": link,
    "../../../i18n": { makeT: tFn },
    "../../../i18n/tenant-signed-pdf": { tenantSignedPdfStrings: () => ({ title: "已簽署", notice: "n", current: "目前", historical: "舊", uploaded: "上傳", view: "看", download: "下載" }) },
    "../../../server/b090-tenant-lease-repair": { tenantLeaseView: (s: Session, l: string) => tenantLeaseView(s, l, {
      money: (async () => fail("money" in state ? state.money : fullMoney)) as never, idCheck: (async () => fail({ ready: state.idReady ?? true })) as never,
      signed: (async () => fail(state.signed ?? signed)) as never, idRequired: (async () => true) as never }) },
    "../../../server/paper-lease-history-time": { signedPdfUploadedAt: (v: string) => ({ label: `T(${v})` }) },
    "../../../server/sandbox-data": { displaySampleName: (s: string) => `«${s}»` },
    "../../../server/types": {},
    "../../first-period-summary": { FirstPeriodSummary: () => <i data-stub="first-period" /> },
    "../../pdf-download-button": { PdfDownloadButton: (p: { href: string; testId: string }) => <i data-stub="pdf" data-href={p.href} data-testid={p.testId} /> },
    "./lease": leaseComponents,
  };
}
const renderLeaseRoute = async (state: LeaseState = {}) => {
  const { TenantLeaseV3Route } = compile(source("src/components/v3/tenant/lease-route.tsx"), leaseRouteMocks(state)) as { TenantLeaseV3Route: React.FC<Record<string, unknown>> };
  return prerender(<TenantLeaseV3Route session={session} leaseId="lease-a" />);
};

test("TEN-57-AC1 ON: the terms card with today's ID check, PDF, signed copies, first-period summary and firm line; G-ERR on a failed read", async () => {
  const out = await renderLeaseRoute();
  assert.match(out, /^<section class="v3-tenant-lease" data-testid="tenant-lease-v3"><h1 class="t-ls-lead">我的租約<\/h1><div class="t-ls-card" data-testid="tenant-lease-terms">/);
  assert.match(out, /<span>物件<\/span><b>«信義路四段 120 號 2 樓»<\/b>/);
  assert.match(out, /<span>租金<\/span><b class="t-ls-num">NT\$18,500／月<\/b>.*<span>繳租日<\/span><b>每月 5 日<\/b>.*<span>押金<\/span><b class="t-ls-num">NT\$37,000<\/b>/);
  assert.match(out, /<span>租期<\/span><b>2026年5月1日～2027年4月30日<\/b>/);
  assert.match(out, /<i data-stub="first-period"><\/i><div class="t-ls-card t-ls-docs"><p><i data-stub="pdf" data-href="\/api\/pdf\/leases\/lease-a" data-testid="download-lease-pdf"><\/i><\/p><section aria-label="已簽署">/);
  assert.match(out, /href="\/t\/lease\/signed\/pdf1" target="_blank" rel="noopener noreferrer">看<\/a> · <a href="\/t\/lease\/signed\/pdf1" download="">下載<\/a>.*href="\/t\/lease\/signed\/pdf0" target="_blank"/, "today's links kept");
  assert.match(out, /<p class="fn">i_firm_uses:\{&quot;firm&quot;:&quot;安居物業&quot;,&quot;brand&quot;:&quot;i_brand&quot;\}<\/p><\/section>$/);
  assert.doesNotMatch(out, /idv-gate|btn pri|<h2>i_rich_lease/);
  assert.doesNotMatch(out, OMITTED);
  const gated = await renderLeaseRoute({ idReady: false, signed: [] });
  assert.match(gated, /<h1 class="t-ls-lead">我的租約<\/h1><div class="card pad" id="idvGate" data-testid="idv-gate"><h3>idv_gate_h<\/h3><p>idv_gate<\/p><a href="\/t\/id" class="btn pri">idv_start<\/a><\/div>/, "the ID check keeps its place above the terms");
  assert.doesNotMatch(gated, /aria-label="已簽署"/);
  assert.equal(await renderLeaseRoute({ money: null }), "<p>i_empty</p>");
  assert.equal(await quietly(() => renderLeaseRoute({ fail: true })), renderToStaticMarkup(<TenantLeaseError locale="zh-TW" />));
  const { TenantLeaseV3Route } = compile(source("src/components/v3/tenant/lease-route.tsx"), leaseRouteMocks({})) as { TenantLeaseV3Route: (p: unknown) => React.ReactElement };
  const element = TenantLeaseV3Route({ session, leaseId: "lease-a" });
  assert.equal(element.type, Suspense);
  assert.equal(renderToStaticMarkup((element.props as { fallback: React.ReactElement }).fallback), renderToStaticMarkup(<TenantLeaseLoading />));
});

// ---------- the pages, brand_v3 ON: consent → session → flag → lease, then only the v3 route ----------
async function runPageOn(path: string, params: Record<string, string>, lease: unknown) {
  const calls: string[] = [];
  let routeProps: Record<string, unknown> | null = null;
  const rec = <V,>(name: string, value: V) => async () => { calls.push(name); return value; };
  const legacyRead = (name: string) => async () => { calls.push(`legacy:${name}`); return null; };
  const mocks: Record<string, unknown> = {
    "@/server/consent-gate": { requireCurrentConsent: rec("consent", undefined) },
    "@/server/session": { getSession: rec("session", session) },
    "@/server/brand-v3": { brandV3EnabledForOrg: rec("flag", true) },
    "@/lib/tenant-lease": { selectedLease: async (s: unknown) => { calls.push(s === session ? "lease(session)" : "lease(?)"); return { session, lease }; } },
    "@/i18n": { makeT: tFn, dictionary: () => ({}) },
    "next/link": link,
    "@/server/actions": { actionCancelRepair: "/cancel", actionTicket: "/ticket" },
    "@/server/queries": { tenantRepairs: legacyRead("repairs"), ticketDetail: legacyRead("detail"), tenantLeaseMoney: legacyRead("money"), tenantSignedLeasePdfs: legacyRead("signed") },
    "@/server/upload-recovery": { ticketPhotoRecovery: legacyRead("recovery") },
    "@/server/id-docs": { loadLeaseIdCheck: legacyRead("id_check") },
    "@/server/id-sign-gate": { identityRequiredForSigningFor: legacyRead("id_required") },
    "@/server/repair-rules": repairRules,
    "@/components/v3/illustrations": { Illustration: () => null },
    "@/components/repair-thread": { RepairThread: () => null },
    "@/components/ui": { ErrorBanner: () => null, statusClass: () => "", statusKey: () => "" },
    "@/lib/repair-labels": { REPAIR_CAT_KEY: {} },
    "@/components/pdf-download-button": { PdfDownloadButton: () => null },
    "@/components/first-period-summary": { FirstPeriodSummary: () => null },
    "@/server/format": { formatDate: () => "", moneyLabel: () => "" },
    "@/server/sandbox-data": { displaySampleName: (s: string) => s },
    "@/i18n/tenant-signed-pdf": { tenantSignedPdfStrings: () => ({}) },
    "@/server/paper-lease-history-time": { signedPdfUploadedAt: () => null },
    "@/components/v3/tenant/repair-route": { TenantRepairV3Route: (p: Record<string, unknown>) => { routeProps = p; return <i data-route="repair" />; } },
    "@/components/v3/tenant/lease-route": { TenantLeaseV3Route: (p: Record<string, unknown>) => { routeProps = p; return <i data-route="lease" />; } },
  };
  const page = compile(source(path), mocks).default as (p: unknown) => Promise<React.ReactElement>;
  const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve(params) }));
  return { calls, html, routeProps: routeProps as Record<string, unknown> | null };
}

test("TEN-56 / TEN-57 ON pages: consent → session → flag → lease, then the v3 route with the page's lease and actions; no legacy read", async () => {
  const lease = { lease_id: "lease-a", firm_name: "安居物業" };
  const repair = await runPageOn("src/app/t/repair/page.tsx", { id: ID.open, cancel: "1" }, lease);
  assert.deepEqual(repair.calls, ["consent", "session", "flag", "lease(session)"]);
  assert.equal(repair.html, '<i data-route="repair"></i>');
  assert.deepEqual(repair.routeProps, { session, leaseId: "lease-a", company: "安居物業", params: { id: ID.open, cancel: "1" }, actions: { ticket: "/ticket", cancel: "/cancel" } });
  const leasePage = await runPageOn("src/app/t/lease/page.tsx", {}, lease);
  assert.deepEqual(leasePage.calls, ["consent", "session", "flag", "lease(session)"]);
  assert.equal(leasePage.html, '<i data-route="lease"></i>');
  assert.deepEqual(leasePage.routeProps, { session, leaseId: "lease-a" });
  for (const path of ["src/app/t/repair/page.tsx", "src/app/t/lease/page.tsx"]) {
    const none = await runPageOn(path, {}, null);
    assert.equal(none.html, "<p>i_empty</p>", `${path}: no lease, today's empty line`);
    assert.equal(none.routeProps, null);
  }
});
