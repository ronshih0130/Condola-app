import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { parseSharedMeterSplit, parseSharedMeterView, saveSharedMeter, sharedMeterSplit, sharedMeterView, type MeterSpace } from "./b109-shared-meter";
import { MeterFormView, SharedMeterForm } from "../components/v3/m/shared-meter/form";
import { SharedMeterBody, spaceLabel } from "../components/v3/m/shared-meter/page";
import { noteMonth, sharedMeterCopy } from "../i18n/lanes/brand-v3-shared-meter";
import { displayReading, initialMeterForm, meterFormErrors, READING, toggleSpace } from "../lib/shared-meter";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// B-109 ADV-METER (GS-53 = A; MGT-90-AC4…AC6). Synthetic data only; the frame's sample rooms.
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001", P = "00000000-0000-4000-8000-0000000000a1";
const id = (n: number) => `00000000-0000-4000-8000-0000000000b${n}`;
const staff: Session = { kind: "staff", role: "manager", orgId: ORG, liveOrgId: ORG, userId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const spaces: MeterSpace[] = ["A", "B", "C", "D", "E"].map((l, i) => ({ id: id(i + 1), kind: "room", unitLabel: "3F", label: l }));
const ready = { property: "民生東路三段 25 號", nextEffectiveFrom: "2026-12-01", spaces, config: null };
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const render = (node: React.ReactElement) => renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const never = (async () => { throw new Error("no transaction expected"); }) as never;
function client(result: unknown, seen: { sql: string; args?: unknown[] }[]) {
  return (async (_u: string, cb: (c: unknown) => Promise<unknown>) =>
    cb({ query: async (sql: string, args?: unknown[]) => { seen.push({ sql, args }); return { rows: sql.includes("app.b109_") ? [{ result }] : [] }; } })) as never;
}

test("copy is verbatim from the approved frame and its new words", () => {
  const c = sharedMeterCopy("zh-TW");
  assert.deepEqual([c.title, c.lead, c.rooms, c.count, c.method], ["公用電表", "樓梯、走廊這類大家一起用的電，每期度數依這裡的設定分給各間。", "分給哪幾間", "分給 {n} 間", "怎麼分"]);
  assert.deepEqual(c.methods, { even: "平均分", days_occupied: "依住的天數分", sub_meter: "依分表度數" });
  assert.deepEqual([c.start, c.startHelp, c.price, c.priceWhere], ["起始度數", "第一次抄表時的上期度數，之後每期自動接上。", "每度電價", "在金流設定的「電費規則」"]);
  assert.deepEqual([c.note, c.save, c.cancel, c.saved, c.errRooms, c.errStart], ["下一期起（{m} 月帳單）生效，不改已開出的帳單。", "儲存", "取消", "公用電表已儲存", "請至少選一間。", "請填起始度數。"]);
  assert.deepEqual([c.saveFailed, c.retry, c.aside], ["沒有存成功，請再試一次。", "再試一次", "未設定不影響建立單位或邀請租客。"]);
  assert.deepEqual(Object.keys(sharedMeterCopy("en")).sort(), Object.keys(c).sort());
  for (const word of ["房東", "收款", "收租"]) assert.equal(JSON.stringify(c).includes(word), false, word);
  assert.equal(noteMonth("2026-12-01", "zh-TW"), "12");
  assert.equal(noteMonth("2027-01-01", "en"), "January");
});

test("form helpers: all ticked by default, prefill from the saved revision, field errors, display order", () => {
  const form = spaces.map(s => ({ id: s.id, label: spaceLabel(s) }));
  assert.deepEqual(initialMeterForm(form, null), { spaces: spaces.map(s => s.id), method: "even", start: "" });
  assert.deepEqual(initialMeterForm(form, { spaceIds: [id(2), id(9)], method: "sub_meter", startReading: "1284.500" }), { spaces: [id(2)], method: "sub_meter", start: "1284.5" });
  assert.deepEqual(meterFormErrors({ spaces: [], method: "even", start: "" }), { rooms: true, start: true });
  assert.deepEqual(meterFormErrors({ spaces: [id(1)], method: "even", start: "1,284" }), { rooms: false, start: false });
  for (const bad of ["-1", "1.2345", "abc", " ", "100000000000"]) assert.equal(meterFormErrors({ spaces: [id(1)], method: "even", start: bad }).start, true, bad);
  assert.deepEqual(toggleSpace(form, [id(3), id(1)].slice(), id(2)), [id(1), id(2), id(3)]);
  assert.deepEqual(toggleSpace(form, [id(1), id(2)], id(1)), [id(2)]);
  assert.equal(displayReading("1284.000"), "1284");
  assert.equal(displayReading("0.000"), "0");
  assert.match("99999999999.999", READING);
  assert.equal(spaceLabel({ id: id(1), kind: "whole_unit", unitLabel: "5F", label: null }), "5F");
});

test("ADV-METER frame: rooms all ticked + 分給 n 間, three method cards, 起始度數 + help, 每度電價 row, next-period note, 儲存/取消", () => {
  const html = render(<SharedMeterBody data={{ state: "ready", ...ready }} propertyId={P} locale="zh-TW" />), body = text(html);
  for (const s of ["公用電表", "樓梯、走廊這類大家一起用的電，每期度數依這裡的設定分給各間。", "分給哪幾間", "3F A", "3F E", "分給 5 間", "怎麼分", "平均分", "依住的天數分", "依分表度數",
    "起始度數", "第一次抄表時的上期度數，之後每期自動接上。", "每度電價在金流設定的「電費規則」", "下一期起（12 月帳單）生效，不改已開出的帳單。", "儲存", "取消", "未設定不影響建立單位或邀請租客。"])
    assert.ok(body.includes(s), s);
  assert.equal((html.match(/type="checkbox"[^>]*checked=""/g) ?? []).length, 5);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  assert.match(html, /checked="" value="even"/);
  assert.match(html, new RegExp(`href="/m/properties/${P}"[^>]*>取消<`));
  assert.equal((html.match(/class="btn pri"/g) ?? []).length, 1, "儲存 is the only solid button");
  assert.doesNotMatch(html, /請至少選一間|請填起始度數|沒有存成功|公用電表已儲存/);
  assert.doesNotMatch(html, /href="[^"]*money|設定<\/a>/, "the 電費規則 link stays hidden until that page exists");
  // No price field anywhere on this page (MGT-90-AC5).
  assert.doesNotMatch(html, /name="(?:price|rate)"/);
});

test("MGT-90-AC6 states: field errors, GS-02 save failure keeps inputs with 再試一次, toast 公用電表已儲存", () => {
  const props = { locale: "zh-TW" as const, backHref: `/m/properties/${P}`, spaces: spaces.map(s => ({ id: s.id, label: spaceLabel(s) })), nextEffectiveFrom: "2026-12-01" };
  const errors = text(render(<MeterFormView {...props} state={{ spaces: [], method: "even", start: "" }} errors={{ rooms: true, start: true }} saving={false} failed={false} saved={false} />));
  assert.ok(errors.includes("請至少選一間。") && errors.includes("請填起始度數。") && errors.includes("分給 0 間"));
  const failedHtml = render(<MeterFormView {...props} state={{ spaces: [id(1), id(3)], method: "days_occupied", start: "1284" }} errors={{ rooms: false, start: false }} saving={false} failed={true} saved={false} />);
  assert.ok(text(failedHtml).includes("沒有存成功，請再試一次。"));
  assert.match(failedHtml, /data-testid="meter-save"[^>]*>再試一次</);
  assert.match(failedHtml, /value="1284"/);
  assert.match(failedHtml, /checked="" value="days_occupied"/);
  assert.equal((failedHtml.match(/type="checkbox"[^>]*checked=""/g) ?? []).length, 2);
  const saved = render(<MeterFormView {...props} state={{ spaces: [id(1)], method: "even", start: "1" }} errors={{ rooms: false, start: false }} saving={false} failed={false} saved={true} />);
  assert.match(saved, /<div class="toast v3-meter-toast" role="status" data-testid="meter-saved">公用電表已儲存<\/div>/);
  const quiet = render(<SharedMeterForm locale="zh-TW" propertyId={P} backHref="/x" spaces={props.spaces} config={null} nextEffectiveFrom="2026-12-01" />);
  assert.match(quiet, /<div class="toast v3-meter-toast" role="status" data-testid="meter-saved"><\/div>/, "the status region stays mounted");
  for (const state of ["forbidden", "unavailable"] as const) {
    const h = text(render(<SharedMeterBody data={{ state }} propertyId={P} locale="zh-TW" />));
    assert.ok(h.includes(state === "forbidden" ? "請管理者完成設定。" : "資料載入失敗"));
  }
});

test("shared_meter OFF is a 404 (off) for every role, checked before the role check", async () => {
  for (const actor of [staff, { ...staff, role: "accountant" as const }, { ...staff, role: "maintenance" as const }]) {
    assert.deepEqual(await sharedMeterView(actor, P, { v3: async () => true, flag: async () => false, transaction: never }), { state: "off" });
    assert.deepEqual(await saveSharedMeter(actor, { propertyId: P, requestId: id(9), spaceIds: [id(1)], method: "even", startReading: "1" },
      { v3: async () => true, flag: async () => false, transaction: never }), { ok: false, reason: "off" });
  }
});

test("reader/writer: OFF never opens a transaction; P-ACC/P-MNT/portals 403; pinned org/env; exact gateway args; strict DTO", async () => {
  assert.deepEqual(await sharedMeterView(staff, P, { v3: async () => false, transaction: never }), { state: "off" });
  for (const actor of [{ ...staff, role: "accountant" as const }, { ...staff, role: "maintenance" as const }, { ...staff, kind: "owner" as const, role: null }, { ...staff, sessionId: "x" }]) {
    assert.deepEqual(await sharedMeterView(actor, P, { v3: async () => true, flag: async () => true, transaction: never }), { state: "forbidden" });
    assert.deepEqual(await saveSharedMeter(actor, { propertyId: P, requestId: id(9), spaceIds: [id(1)], method: "even", startReading: "1" }, { v3: async () => true, flag: async () => true, transaction: never }), { ok: false, reason: "forbidden" });
  }
  const seen: { sql: string; args?: unknown[] }[] = [];
  assert.deepEqual(await sharedMeterView(staff, P, { v3: async () => true, flag: async () => true, transaction: client(ready, seen) }), { state: "ready", ...ready });
  assert.deepEqual(seen[2].args, [ORG, "live"]);
  assert.equal(seen[3].sql, "SELECT app.b109_shared_meter_view($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid) AS result");
  assert.deepEqual(await sharedMeterView(staff, P, { v3: async () => true, flag: async () => true, transaction: client(null, []) }), { state: "off" });
  for (const bad of [{ ...ready, nextEffectiveFrom: "2026-12-02" }, { ...ready, spaces: [{ ...spaces[0], label: null }] },
    { ...ready, config: { revision: 1, spaceIds: [], method: "even", startReading: "1", effectiveFrom: "2026-12-01" } },
    { ...ready, config: { revision: 1, spaceIds: [id(1)], method: "none", startReading: "1", effectiveFrom: "2026-12-01" } }])
    assert.deepEqual(await sharedMeterView(staff, P, { v3: async () => true, flag: async () => true, transaction: client(bad, []) }), { state: "unavailable" });
  assert.throws(() => parseSharedMeterView({ ...ready, spaces: [{ ...spaces[0], id: "x" }] }));
  const saves: { sql: string; args?: unknown[] }[] = [];
  const ok = await saveSharedMeter(staff, { propertyId: P, requestId: id(9), spaceIds: [id(1), id(2)], method: "sub_meter", startReading: " 1,284.5 " },
    { v3: async () => true, flag: async () => true, transaction: client({ status: "saved", configId: id(8), revision: 2, effectiveFrom: "2026-12-01", spaceCount: 2, method: "sub_meter", replayed: false }, saves) });
  assert.deepEqual(ok, { ok: true, revision: 2, effectiveFrom: "2026-12-01", spaceCount: 2, method: "sub_meter", replayed: false });
  assert.deepEqual(saves[3].args, [ORG, ORG, "live", staff.sessionId, id(9), P, [id(1), id(2)], "sub_meter", "1284.5"]);
  for (const bad of [{ spaceIds: [] }, { spaceIds: [id(1), id(1)] }, { method: "none" }, { startReading: "-1" }, { startReading: "1.2345" }, { requestId: "x" }])
    assert.deepEqual(await saveSharedMeter(staff, { propertyId: P, requestId: id(9), spaceIds: [id(1)], method: "even", startReading: "1", ...bad }, { v3: async () => true, flag: async () => true, transaction: never }), { ok: false, reason: "invalid" }, JSON.stringify(bad));
  for (const [status, reason] of [["disabled", "off"], ["invalid", "invalid"], ["conflict", "conflict"], ["weird", "failed"]] as const)
    assert.deepEqual(await saveSharedMeter(staff, { propertyId: P, requestId: id(9), spaceIds: [id(1)], method: "even", startReading: "1" }, { v3: async () => true, flag: async () => true, transaction: client({ status }, []) }), { ok: false, reason });
});

test("wiring: route under brand_v3 with consent; action checks consent; B-017 map; flag registered; ≥44px targets; no outbound", () => {
  const route = read("src/app/m/properties/[id]/shared-meter/page.tsx");
  assert.match(route, /await requireCurrentConsent\(undefined, "page"\);/);
  assert.match(route, /if \(!\(await brandV3EnabledForOrg\(session\.orgId\)\)\) notFound\(\);/);
  assert.match(read("src/components/v3/m/shared-meter/page.tsx"), /if \(data\.state === "off"\) notFound\(\);/);
  assert.match(read("src/server/b109-shared-meter-actions.ts"), /^"use server";[\s\S]*await requireCurrentConsent\(\);/);
  const map = JSON.parse(read("src/server/b017-entry-permissions.json")) as Record<string, unknown>;
  assert.equal(map["src/server/b109-shared-meter.ts#sharedMeterView"], "props.edit");
  assert.equal(map["src/server/b109-shared-meter.ts#saveSharedMeter"], "props.edit");
  assert.doesNotMatch(read("src/components/v3/m/shared-meter/form.tsx"), /from "[^"]*server\/(?!b109-shared-meter-actions")(?!b109-shared-meter")/);
  assert.doesNotMatch(read("src/components/v3/m/shared-meter/form.tsx"), /^import \{[^}]*\} from "\.\.\/\.\.\/\.\.\/\.\.\/server\/b109-shared-meter";/m, "only types from the server module");
  const css = read("public/brand/v3/shared-meter.css");
  for (const rule of [/\.v3-meter-room \{[^}]*min-height:44px; min-width:44px;/, /\.v3-meter-method \{[^}]*min-height:44px;/, /\.v3-meter-start input \{ min-height:44px;/, /\.v3-meter-actions \.btn \{ min-height:44px; min-width:44px; \}/])
    assert.match(css, rule);
  for (const src of [read("src/server/b109-shared-meter.ts"), read("supabase/migrations/20261116180000_b109_shared_meter.sql")])
    assert.doesNotMatch(src, /fetch\(|notification|line-push|sms|invoices|utility_allocation_runs \(/i);
});

test("split preview caller: page admission mirrored; input mirrors the gateway; strict DTO that must add up", async () => {
  const input = { propertyId: P, period: "2026-12-01", kwh: "10", amountMinor: "1000" };
  assert.deepEqual(await sharedMeterSplit(staff, input, { v3: async () => false, transaction: never }), { state: "off" });
  for (const actor of [{ ...staff, role: "accountant" as const }, { ...staff, role: "maintenance" as const }, { ...staff, kind: "tenant" as const, role: null }])
    assert.deepEqual(await sharedMeterSplit(actor, input, { v3: async () => true, flag: async () => true, transaction: never }), { state: "forbidden" });
  for (const bad of [{ period: "2026-12-02" }, { kwh: "1.2345" }, { kwh: "-1" }, { amountMinor: "1.5" }, { amountMinor: "1000000000000001" }, { propertyId: "x" }])
    assert.deepEqual(await sharedMeterSplit(staff, { ...input, ...bad }, { v3: async () => true, flag: async () => true, transaction: never }), { state: "unavailable" }, JSON.stringify(bad));
  const rows = [{ id: id(1), kind: "room", unitLabel: "3F", label: "A", weight: "60", kwh: "5.609", amountMinor: "561" },
    { id: id(2), kind: "room", unitLabel: "3F", label: "B", weight: "30", kwh: "2.803", amountMinor: "280" },
    { id: id(3), kind: "room", unitLabel: "3F", label: "C", weight: "10", kwh: "0.934", amountMinor: "93" },
    { id: id(4), kind: "whole_unit", unitLabel: "5F", label: null, weight: "7", kwh: "0.654", amountMinor: "66" }];
  const ready = { status: "ready", period: "2026-12-01", revision: 3, method: "sub_meter", effectiveFrom: "2026-12-01", startReading: "0.000", kwh: "10.000", amountMinor: "1000", rows };
  const seen: { sql: string; args?: unknown[] }[] = [];
  const result = await sharedMeterSplit(staff, input, { v3: async () => true, flag: async () => true, transaction: client(ready, seen) });
  assert.equal(result.state, "ready");
  assert.equal(seen[3].sql, "SELECT app.b109_shared_meter_split($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::date,$7::numeric,$8::bigint) AS result");
  assert.deepEqual(seen[3].args, [ORG, ORG, "live", staff.sessionId, P, "2026-12-01", "10", "1000"]);
  for (const [status, problem] of [["ambiguous_meters", "ambiguous_meter"], ["ambiguous_runs", "ambiguous_run"], ["missing_readings", "missing_reading"], ["estimated_readings", "estimated_reading"]] as const)
    assert.deepEqual(parseSharedMeterSplit({ status, period: "2026-12-01", revision: 3, spaces: [{ id: id(3), problem }] }), { state: "not_ready", reason: status, problems: [{ spaceId: id(3), problem }] });
  // Every problem space with its own kind; the status must be the highest-precedence kind present.
  const mixed = [{ id: id(1), problem: "estimated_reading" }, { id: id(2), problem: "ambiguous_meter" }, { id: id(3), problem: "missing_reading" }];
  assert.deepEqual(parseSharedMeterSplit({ status: "ambiguous_meters", spaces: mixed }), { state: "not_ready", reason: "ambiguous_meters",
    problems: mixed.map(x => ({ spaceId: x.id, problem: x.problem })) });
  // B-109b: an ambiguous run ranks below an ambiguous meter and above missing/estimated readings.
  const runs = [{ id: id(1), problem: "missing_reading" }, { id: id(2), problem: "ambiguous_run" }];
  assert.deepEqual(parseSharedMeterSplit({ status: "ambiguous_runs", spaces: runs }), { state: "not_ready", reason: "ambiguous_runs", problems: runs.map(x => ({ spaceId: x.id, problem: x.problem })) });
  assert.throws(() => parseSharedMeterSplit({ status: "ambiguous_runs", spaces: mixed }));
  assert.throws(() => parseSharedMeterSplit({ status: "missing_readings", spaces: runs }));
  for (const bad of [{ status: "missing_readings", spaces: mixed }, { status: "estimated_readings", spaces: mixed }, { status: "missing_readings", spaces: [id(1)] },
    { status: "missing_readings", spaces: [{ id: id(1), problem: "weird" }] }]) assert.throws(() => parseSharedMeterSplit(bad), JSON.stringify(bad).slice(0, 60));
  assert.deepEqual(parseSharedMeterSplit({ status: "none", period: "2026-12-01" }), { state: "none" });
  for (const bad of [{ ...ready, rows: [{ ...rows[0], kwh: "5.610" }, ...rows.slice(1)] }, { ...ready, rows: [{ ...rows[0], amountMinor: "560" }, ...rows.slice(1)] },
    { ...ready, rows: [] }, { ...ready, method: "none" }, { status: "missing_readings", spaces: [] }, { status: "weird" }])
    assert.deepEqual(await sharedMeterSplit(staff, input, { v3: async () => true, flag: async () => true, transaction: client(bad, []) }), { state: "unavailable" }, JSON.stringify(bad).slice(0, 60));
  assert.equal((JSON.parse(read("src/server/b017-entry-permissions.json")) as Record<string, unknown>)["src/server/b109-shared-meter.ts#sharedMeterSplit"], "props.edit");
});
