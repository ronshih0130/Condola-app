import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerUnitsLoading, OwnerUnitsView, statusText } from "../components/v3/owner/units";
import { brandV3OwnerUnitsCopy } from "../i18n/lanes/brand-v3-owner-units";
import { ownerUnits, parseOwnerUnits, type OwnerUnitRow, type OwnerUnits } from "./b092-owner-units";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// B-092 RO-UNITS (OWN-33-AC1/AC4). Synthetic data only.
const P = "00000000-0000-4000-8000-0000000000a1", U = "00000000-0000-4000-8000-0000000000b1", R = "00000000-0000-4000-8000-0000000000c1";
const base: OwnerUnitRow = { propertyId: P, property: "信義路", unitId: U, roomId: null, space: "2 樓", tenant: "陳怡君", rentMinor: "1850000", currency: "TWD", status: "partial", remainingMinor: "350000", vacantDays: null };
const vacant: OwnerUnitRow = { ...base, roomId: R, space: "套房", tenant: null, rentMinor: null, currency: null, status: "vacant", remainingMinor: null, vacantDays: 21 };
const owner: Session = { kind: "owner", role: null, orgId: P, liveOrgId: P, userId: U, sessionId: R, name: "", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };

test("RO-UNITS copy (PR-023): title and the four statuses; never 收款 or 入帳", () => {
  const c = brandV3OwnerUnitsCopy("zh-TW");
  assert.deepEqual([c.title, c.paid, c.overdue, c.partial("NT$3,500"), c.vacant(21), c.tenantHidden], ["我的物件", "已確認繳款", "逾期未繳", "部分已繳・還差 NT$3,500", "空租 21 天", "租客"]);
  assert.doesNotMatch(JSON.stringify(c) + c.partial("x") + c.vacant(1), /收款|入帳/);
});

test("statusText: only the approved wording; 'none' shows nothing", () => {
  assert.equal(statusText({ ...base, status: "paid", remainingMinor: null }, "zh-TW"), "已確認繳款");
  assert.equal(statusText({ ...base, status: "overdue", remainingMinor: null }, "zh-TW"), "逾期未繳");
  assert.match(statusText(base, "zh-TW") ?? "", /^部分已繳・還差 NT\$/);
  assert.equal(statusText(vacant, "zh-TW"), "空租 21 天");
  assert.equal(statusText({ ...base, status: "none", remainingMinor: null }, "zh-TW"), null);
});

test("OWN-33-AC1: lines show place, tenant (or 「租客」) and rent; vacant shows a dash; never a phone", () => {
  const html = renderToStaticMarkup(<OwnerUnitsView locale="zh-TW" result={{ state: "ready", rows: [base, { ...base, unitId: R, tenant: null, status: "none", remainingMinor: null }, vacant] }} />);
  assert.match(html, /<h2>我的物件<\/h2>/);
  assert.match(html, /信義路 2 樓<\/span><span class="owner-units-sub">陳怡君・NT\$/);
  assert.match(html, /<span class="owner-units-sub">租客・NT\$/);
  assert.match(html, /信義路 套房<\/span><span class="owner-units-sub">—<\/span><span class="owner-units-status">空租 21 天/);
  assert.equal((html.match(/owner-units-status/g) ?? []).length, 2, "the 'none' row has no status text");
  assert.doesNotMatch(html, /09\d{8}|tel:|phone/i);
});

test("OWN-33-AC4 states: nothing authorised or forbidden → no section; failure in place with retry; loading has no amounts", () => {
  for (const result of [{ state: "ready", rows: [] }, { state: "forbidden" }, { state: "off" }] as OwnerUnits[])
    assert.equal(renderToStaticMarkup(<OwnerUnitsView locale="zh-TW" result={result} />), "");
  assert.match(renderToStaticMarkup(<OwnerUnitsView locale="zh-TW" result={{ state: "unavailable" }} />), /這裡暫時讀不到，請再試一次。.*再試一次/);
  const loading = renderToStaticMarkup(<OwnerUnitsLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/); assert.doesNotMatch(loading, /NT\$|\d{2}/);
});

test("parser: strict shapes only; any inconsistency is a read failure", () => {
  assert.deepEqual(parseOwnerUnits({ rows: [base, vacant] }), [base, vacant]);
  for (const bad of [null, {}, { rows: [{ ...base, status: "reported" }] }, { rows: [{ ...base, remainingMinor: null }] },
    { rows: [{ ...vacant, tenant: "x" }] }, { rows: [{ ...vacant, vacantDays: -1 }] }, { rows: [{ ...base, rentMinor: "-1" }] },
    { rows: [{ ...base, vacantDays: 3 }] }, { rows: [{ ...base, currency: "twd" }] }, { rows: [{ ...base, unitId: "x" }] },
    { rows: [{ ...base, phone: "0912345678" }] }, { rows: [{ ...base, remainingMinor: "0" }] },
    { rows: [{ ...base, status: "overdue" }] }])
    assert.throws(() => parseOwnerUnits(bad), JSON.stringify(bad));
});

test("reader: OFF is off without a DB call; non-owner sessions are forbidden; a bad payload is unavailable", async () => {
  const never = (async () => { throw new Error("no transaction expected"); }) as never;
  assert.deepEqual(await ownerUnits(owner, { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await ownerUnits({ ...owner, kind: "staff", role: "admin" }, { v3: async () => true, transaction: never }), { state: "forbidden" });
  const fake = (async (_u: string, cb: (c: unknown) => Promise<unknown>) => cb({ query: async (sql: string) => ({ rows: sql.includes("b092_owner_units") ? [{ result: { rows: [{ ...base, status: "weird" }] } }] : [] }) })) as never;
  assert.deepEqual(await ownerUnits(owner, { v3: async () => true, transaction: fake }), { state: "unavailable" });
});
