import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { depositTopupView, parseTopupView, recordDepositTopup, type TopupView } from "./mf3-deposit-topup";
import { TopupError, TopupReadView, TopupStaffView } from "../components/v3/topup/topup";
import { TopupSheetForm } from "../components/v3/topup/topup-sheet";
import { brandV3TopupCopy } from "../i18n/lanes/brand-v3-topup";
import { parseTopupAmount, topupDay, topupMoney, topupOver, validTopupDate } from "../lib/deposit-topup";
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
  assert.equal(topupMoney("1250", "USD", 2), "USD 12.5");
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
  assert.doesNotMatch(plain, /topup-over|topup-failed|<select/);
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
  const deny = (async () => { throw Object.assign(new Error("denied"), { cause: { code: "42501" } }); }) as never;
  assert.deepEqual(await depositTopupView(owner, LEASE, { v3: async () => true, transaction: deny }), { state: "forbidden" });
});

test("writer: staff only; invalid input never reaches the gateway; statuses map; same key is passed through", async () => {
  const input = { leaseId: LEASE, settlementId: SETTLE, requestId: "00000000-0000-4000-8000-0000000000f1", amountMinor: "250000", receivedOn: "2026-11-25", note: " 轉帳 " };
  assert.deepEqual(await recordDepositTopup(tenant, input, { v3: async () => true, transaction: never }), { ok: false, reason: "forbidden" });
  assert.deepEqual(await recordDepositTopup(owner, input, { v3: async () => true, transaction: never }), { ok: false, reason: "forbidden" });
  assert.deepEqual(await recordDepositTopup({ ...staff, role: "maintenance" }, input, { v3: async () => true, transaction: never }), { ok: false, reason: "forbidden" });
  assert.deepEqual(await recordDepositTopup(staff, input, { v3: async () => false, transaction: never }), { ok: false, reason: "off" });
  for (const bad of [{ amountMinor: "0" }, { amountMinor: "1.5" }, { amountMinor: "10000000000000001" }, { receivedOn: "2026-02-30" }, { requestId: "x" }, { note: "x".repeat(501) }, { settlementId: "x" }])
    assert.deepEqual(await recordDepositTopup(staff, { ...input, ...bad }, { v3: async () => true, transaction: never }), { ok: false, reason: "invalid" }, JSON.stringify(bad));
  const seen: { sql: string; args?: unknown[] }[] = [];
  const ok = await recordDepositTopup({ ...staff, role: "accountant" }, input, { v3: async () => true,
    transaction: client({ status: "recorded", topupId: E1, replayed: false, paidMinor: "350000", overMinor: "50000", owedMinor: "300000" }, seen) });
  assert.deepEqual(ok, { ok: true, paidMinor: "350000", overMinor: "50000", replayed: false });
  assert.deepEqual(seen[2].args, [ORG, "live"]);
  assert.match(seen[3].sql, /^SELECT app\.mf3_topup_record\(\$1::uuid,\$2::uuid,\$3::text,\$4::uuid,\$5::uuid,\$6::uuid,\$7::uuid,\$8::bigint,\$9::date,\$10::text\) AS result$/);
  assert.deepEqual(seen[3].args, [ORG, ORG, "live", base.sessionId, input.requestId, LEASE, SETTLE, "250000", "2026-11-25", "轉帳"]);
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
