import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { depositTopupView, parseTopupView, recordDepositTopup, type TopupView } from "./mf3-deposit-topup";
import { TopupError, TopupReadView, TopupStaffView } from "../components/v3/topup/topup";
import { TopupDupToast, TopupSheetForm } from "../components/v3/topup/topup-sheet";
import { brandV3TopupCopy } from "../i18n/lanes/brand-v3-topup";
import { bigintMinor, checkTopupAmount, dateIn, latestLocalToday, parseTopupAmount, TOPUP_MAX_MINOR, topupDateAllowed, topupDay, topupMinorWithinCap, topupMoney, topupOver, validTopupDate } from "../lib/deposit-topup";
import { closedSheet, createTopupSender, topupSheetReducer, topupSignature, type TopupSheetState } from "../components/v3/topup/topup-controller";
import type { TopupInput, TopupResult } from "./mf3-deposit-topup";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// MF-3 / MGT-151-AC1…AC5 (MO-TOPUP). Synthetic data only; the frames' sample figures.
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001", LEASE = "00000000-0000-4000-8000-0000000000c1", SETTLE = "00000000-0000-4000-8000-0000000000d1";
const E1 = "00000000-0000-4000-8000-0000000000e1";
const base = { orgId: ORG, liveOrgId: ORG, userId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003",
  name: "Synthetic", email: "", environment: "live" as const, locale: "zh-TW" as const, calendar: "gregorian" as const, leaseId: null };
const staff: Session = { ...base, kind: "staff", role: "manager" };
const tenant: Session = { ...base, kind: "tenant", role: null, leaseId: LEASE };
const owner: Session = { ...base, kind: "owner", role: null };
const view = (kind: "staff" | "tenant" | "owner"): TopupView => ({ settlementId: SETTLE, leaseId: LEASE, tenant: kind === "staff" ? "林小美" : null,
  currency: "TWD", minorUnit: 2, depositMinor: "2400000", deductionMinor: "2700000", owedMinor: "300000", paidMinor: "100000",
  entries: [{ id: E1, amountMinor: "100000", receivedOn: "2026-11-20" }], canRecord: kind === "staff" });
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const render = (node: React.ReactElement) => renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const never = (async () => { throw new Error("no transaction expected"); }) as never;
function client(result: unknown, seen: { sql: string; args?: unknown[] }[]) {
  return (async (_user: string, callback: (c: unknown) => Promise<unknown>) =>
    callback({ query: async (sql: string, args?: unknown[]) => { seen.push({ sql, args }); return { rows: sql.includes("app.mf3_") ? [{ result }] : [] }; } })) as never;
}

test("pure helpers: exact minor-unit money, amount parsing, over amount, frame date", () => {
  assert.equal(topupMoney("300000", "TWD", 2), "NT$3,000");
  assert.equal(topupMoney("2400000", "TWD ", 2), "NT$24,000");
  assert.equal(topupMoney("1250", "USD", 2), "USD 12.50");
  assert.equal(topupMoney("1200", "USD", 2), "USD 12");
  assert.equal(topupMoney("5", "JPY", 0), "JPY 5");
  assert.equal(parseTopupAmount("2,500", 2), "250000");
  assert.equal(parseTopupAmount("2500.5", 2), "250050");
  for (const bad of ["", "0", "0.00", "-1", "1.234", "abc", "1e3", "10000000000001"]) assert.equal(parseTopupAmount(bad, 2), null, bad);
  assert.equal(parseTopupAmount("12", 0), "12");
  assert.equal(parseTopupAmount("1.5", 0), null);
  assert.equal(topupOver("300000", "100000", "250000"), "50000");
  assert.equal(topupOver("300000", "100000", "200000"), "0");
  assert.equal(topupOver("300000", "100000", null), "0");
  assert.equal(topupDay("2026-11-20"), "11/20");
  assert.equal(topupDay("2026-01-05"), "1/5");
  assert.equal(validTopupDate("2026-11-25"), true);
  for (const bad of ["2026-02-30", "1999-12-31", "2101-01-01", "11/25", ""]) assert.equal(validTopupDate(bad), false, bad);
  // One cap for an entry and for the total paid; settlement figures may be any bigint.
  assert.deepEqual(checkTopupAmount("10000000000000", 2), { ok: true, minor: TOPUP_MAX_MINOR });
  assert.deepEqual(checkTopupAmount("10000000000000.01", 2), { ok: false, reason: "range" });
  assert.deepEqual(checkTopupAmount("abc", 2), { ok: false, reason: "format" });
  assert.equal(topupMinorWithinCap(TOPUP_MAX_MINOR), true);
  assert.equal(topupMinorWithinCap("1000000000000001"), false);
  assert.equal(bigintMinor("9223372036854775807"), true);
  assert.equal(bigintMinor("9223372036854775808"), false);
  // Received dates: not later than today.
  assert.equal(topupDateAllowed("2026-11-25", "2026-11-25"), true);
  assert.equal(topupDateAllowed("2026-11-26", "2026-11-25"), false);
  const now = new Date("2026-11-16T11:30:00Z");
  assert.equal(dateIn("America/Los_Angeles", now), "2026-11-16");
  assert.equal(dateIn("Asia/Taipei", now), "2026-11-16");
  assert.equal(latestLocalToday(now), "2026-11-17", "UTC+14 is already the next day");
});

test("copy is verbatim from the approved frames (Round 7 batch 2) and passes the wording rules", () => {
  const c = brandV3TopupCopy("zh-TW");
  assert.deepEqual([c.record, c.line, c.lead, c.over], ["記錄已收", "應補 {owed}・已補 {paid}", "扣款比押金多，租客要補 {amount}。", "比應補多收 {amount}，確定嗎？"]);
  assert.deepEqual([c.title, c.titleWith, c.card, c.deposit, c.deductions, c.entries], ["退租結算", "退租結算・{tenant}", "結算（三方同一版）", "押金實收", "扣款合計", "收到的補款"]);
  assert.deepEqual([c.amount, c.date, c.note, c.confirm, c.cancel, c.close], ["金額（必填）", "日期（必填）", "備註（選填）", "確定", "取消", "關閉"]);
  assert.deepEqual([c.saveFailed, c.retry, c.readFailed], ["沒有存成功，請再試一次。", "再試一次", "這裡暫時讀不到，請再試一次。"]);
  const all = JSON.stringify(c) + JSON.stringify(brandV3TopupCopy("en"));
  for (const word of ["房東", "收款", "收租", "代收", "入帳", "保證", "欠租"]) assert.equal(all.includes(word), false, word);
  assert.deepEqual(Object.keys(brandV3TopupCopy("en")).sort(), Object.keys(c).sort());
});

test("MGT-151-AC1/AC2 staff view: crumb, lead, the shared card, dated entries and 「記錄已收」", () => {
  const html = render(<TopupStaffView view={view("staff")} locale="zh-TW" />), body = text(html);
  for (const s of ["租約›林小美›退租結算", "退租結算・林小美", "扣款比押金多，租客要補 NT$3,000。", "結算（三方同一版）", "押金實收NT$24,000", "扣款合計NT$27,000",
    "應補 NT$3,000・已補 NT$1,000", "收到的補款", "11/20NT$1,000", "記錄已收"]) assert.ok(body.includes(s), s);
  assert.match(html, /href="\/m\/leases"/);
  assert.match(html, new RegExp(`href="/m/leases/${LEASE}"`));
  assert.equal((html.match(/data-testid="topup-entry"/g) ?? []).length, 1);
  assert.equal((html.match(/<button/g) ?? []).length, 1, "one button; the sheet is closed until tapped");
  assert.doesNotMatch(body, /付款方式|轉帳帳號|LINE|寄出|通知/);
  // No entries yet: the line still shows 已補 NT$0 (a real figure), the entries heading is left out.
  const none = text(render(<TopupStaffView view={{ ...view("staff"), paidMinor: "0", entries: [] }} locale="zh-TW" />));
  assert.ok(none.includes("應補 NT$3,000・已補 NT$0"));
  assert.ok(!none.includes("收到的補款"));
});

test("MGT-151-AC1/AC2 tenant and owner: the same version, read only, no button", () => {
  const staffBody = text(render(<TopupStaffView view={view("staff")} locale="zh-TW" />));
  for (const kind of ["tenant", "owner"] as const) {
    const html = render(<TopupReadView view={view(kind)} locale="zh-TW" kind={kind} />), body = text(html);
    for (const s of ["退租結算", "押金實收NT$24,000", "扣款合計NT$27,000", "應補 NT$3,000・已補 NT$1,000", "11/20NT$1,000"]) {
      assert.ok(body.includes(s), `${kind} ${s}`); assert.ok(staffBody.includes(s), `staff ${s}`);
    }
    assert.doesNotMatch(html, /<button|<form|記錄已收|href=/);
    assert.ok(!body.includes("林小美"));
  }
});

test("MGT-151-AC3/AC5 sheet: required fields, warn over 應補 and still 確定; a failed save keeps input with 「再試一次」", () => {
  const props = { locale: "zh-TW" as const, currency: "TWD", minorUnit: 2, owedMinor: "300000", paidMinor: "100000", titleId: "t" };
  const plain = render(<TopupSheetForm {...props} amount="1000" date="2026-11-25" note="" saving={false} failed={false} />), plainText = text(plain);
  for (const s of ["記錄已收", "關閉", "金額（必填）", "日期（必填）", "備註（選填）", "確定", "取消"]) assert.ok(plainText.includes(s), s);
  assert.equal((plain.match(/ required=""/g) ?? []).length, 2, "amount and date are required, the note is not");
  assert.match(plain, /role="dialog"/); assert.match(plain, /aria-modal="true"/);
  assert.doesNotMatch(plainText, /比應補多收|沒有存成功/);
  assert.doesNotMatch(plain, /<select/);
  const over = text(render(<TopupSheetForm {...props} amount="2500" date="2026-11-25" note="轉帳" saving={false} failed={false} />));
  assert.ok(over.includes("比應補多收 NT$500，確定嗎？"));
  assert.ok(over.includes("確定") && !over.includes("再試一次"));
  const failedHtml = render(<TopupSheetForm {...props} amount="2500" date="2026-11-25" note="轉帳" saving={false} failed={true} />), failed = text(failedHtml);
  assert.ok(failed.includes("沒有存成功，請再試一次。"));
  assert.match(failedHtml, /data-testid="topup-confirm"[^>]*>再試一次</);
  for (const kept of ['value="2500"', 'value="2026-11-25"', 'value="轉帳"']) assert.ok(failedHtml.includes(kept), kept);
  const saving = render(<TopupSheetForm {...props} amount="1000" date="2026-11-25" note="" saving={true} failed={false} />);
  assert.match(saving, /disabled=""[^>]*data-testid="topup-confirm"/);
});

test("GS-02 read error: in place with 「再試一次」", () => {
  const html = render(<TopupError locale="zh-TW" retryHref={`/m/leases/${LEASE}/settlement`} />);
  assert.ok(text(html).includes("這裡暫時讀不到，請再試一次。再試一次"));
  assert.match(html, /role="alert"/);
});

test("reader: OFF never opens a transaction; pinned org/env; exact gateway args; strict DTO; denial is 403", async () => {
  assert.deepEqual(await depositTopupView(staff, LEASE, { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await depositTopupView(staff, LEASE, { v3: async () => { throw new Error("flag read failed"); }, transaction: never }), { state: "unavailable" });
  assert.deepEqual(await depositTopupView({ ...staff, role: "maintenance" }, LEASE, { v3: async () => true, transaction: never }), { state: "forbidden" });
  assert.deepEqual(await depositTopupView(staff, "../x", { v3: async () => true, transaction: never }), { state: "forbidden" });
  assert.deepEqual(await depositTopupView({ ...owner, sessionId: "nope" }, LEASE, { v3: async () => true, transaction: never }), { state: "forbidden" });
  for (const [session, kind] of [[staff, "staff"], [tenant, "tenant"], [owner, "owner"]] as const) {
    const seen: { sql: string; args?: unknown[] }[] = [];
    assert.deepEqual(await depositTopupView(session, LEASE, { v3: async () => true, transaction: client(view(kind), seen) }), { state: "ready", view: view(kind) });
    assert.match(seen[0].sql, /statement_timeout = '2s'/); assert.match(seen[1].sql, /lock_timeout = '1s'/);
    assert.deepEqual(seen[2].args, [ORG, "live"]);
    assert.equal(seen[3].sql, "SELECT app.mf3_topup_view($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::uuid) AS result");
    assert.deepEqual(seen[3].args, [ORG, ORG, "live", base.sessionId, kind, LEASE]);
  }
  assert.deepEqual(await depositTopupView(tenant, LEASE, { v3: async () => true, transaction: client(null, []) }), { state: "none" });
  for (const [session, bad] of [[staff, { ...view("staff"), paidMinor: "90000" }], [tenant, { ...view("tenant"), canRecord: true }], [tenant, { ...view("tenant"), tenant: "林小美" }], [owner, { ...view("staff") }],
    [staff, { ...view("staff"), owedMinor: "0" }], [staff, { ...view("staff"), entries: [{ id: E1, amountMinor: "100000", receivedOn: "2026-11-20", note: "x" }] }],
    [staff, { ...view("staff"), leaseId: SETTLE }]] as const)
    assert.deepEqual(await depositTopupView(session, LEASE, { v3: async () => true, transaction: client(bad, []) }), { state: "unavailable" }, JSON.stringify(bad));
  assert.throws(() => parseTopupView({ ...view("staff"), currency: "twd" }, LEASE, "staff"));
  // Settlement figures may be any bigint; a paid total or entry above the one cap is rejected, never shown.
  assert.ok(parseTopupView({ ...view("staff"), depositMinor: "9223372036854775000", deductionMinor: "9223372036854775807", owedMinor: "807" }, LEASE, "staff"));
  assert.throws(() => parseTopupView({ ...view("staff"), paidMinor: "1000000000000001", entries: [{ id: E1, amountMinor: "1000000000000001", receivedOn: "2026-11-20" }] }, LEASE, "staff"));
  const deny = (async () => { throw Object.assign(new Error("denied"), { cause: { code: "42501" } }); }) as never;
  assert.deepEqual(await depositTopupView(owner, LEASE, { v3: async () => true, transaction: deny }), { state: "forbidden" });
});

test("writer: staff only; invalid input never reaches the gateway; statuses map; same key is passed through", async () => {
  const input = { leaseId: LEASE, settlementId: SETTLE, requestId: "00000000-0000-4000-8000-0000000000f1", amountMinor: "250000", receivedOn: "2026-11-05", note: " 轉帳 " };
  assert.deepEqual(await recordDepositTopup(tenant, input, { v3: async () => true, transaction: never }), { ok: false, reason: "forbidden" });
  assert.deepEqual(await recordDepositTopup(owner, input, { v3: async () => true, transaction: never }), { ok: false, reason: "forbidden" });
  assert.deepEqual(await recordDepositTopup({ ...staff, role: "maintenance" }, input, { v3: async () => true, transaction: never }), { ok: false, reason: "forbidden" });
  assert.deepEqual(await recordDepositTopup(staff, input, { v3: async () => false, transaction: never }), { ok: false, reason: "off" });
  const tomorrowAnywhere = new Date(Date.parse(`${latestLocalToday()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  for (const bad of [{ amountMinor: "0" }, { amountMinor: "1.5" }, { amountMinor: "1000000000000001" }, { receivedOn: tomorrowAnywhere }, { receivedOn: "2026-02-30" }, { requestId: "x" }, { note: "x".repeat(501) }, { settlementId: "x" }])
    assert.deepEqual(await recordDepositTopup(staff, { ...input, ...bad }, { v3: async () => true, transaction: never }), { ok: false, reason: "invalid" }, JSON.stringify(bad));
  const seen: { sql: string; args?: unknown[] }[] = [];
  const ok = await recordDepositTopup({ ...staff, role: "accountant" }, input, { v3: async () => true,
    transaction: client({ status: "recorded", topupId: E1, replayed: false, paidMinor: "350000", overMinor: "50000", owedMinor: "300000" }, seen) });
  assert.deepEqual(ok, { ok: true, paidMinor: "350000", overMinor: "50000", replayed: false });
  assert.deepEqual(seen[2].args, [ORG, "live"]);
  assert.match(seen[3].sql, /^SELECT app\.mf3_topup_record\(\$1::uuid,\$2::uuid,\$3::text,\$4::uuid,\$5::uuid,\$6::uuid,\$7::uuid,\$8::bigint,\$9::date,\$10::text\) AS result$/);
  assert.deepEqual(seen[3].args, [ORG, ORG, "live", base.sessionId, input.requestId, LEASE, SETTLE, "250000", "2026-11-05", "轉帳"]);
  for (const [status, reason] of [["disabled", "off"], ["invalid", "invalid"], ["conflict", "conflict"], ["unavailable", "failed"], ["weird", "failed"]])
    assert.deepEqual(await recordDepositTopup(staff, input, { v3: async () => true, transaction: client({ status }, []) }), { ok: false, reason });
  const deny = (async () => { throw Object.assign(new Error("denied"), { cause: { code: "42501" } }); }) as never;
  assert.deepEqual(await recordDepositTopup(staff, input, { v3: async () => true, transaction: deny }), { ok: false, reason: "forbidden" });
  const boom = (async () => { throw new Error("connection reset"); }) as never;
  assert.deepEqual(await recordDepositTopup(staff, input, { v3: async () => true, transaction: boom }), { ok: false, reason: "failed" });
});

test("wiring: pages exist only under brand_v3; the action checks consent; nothing outbound; touch targets ≥44px", () => {
  for (const page of ["src/app/m/leases/[id]/settlement/page.tsx", "src/app/o/leases/[id]/settlement/page.tsx", "src/app/t/settlement/page.tsx"]) {
    const src = read(page);
    assert.match(src, /brandV3EnabledForOrg\(session\.orgId\)\)\) notFound\(\)|!\(await brandV3EnabledForOrg\(session\.orgId\)\)\) notFound\(\)/);
    assert.match(src, /\/brand\/v3\/topup\.css/);
  }
  assert.match(read("src/server/mf3-deposit-topup-actions.ts"), /^"use server";[\s\S]*await requireCurrentConsent\(\);/);
  const server = read("src/server/mf3-deposit-topup.ts");
  assert.match(server, /guardEffectiveSession\(input, null\);\n  if \(session\.kind === "staff"\) assertPerm\(session, "pay\.record"\);/);
  assert.match(server, /assertPerm\(session, "pay\.record"\)/);
  for (const src of [server, read("src/components/v3/topup/topup.tsx"), read("src/components/v3/topup/topup-sheet.tsx"), read("supabase/migrations/20261116140000_mf3_deposit_topup.sql")])
    assert.doesNotMatch(src, /notification|line-push|sendEmail|outbox|resend|fetch\(|method:/i);
  const css = read("public/brand/v3/topup.css");
  for (const rule of [/\.v3-topup \.btn \{ min-height:44px; min-width:44px; \}/, /\.v3-topup-sheet \.btn \{ min-height:44px; min-width:44px; \}/,
    /\.v3-topup-field input \{ min-height:44px;/, /\.v3-topup-crumb a \{[^}]*min-height:44px; min-width:44px;/]) assert.match(css, rule);
});

// Stateful TopupSheet rules (MGT-151-AC3/AC5), through the controller the component is wired to.
const T = { leaseId: LEASE, settlementId: SETTLE };
const C = { amountMinor: "250000", receivedOn: "2026-11-05", note: "轉帳" };
function keys() { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; }
/** The gateway's key semantics: same key + same content replays, same key + other content conflicts. */
function server(options: { loseReply?: number[]; invalidAfter?: string } = {}) {
  const stored = new Map<string, string>(), calls: TopupInput[] = [];
  return { calls, stored, submit: async (input: TopupInput): Promise<TopupResult> => {
    calls.push(input);
    // Like the gateway: input checks (e.g. a date after the org-local today) run before the key lookup.
    if (options.invalidAfter && input.receivedOn > options.invalidAfter) return { ok: false, reason: "invalid" };
    const content = JSON.stringify([input.leaseId, input.settlementId, input.amountMinor, input.receivedOn, input.note ?? null]);
    const prior = stored.get(input.requestId);
    if (prior !== undefined && prior !== content) return { ok: false, reason: "conflict" };
    stored.set(input.requestId, content);
    if (options.loseReply?.includes(calls.length)) throw new Error("reply lost after commit");
    return { ok: true, paidMinor: "250000", overMinor: "0", replayed: prior !== undefined };
  } };
}
const stub = (results: (TopupResult | Error)[]) => {
  const calls: TopupInput[] = [];
  return { calls, submit: async (input: TopupInput) => { calls.push(input); const r = results.shift()!; if (r instanceof Error) throw r; return r; } };
};
const contentOf = (st: TopupSheetState) => ({ amountMinor: String(Number(st.amount) * 100), receivedOn: st.date, note: st.note || null });
async function attempt(st: TopupSheetState, sender: ReturnType<typeof createTopupSender>) {
  st = topupSheetReducer(st, { type: "start", signature: topupSignature(contentOf(st)) });
  const outcome = await sender.send(T, st.key!, contentOf(st));
  assert.notEqual(outcome, "busy");
  return { outcome, state: topupSheetReducer(st, { type: "done", outcome: outcome as Exclude<typeof outcome, "busy"> }) };
}

test("sheet: one key per unsaved entry — a retry and an edit after a failure keep the same key", async () => {
  const next = keys(), api = stub([{ ok: false, reason: "failed" }, { ok: false, reason: "failed" }, { ok: true, paidMinor: "1", overMinor: "0", replayed: false }]);
  const sender = createTopupSender(api.submit);
  let st = topupSheetReducer(closedSheet, { type: "open", today: "2026-11-05", key: next() });
  st = topupSheetReducer(st, { type: "edit", field: "amount", value: "2500" });
  let r = await attempt(st, sender);
  assert.equal(r.outcome, "retry");
  st = topupSheetReducer(r.state, { type: "edit", field: "note", value: "轉帳" });
  r = await attempt(st, sender);
  assert.equal(api.calls[1].requestId, api.calls[0].requestId, "an edit after a failure keeps the SAME key");
  r = await attempt(r.state, sender);
  assert.equal(r.outcome, "saved");
  assert.equal(new Set(api.calls.map(c => c.requestId)).size, 1);
  assert.deepEqual(r.state, closedSheet);
  // The next entry gets a new key.
  const fresh = topupSheetReducer(r.state, { type: "open", today: "2026-11-05", key: next() });
  assert.notEqual(fresh.key, api.calls[0].requestId);
});

test("sheet: lost reply, then an edit and resend — same key, the server answers conflict, the sheet closes and refreshes (no second record)", async () => {
  const next = keys(), api = server({ loseReply: [1] });
  const sender = createTopupSender(api.submit);
  let st = topupSheetReducer(closedSheet, { type: "open", today: "2026-11-05", key: next() });
  st = topupSheetReducer(st, { type: "edit", field: "amount", value: "2500" });
  let r = await attempt(st, sender);
  assert.equal(r.outcome, "retry", "the commit happened but the reply was lost");
  assert.deepEqual([r.state.failed, r.state.amount], [true, "2500"]);
  st = topupSheetReducer(r.state, { type: "edit", field: "note", value: "轉帳" });
  r = await attempt(st, sender);
  assert.equal(api.calls[1].requestId, api.calls[0].requestId);
  assert.equal(r.outcome, "landed", "conflict means the earlier save landed: the TopupSheet refreshes");
  assert.deepEqual(r.state, { ...closedSheet, dupNotice: true }, "the sheet closes; the edit was not saved, so the toast shows");
  assert.equal(api.stored.size, 1, "recorded once");
  // A resend without an edit instead replays the stored row.
  const api2 = server({ loseReply: [1] }), s2 = createTopupSender(api2.submit);
  let st2 = topupSheetReducer(topupSheetReducer(closedSheet, { type: "open", today: "2026-11-05", key: next() }), { type: "edit", field: "amount", value: "2500" });
  st2 = (await attempt(st2, s2)).state;
  const again = await attempt(st2, s2);
  assert.equal(again.outcome, "saved");
  assert.equal(api2.stored.size, 1);
});

test("sheet: lost reply, then a resend the server rejects as invalid, then a corrected resend — still one key, no second record", async () => {
  const next = keys(), api = server({ loseReply: [1], invalidAfter: "2026-11-05" });
  const sender = createTopupSender(api.submit);
  let st = topupSheetReducer(closedSheet, { type: "open", today: "2026-11-05", key: next() });
  st = topupSheetReducer(st, { type: "edit", field: "amount", value: "2500" });
  let r = await attempt(st, sender);
  assert.equal(r.outcome, "retry", "the commit happened but the reply was lost");
  // The browser is a day ahead of the org: the edited date passes the client check but the gateway says invalid.
  st = topupSheetReducer(r.state, { type: "edit", field: "date", value: "2026-11-06" });
  r = await attempt(st, sender);
  assert.equal(r.outcome, "invalid");
  assert.equal(r.state.key, api.calls[0].requestId, "invalid keeps the key");
  st = topupSheetReducer(r.state, { type: "edit", field: "date", value: "2026-11-05" });
  r = await attempt(st, sender);
  assert.equal(api.calls[2].requestId, api.calls[0].requestId);
  assert.ok(r.outcome === "saved" || r.outcome === "landed", r.outcome);
  assert.equal(api.stored.size, 1, "recorded once");
});

test("sheet: a real reopen (new sheet and sender instance from the retained pending entry) keeps the key and the input", async () => {
  const next = keys(), api = stub([{ ok: false, reason: "failed" }, { ok: true, paidMinor: "1", overMinor: "0", replayed: true }]);
  let st = topupSheetReducer(closedSheet, { type: "open", today: "2026-11-05", key: next() });
  st = topupSheetReducer(topupSheetReducer(st, { type: "edit", field: "amount", value: "2500" }), { type: "edit", field: "note", value: "轉帳" });
  st = (await attempt(st, createTopupSender(api.submit))).state;
  const retained = topupSheetReducer(st, { type: "close" });
  assert.equal(retained.open, false);
  const reopened = topupSheetReducer(retained, { type: "open", today: "2026-11-06", key: next() });
  assert.deepEqual([reopened.open, reopened.amount, reopened.date, reopened.note, reopened.failed, reopened.key],
    [true, "2500", "2026-11-05", "轉帳", true, retained.key], "input, failure and key survive; the offered new key is ignored");
  const r = await attempt(reopened, createTopupSender(api.submit));
  assert.equal(r.outcome, "saved");
  assert.equal(api.calls[1].requestId, api.calls[0].requestId);
});

test("sheet: double submit is refused; a thrown error is a retry; invalid keeps the key; refused input keeps the key", async () => {
  let release!: (r: TopupResult) => void;
  const calls: TopupInput[] = [];
  const sender = createTopupSender(input => { calls.push(input); return new Promise(res => { release = res; }); });
  const first = sender.send(T, "k", C);
  assert.equal(sender.busy, true);
  assert.equal(await sender.send(T, "k", C), "busy");
  assert.equal(calls.length, 1);
  release({ ok: true, paidMinor: "1", overMinor: "0", replayed: false });
  assert.equal(await first, "saved");
  assert.equal(sender.busy, false);
  const thrown = createTopupSender(stub([new Error("network down")]).submit);
  assert.equal(await thrown.send(T, "k", C), "retry");
  assert.equal(thrown.busy, false);
  for (const [reason, outcome] of [["invalid", "invalid"], ["conflict", "landed"], ["off", "retry"], ["forbidden", "retry"], ["failed", "retry"]] as const)
    assert.equal(await createTopupSender(stub([{ ok: false, reason }]).submit).send(T, "k", C), outcome, reason);
  const base = { ...closedSheet, open: true, amount: "1", date: "2026-11-05", key: "k1" };
  assert.deepEqual(topupSheetReducer({ ...base, saving: true }, { type: "done", outcome: "invalid" }), { ...base, failed: true }, "invalid keeps the key (an earlier send may have landed)");
  assert.deepEqual(topupSheetReducer({ ...base, saving: true }, { type: "done", outcome: "retry" }), { ...base, failed: true });
  assert.deepEqual(topupSheetReducer(base, { type: "refused" }), { ...base, failed: true }, "over cap / future date: not sent, same key");
  const saving = { ...base, saving: true };
  assert.equal(topupSheetReducer(saving, { type: "close" }), saving);
  assert.equal(topupSheetReducer(saving, { type: "edit", field: "amount", value: "9" }), saving);
});

test("sheet wiring and copy: every failure reads 「沒有存成功，請再試一次。」 + 「再試一次」; 確定 only as the normal confirm", () => {
  const src = read("src/components/v3/topup/topup-sheet.tsx");
  assert.match(src, /useReducer\(topupSheetReducer, closedSheet\)/);
  assert.match(src, /sender\.current!\.send\(\{ leaseId, settlementId \}, state\.key,/);
  assert.match(src, /dispatch\(\{ type: "open", today: localToday\(\), key: newRequest\(\) \}\)/);
  assert.match(src, /dispatch\(\{ type: "done", outcome \}\);/);
  assert.doesNotMatch(src, /nextKey/);
  assert.match(src, /if \(outcome === "saved" \|\| outcome === "landed"\) router\.refresh\(\);/);
  assert.match(src, /dispatch\(\{ type: "refused" \}\)/);
  assert.match(src, /onKeyDown=\{event => trapTab\(event, sheet\.current\)\}/);
  assert.match(src, /else if \(wasOpen\.current\) opener\.current\?\.focus\(\);/);
  assert.match(src, /\{props\.failed \? c\.retry : c\.confirm\}/);
  assert.doesNotMatch(src, /retry=|"fix"/);
  const props = { locale: "zh-TW" as const, currency: "TWD", minorUnit: 2, owedMinor: "300000", paidMinor: "100000", titleId: "t" };
  const quiet = render(<TopupSheetForm {...props} amount="1000" date="2026-11-05" note="" saving={false} failed={false} />);
  assert.match(quiet, /<p class="v3-topup-warn" role="status" aria-live="polite" data-testid="topup-over"><\/p>/);
  assert.match(quiet, /<p class="v3-topup-fail" role="alert" data-testid="topup-failed"><\/p>/);
  assert.match(quiet, /data-testid="topup-confirm"[^>]*>確定</);
  const over = render(<TopupSheetForm {...props} amount="2500" date="2026-11-05" note="" saving={false} failed={false} />);
  assert.ok(text(over).includes("比應補多收 NT$500，確定嗎？") && /data-testid="topup-confirm"[^>]*>確定</.test(over));
  const failed = render(<TopupSheetForm {...props} amount="99999999999999" date="2026-11-05" note="轉帳" saving={false} failed={true} />);
  assert.ok(text(failed).includes("沒有存成功，請再試一次。"));
  assert.match(failed, /data-testid="topup-confirm"[^>]*>再試一次</);
  for (const kept of ['value="99999999999999"', 'value="2026-11-05"', 'value="轉帳"']) assert.ok(failed.includes(kept), kept);
  assert.match(render(<TopupSheetForm {...props} amount="1" date="2026-11-05" note="" saving={false} failed={false} today="2026-11-05" />), /max="2026-11-05"/);
  assert.match(read("public/brand/v3/topup.css"), /:is\(\.v3-topup-warn,\.v3-topup-fail\):empty \{ position:absolute;/);
});

test("MO-TOPUP-DUP: an edited entry that was already recorded closes, refreshes and shows the toast; unedited shows none", async () => {
  // Edited: lost reply on NT$2,500, then the date changes and the resend answers conflict.
  const next = keys(), api = server({ loseReply: [1] });
  const sender = createTopupSender(api.submit);
  let st = topupSheetReducer(topupSheetReducer(closedSheet, { type: "open", today: "2026-11-05", key: next() }), { type: "edit", field: "amount", value: "2500" });
  st = (await attempt(st, sender)).state;
  st = topupSheetReducer(st, { type: "edit", field: "date", value: "2026-11-04" });
  const edited = await attempt(st, sender);
  assert.equal(edited.outcome, "landed");
  assert.deepEqual(edited.state, { ...closedSheet, dupNotice: true });
  // Opening the sheet again dismisses the toast (no timer).
  const reopened = topupSheetReducer(edited.state, { type: "open", today: "2026-11-05", key: next() });
  assert.equal(reopened.dupNotice, false);
  assert.notEqual(reopened.key, api.calls[0].requestId, "a new entry after the landed one");
  // Unedited: every send with this key carried the same values; a conflict then shows nothing.
  const sameTwice = { ...closedSheet, open: true, amount: "2500", date: "2026-11-05", key: "k1", saving: true,
    sent: [topupSignature({ amountMinor: "250000", receivedOn: "2026-11-05", note: null }), topupSignature({ amountMinor: "250000", receivedOn: "2026-11-05", note: "  " })] };
  assert.deepEqual(topupSheetReducer(sameTwice, { type: "done", outcome: "landed" }), closedSheet, "unedited: no toast");
  const firstSend = { ...sameTwice, sent: [sameTwice.sent[0]] };
  assert.deepEqual(topupSheetReducer(firstSend, { type: "done", outcome: "landed" }), closedSheet, "a conflict on the first send: nothing was edited");
  // A note that differs only by spaces is the same value (the gateway trims it).
  assert.equal(topupSignature({ amountMinor: "1", receivedOn: "2026-11-05", note: " 轉帳 " }), topupSignature({ amountMinor: "1", receivedOn: "2026-11-05", note: "轉帳" }));
});

test("MO-TOPUP-DUP 取消: an entry never sent is cleared with its key; a sent, unconfirmed entry keeps its values and key", async () => {
  const next = keys();
  let st = topupSheetReducer(closedSheet, { type: "open", today: "2026-11-05", key: next() });
  st = topupSheetReducer(st, { type: "edit", field: "amount", value: "2500" });
  const neverSent = topupSheetReducer(st, { type: "close" });
  assert.deepEqual(neverSent, closedSheet, "never sent: cleared");
  const fresh = topupSheetReducer(neverSent, { type: "open", today: "2026-11-06", key: next() });
  assert.deepEqual([fresh.amount, fresh.date], ["", "2026-11-06"]);
  assert.notEqual(fresh.key, st.key, "a new key for the new entry");
  // Refused before sending (over the cap, a future date) is also never sent.
  const refused = topupSheetReducer(topupSheetReducer(st, { type: "refused" }), { type: "close" });
  assert.deepEqual(refused, closedSheet);
  // Sent, then failed: 取消 keeps the values and the key, and reopening brings them back.
  const api = stub([{ ok: false, reason: "failed" }]);
  const failed = (await attempt(st, createTopupSender(api.submit))).state;
  const kept = topupSheetReducer(failed, { type: "close" });
  assert.deepEqual([kept.open, kept.amount, kept.date, kept.key, kept.failed], [false, "2500", "2026-11-05", st.key, true]);
  const back = topupSheetReducer(kept, { type: "open", today: "2026-11-06", key: next() });
  assert.deepEqual([back.open, back.amount, back.date, back.key], [true, "2500", "2026-11-05", st.key]);
  assert.equal(topupSheetReducer({ ...failed, saving: true }, { type: "close" }).open, true, "no close while saving");
});

test("MO-TOPUP-DUP toast: the existing .toast, a mounted status region, approved copy, v3 colours", () => {
  const off = render(<TopupDupToast show={false} locale="zh-TW" />), on = render(<TopupDupToast show={true} locale="zh-TW" />);
  assert.equal(off, '<div class="toast v3-topup-toast" role="status" data-testid="topup-dup"></div>');
  assert.equal(on, '<div class="toast v3-topup-toast" role="status" data-testid="topup-dup">這筆已經記錄過了，剛剛的修改沒有存。</div>');
  assert.equal(brandV3TopupCopy("en").dup, "This was already recorded. Your latest changes were not saved.");
  const src = read("src/components/v3/topup/topup-sheet.tsx");
  assert.match(src, /<TopupDupToast show=\{state\.dupNotice\} locale=\{view\.locale\} \/>/);
  assert.match(src, /dispatch\(\{ type: "start", signature: topupSignature\(content\) \}\);/);
  assert.doesNotMatch(src, /setTimeout/, "no auto-hide timer");
  const css = read("public/brand/v3/topup.css");
  assert.match(css, /\.toast\.v3-topup-toast \{ top:5\.5rem; bottom:auto;[^}]*background:var\(--c-primary\); color:var\(--c-on-primary\);/);
  assert.match(css, /\.toast\.v3-topup-toast:empty \{[^}]*clip-path:inset\(50%\)/);
  assert.match(read("src/app/globals.css"), /^\.toast\{position:fixed;/m, "reuses the existing global .toast");
});
