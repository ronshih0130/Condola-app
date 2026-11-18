import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerUnitError, OwnerUnitNoPerm, OwnerUnitView, monthStatusText, termText } from "../components/v3/owner/unit";
import { OwnerUnitsView, ownerUnitHref } from "../components/v3/owner/units";
import { brandV3OwnerUnitsCopy } from "../i18n/lanes/brand-v3-owner-units";
import { ownerUnit, parseOwnerUnit, type OwnerUnitDetail } from "./b092-owner-unit";
import type { OwnerUnitRow } from "./b092-owner-units";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// B-092 RO-UNIT (OWN-33-AC2/AC4). Synthetic data only.
const P = "00000000-0000-4000-8000-0000000000a1", U = "00000000-0000-4000-8000-0000000000b1", R = "00000000-0000-4000-8000-0000000000c1";
const T1 = "00000000-0000-4000-8000-0000000000d1", T2 = "00000000-0000-4000-8000-0000000000d2";
const unit: OwnerUnitDetail = {
  property: "信義路", space: "2 樓", vacant: false, tenant: "陳怡君", phone: null, startDate: "2026-01-01", endDate: "2026-12-31",
  rentMinor: "1850000", currency: "TWD",
  months: [{ month: "2026-11", status: "partial", remainingMinor: "350000" }, { month: "2026-10", status: "overdue", remainingMinor: null },
    { month: "2026-09", status: "paid", remainingMinor: null }, { month: "2026-08", status: "none", remainingMinor: null }],
  repairs: [{ id: T1, title: "熱水器不熱", status: "assigned" }, { id: T2, title: "門鎖鬆動", status: "open" }],
};
const vacantUnit: OwnerUnitDetail = { ...unit, vacant: true, tenant: null, startDate: null, endDate: null, rentMinor: null, currency: null, months: [], repairs: [] };
const owner: Session = { kind: "owner", role: null, orgId: P, liveOrgId: P, userId: U, sessionId: R, name: "", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };

test("RO-UNIT copy (frame + PR-023): section titles, row label and month; never 收款 or 入帳", () => {
  const c = brandV3OwnerUnitsCopy("zh-TW");
  assert.deepEqual([c.tenant, c.recentPayments, c.openRepairs, c.month(11)], ["租客", "最近的繳款", "進行中的報修", "11 月"]);
  assert.doesNotMatch(JSON.stringify(c) + c.month(1), /收款|入帳/);
});

test("OWN-33-AC2: heading, tenant, term, rent; months with RO-UNITS wording ('none' shows nothing); repairs with the approved words", () => {
  const html = renderToStaticMarkup(<OwnerUnitView locale="zh-TW" calendar="gregorian" unit={unit} />);
  assert.match(html, /<h2>信義路 2 樓<\/h2>/);
  assert.match(html, /<dt>租客<\/dt><dd data-testid="owner-unit-tenant">陳怡君<\/dd>/);
  assert.match(html, /<dt>租期<\/dt><dd class="num">2026年1月1日～2026年12月31日<\/dd>/);
  assert.match(html, /<dt>月租<\/dt><dd class="num">NT\$/);
  assert.match(html, /<h3>最近的繳款<\/h3>/);
  assert.match(html, /<span>11 月<\/span><span class="owner-unit-status">部分已繳・還差 NT\$/);
  assert.match(html, /<span>10 月<\/span><span class="owner-unit-status">逾期未繳/);
  assert.match(html, /<span>9 月<\/span><span class="owner-unit-status">已確認繳款/);
  assert.match(html, /<li class="owner-unit-none"><span>8 月<\/span><\/li>/);
  assert.match(html, /<h3>進行中的報修<\/h3>.*熱水器不熱<\/span><span class="owner-unit-status">已派工.*門鎖鬆動<\/span><span class="owner-unit-status">待派工/);
  assert.match(html, /href="\/o"[^>]*>我的物件</, "crumb back to 我的物件");
  assert.doesNotMatch(html, /<button|<form|<input|電話|tel:/, "read-only; no phone row without a phone");
});

test("OWN-33-AC2: phone row only when the gateway returns one; hidden name reads 「租客」; open end; empty sections omitted", () => {
  const html = renderToStaticMarkup(<OwnerUnitView locale="zh-TW" calendar="gregorian" unit={{ ...unit, tenant: null, phone: "+886912345678", endDate: null, months: [], repairs: [] }} />);
  assert.match(html, /<dt>電話<\/dt><dd class="num" data-testid="owner-unit-phone">\+886912345678<\/dd>/);
  assert.match(html, /<dd data-testid="owner-unit-tenant">租客<\/dd>/);
  assert.match(html, /2026年1月1日～<\/dd>/);
  assert.doesNotMatch(html, /最近的繳款|進行中的報修|owner-unit-payments|owner-unit-repairs/);
});

test("OQ-079: 租期 uses the app's own date format (ROC when the org uses it) joined by 「～」", () => {
  assert.equal(termText(unit, "zh-TW", "gregorian"), "2026年1月1日～2026年12月31日");
  assert.equal(termText(unit, "zh-TW", "roc"), "民國 115 年 1 月 1 日～民國 115 年 12 月 31 日");
  assert.equal(termText({ startDate: "2026-01-01", endDate: null }, "zh-TW", "roc"), "民國 115 年 1 月 1 日～");
  assert.equal(termText(unit, "en", "gregorian"), "Jan 1, 2026～Dec 31, 2026");
  assert.equal(termText({ startDate: null, endDate: null }, "zh-TW", "gregorian"), null);
  const roc = renderToStaticMarkup(<OwnerUnitView locale="zh-TW" calendar="roc" unit={unit} />);
  assert.match(roc, /<dt>租期<\/dt><dd class="num">民國 115 年 1 月 1 日～民國 115 年 12 月 31 日<\/dd>/);
  assert.doesNotMatch(roc, /2026-01-01/);
});

test("monthStatusText: only the approved wording", () => {
  assert.equal(monthStatusText({ month: "2026-11", status: "paid", remainingMinor: null }, "TWD", "zh-TW"), "已確認繳款");
  assert.equal(monthStatusText({ month: "2026-11", status: "none", remainingMinor: null }, "TWD", "zh-TW"), null);
});

test("OWN-33-AC4 states: error with retry to the same URL; B1-NOPERM names nothing", () => {
  const href = ownerUnitHref({ unitId: U, roomId: R });
  assert.equal(href, `/o/units/${U}?room=${R}`);
  assert.equal(ownerUnitHref({ unitId: U, roomId: null }), `/o/units/${U}`);
  const err = renderToStaticMarkup(<OwnerUnitError locale="zh-TW" retryHref={href} />);
  assert.match(err, /這裡暫時讀不到，請再試一次。.*href="\/o\/units\/[^"]+\?room=[^"]+">再試一次/);
  const noperm = renderToStaticMarkup(<OwnerUnitNoPerm locale="zh-TW" />);
  assert.match(noperm, /你目前的角色看不到這一頁/); assert.doesNotMatch(noperm, /信義路|陳怡君/);
});

test("RO-UNITS list: each leased line is one link to its panel (room carries ?room=); vacant lines stay plain", () => {
  const base: OwnerUnitRow = { propertyId: P, property: "信義路", unitId: U, roomId: null, space: "2 樓", tenant: "陳怡君", rentMinor: "1850000", currency: "TWD", status: "paid", remainingMinor: null, vacantDays: null };
  const room: OwnerUnitRow = { ...base, roomId: R, space: "2F A", status: "none" };
  const vacant: OwnerUnitRow = { ...base, unitId: T1, roomId: T2, space: "套房", tenant: null, rentMinor: null, currency: null, status: "vacant", vacantDays: 3 };
  const html = renderToStaticMarkup(<OwnerUnitsView locale="zh-TW" result={{ state: "ready", rows: [base, room, vacant] }} />);
  assert.match(html, new RegExp(`<a class="owner-units-link" href="/o/units/${U}"><span class="owner-units-place">信義路 2 樓`));
  assert.match(html, new RegExp(`<a class="owner-units-link" href="/o/units/${U}\\?room=${R}"><span class="owner-units-place">信義路 2F A`));
  assert.equal((html.match(/<a /g) ?? []).length, 2, "the vacant line has no link");
  assert.match(html, /<li class="owner-units-line owner-units-vacant"><span class="owner-units-place">信義路 套房/);
  assert.match(html, /data-testid="owner-units"/);
});

test("parser: strict shapes only; any extra field or inconsistency is a read failure", () => {
  assert.deepEqual(parseOwnerUnit(unit), unit);
  assert.deepEqual(parseOwnerUnit(vacantUnit), vacantUnit);
  // A vacant space may still have open repairs; never a lease, tenant, phone or payment month.
  assert.deepEqual(parseOwnerUnit({ ...vacantUnit, repairs: unit.repairs }), { ...vacantUnit, repairs: unit.repairs });
  const m = unit.months[0], r = unit.repairs[0];
  for (const bad of [null, [], {}, { ...unit, email: "x@example.test" }, { ...unit, phone: "0912345678" }, { ...unit, vacant: "no" },
    { ...vacantUnit, tenant: "x" }, { ...vacantUnit, months: [m] }, { ...vacantUnit, phone: "+886912345678" }, { ...vacantUnit, rentMinor: "1" }, { ...unit, startDate: null }, { ...unit, startDate: "2026-13-01" },
    { ...unit, rentMinor: "-1" }, { ...unit, currency: "twd" }, { ...unit, months: [{ ...m, remainingMinor: null }] },
    { ...unit, months: [{ ...m, remainingMinor: "0" }] }, { ...unit, months: [{ ...m, status: "overdue" }] },
    { ...unit, months: [{ ...m, status: "vacant", remainingMinor: null }] }, { ...unit, months: [m, m] }, { ...unit, months: [{ ...m, month: "2026-11-01" }] },
    { ...unit, months: [{ ...m, extra: 1 }] }, { ...unit, repairs: [{ ...r, status: "resolved" }] }, { ...unit, repairs: [{ ...r, id: "x" }] },
    { ...unit, repairs: [{ ...r, description: "x" }] }, { ...unit, repairs: Array(6).fill(r) }])
    assert.throws(() => parseOwnerUnit(bad), JSON.stringify(bad));
});

test("reader: OFF is off without a DB call; non-owner or bad ids are forbidden; 42501 is forbidden; a bad payload is unavailable", async () => {
  const never = (async () => { throw new Error("no transaction expected"); }) as never;
  assert.deepEqual(await ownerUnit(owner, U, null, { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await ownerUnit({ ...owner, kind: "staff", role: "admin" }, U, null, { v3: async () => true, transaction: never }), { state: "forbidden" });
  for (const [u, rm] of [["x", null], [U, "x"], [U, [R]], [U, ""], [undefined, null]] as [unknown, unknown][])
    assert.deepEqual(await ownerUnit(owner, u, rm, { v3: async () => true, transaction: never }), { state: "forbidden" }, JSON.stringify([u, rm]));
  const run = (result: () => unknown) => (async (_u: string, cb: (c: unknown) => Promise<unknown>) => cb({ query: async (sql: string) => ({ rows: sql.includes("b092_owner_unit(") ? [{ result: result() }] : [] }) })) as never;
  const denied = run(() => { throw Object.assign(new Error("errors.forbidden"), { code: "42501" }); });
  assert.deepEqual(await ownerUnit(owner, U, R, { v3: async () => true, transaction: denied }), { state: "forbidden" });
  assert.deepEqual(await ownerUnit(owner, U, null, { v3: async () => true, transaction: run(() => ({ ...unit, phone: 1 })) }), { state: "unavailable" });
  assert.deepEqual(await ownerUnit(owner, U, null, { v3: async () => true, transaction: run(() => unit) }), { state: "ready", unit });
});

// ---- Route wiring (compiled with mocks, no DB): the read is awaited before rendering; OFF and vacant are 404s. ----
const requireHere = createRequire(import.meta.url);
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
const route = readFileSync("src/app/o/units/[unitId]/page.tsx", "utf8");
async function runRoute(opts: { v3: boolean; result?: unknown; unitId?: string; room?: string | string[] }) {
  const calls: string[] = [];
  const unitView = requireHere("../components/v3/owner/unit") as typeof import("../components/v3/owner/unit");
  const reader = requireHere("./b092-owner-unit") as typeof import("./b092-owner-unit");
  const mocks = {
    "next/navigation": { notFound: () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); } },
    "@/components/v3/owner/unit": unitView,
    "@/components/v3/owner/units": { ownerUnitHref: (row: { unitId: string; roomId: string | null }) => `/o/units/${row.unitId}${row.roomId ? `?room=${row.roomId}` : ""}` },
    // The real reader's id validation runs (bad ids → forbidden with no DB call); the gateway call is replaced.
    "@/server/b092-owner-unit": { ownerUnit: async (session: Session, unitId: unknown, roomId: unknown) => {
      calls.push(`read:${String(unitId)}:${String(roomId)}`);
      return reader.ownerUnit(session, unitId, roomId, { v3: async () => true,
        transaction: (async (_u: string, cb: (c: unknown) => Promise<unknown>) => cb({ query: async (sql: string) => {
          if (!sql.includes("b092_owner_unit(")) return { rows: [] };
          if (opts.result === "denied") throw Object.assign(new Error("errors.forbidden"), { code: "42501" });
          return { rows: [{ result: opts.result }] };
        } })) as never });
    } },
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => { calls.push("v3"); return opts.v3; } },
    "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); } },
    "@/server/session": { getSession: async () => owner },
  };
  const Page = compile(route, mocks).default as (p: unknown) => Promise<React.ReactElement>;
  try {
    const el = await Page({ params: Promise.resolve({ unitId: opts.unitId ?? U }), searchParams: Promise.resolve(opts.room === undefined ? {} : { room: opts.room }) });
    return { calls, html: renderToStaticMarkup(el) };
  } catch (e) { return { calls, html: (e as Error).message }; }
}

test("RO-UNIT route: OFF and vacant are 404 before anything renders; forbidden and bad ids are B1-NOPERM; ready is the panel", async () => {
  const off = await runRoute({ v3: false, result: unit });
  assert.equal(off.html, "NEXT_NOT_FOUND"); assert.ok(!off.calls.some(c => c.startsWith("read:")), "OFF never reads");
  assert.equal((await runRoute({ v3: true, result: vacantUnit })).html, "NEXT_NOT_FOUND");
  assert.equal((await runRoute({ v3: true, result: { ...vacantUnit, repairs: unit.repairs } })).html, "NEXT_NOT_FOUND", "vacant with repairs is still a 404");
  for (const bad of [{ result: "denied" }, { unitId: "x", result: unit }, { room: "x", result: unit }, { room: [R, R], result: unit }]) {
    const res = await runRoute({ v3: true, ...bad });
    assert.match(res.html, /data-testid="owner-unit-noperm"/, JSON.stringify(bad));
    assert.doesNotMatch(res.html, /信義路|陳怡君/);
  }
  const ready = await runRoute({ v3: true, result: unit, room: R });
  assert.match(ready.html, /data-testid="owner-unit"/); assert.match(ready.html, /<h2>信義路 2 樓<\/h2>/);
  assert.ok(ready.calls.includes(`read:${U}:${R}`));
  const failed = await runRoute({ v3: true, result: { ...unit, phone: 1 }, room: R });
  assert.match(failed.html, new RegExp(`data-testid="owner-unit-error".*href="/o/units/${U}\\?room=${R}"`));
  assert.doesNotMatch(route.replace(/^\s*\*.*$/gm, ""), /Suspense|Loading|fallback=/);
});
