import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED, parseAfter, parsePhoneHistory, phoneHistory, type PhoneHistoryRow } from "./b076a-phone-history";
import { PhoneHistoryView, phoneHistoryActor, phoneHistoryHref } from "../components/v3/m/tenants/phone-history";
import { phoneHistoryCopy } from "../i18n/lanes/brand-v3-phone-history";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// B-076a / mgr-history-direct (MGT-76-AC3/AC12). Synthetic data only; the batch 4 frame's sample rows.
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001", C = "00000000-0000-4000-8000-0000000000c1";
const staff: Session = { kind: "staff", role: "manager", orgId: ORG, liveOrgId: ORG, userId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const rows: PhoneHistoryRow[] = [
  { id: "42", occurredAt: "2026-11-16T18:05:00+00:00", at: "2026/11/16 10:05", status: "direct", actorRole: "manager", actorName: "王怡君", oldMasked: "0933‑•••‑456", newMasked: "0912‑•••‑678" },
  { id: "7", occurredAt: "2026-09-18T19:03:00+00:00", at: "2026/09/18 11:03", status: "direct", actorRole: "admin", actorName: "陳志明", oldMasked: null, newMasked: "0933‑•••‑456" },
];
const page = { tenant: "林小美", place: "幸福大樓 5F-2", rows, next: null };
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const never = (async () => { throw new Error("no transaction expected"); }) as never;
function client(result: unknown, seen: { sql: string; args?: unknown[] }[]) {
  return (async (_user: string, callback: (c: unknown) => Promise<unknown>) =>
    callback({ query: async (sql: string, args?: unknown[]) => { seen.push({ sql, args }); return { rows: sql.includes("app.b076a_") ? [{ result }] : [] }; } })) as never;
}

test("copy is verbatim: batch 4 new words, login-phone history copy, the frame header and the empty text", () => {
  const c = phoneHistoryCopy("zh-TW");
  assert.deepEqual([c.direct, c.by, c.empty], ["已直接更換", "{role} {name} 直接修改", "還沒有改號紀錄。"]);
  assert.deepEqual([c.title, c.time, c.status, c.actor, c.numbers, c.entry, c.back, c.none], ["改號紀錄", "時間", "狀態", "操作者", "號碼", "查看改號紀錄", "返回租客詳情", "尚未填寫"]);
  assert.deepEqual([c.titleWith, c.sub], ["改號紀錄・{name}", "{name} · {place}。號碼已遮罩。"]);
  assert.deepEqual(Object.keys(phoneHistoryCopy("en")).sort(), Object.keys(c).sort());
  for (const word of ["房東", "收款", "收租", "驗證"]) assert.equal(JSON.stringify(c).includes(word), false, word);
});

test("view: the frame's table, newest first, masked numbers, 尚未填寫 for no number, 返回租客詳情", () => {
  const html = renderToStaticMarkup(<PhoneHistoryView data={{ state: "ready", ...page }} id={C} locale="zh-TW" />), body = text(html);
  for (const s of ["改號紀錄・林小美", "林小美 · 幸福大樓 5F-2。號碼已遮罩。", "時間狀態操作者號碼",
    "2026/11/16 10:05已直接更換經理 王怡君 直接修改0933‑•••‑456 → 0912‑•••‑678",
    "2026/09/18 11:03已直接更換管理員 陳志明 直接修改尚未填寫 → 0933‑•••‑456", "返回租客詳情"]) assert.ok(body.includes(s), s);
  assert.match(html, new RegExp(`href="/m/tenants/${C}"`));
  assert.doesNotMatch(html, /<button|<form|下一頁/);
  const empty = text(renderToStaticMarkup(<PhoneHistoryView data={{ state: "ready", tenant: "林小美", place: null, rows: [], next: null }} id={C} locale="zh-TW" />));
  assert.ok(empty.includes("還沒有改號紀錄。") && empty.includes("號碼已遮罩。") && !empty.includes(" · "));
  const more = renderToStaticMarkup(<PhoneHistoryView data={{ state: "ready", ...page, next: "7" }} id={C} locale="zh-TW" />);
  assert.match(more, new RegExp(`href="/m/tenants/${C}/phone-history\\?after=7"[^>]*>下一頁<`));
  assert.ok(text(renderToStaticMarkup(<PhoneHistoryView data={{ state: "forbidden" }} id={C} locale="zh-TW" />)).includes("請管理者完成設定。"));
  const failed = renderToStaticMarkup(<PhoneHistoryView data={{ state: "unavailable" }} id={C} locale="zh-TW" />);
  assert.ok(text(failed).includes("資料載入失敗再試一次"));
  assert.match(failed, new RegExp(`href="${phoneHistoryHref(C).replace(/[?]/g, "\\?")}"`));
  assert.equal(phoneHistoryActor({ actorRole: "manager", actorName: null }, "zh-TW"), "經理 直接修改");
});

test("reader: OFF never opens a transaction; P-ACC/P-MNT/portals/bad ids are 403; pinned org/env; exact args; strict DTO", async () => {
  assert.deepEqual(await phoneHistory(staff, C, {}, { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await phoneHistory(staff, C, {}, { v3: async () => { throw new Error("flag read failed"); }, transaction: never }), { state: "unavailable" });
  for (const actor of [{ ...staff, role: "accountant" as const }, { ...staff, role: "maintenance" as const }, { ...staff, kind: "tenant" as const, role: null },
    { ...staff, kind: "owner" as const, role: null }, { ...staff, needsSandbox: true }, { ...staff, sessionId: "x" }])
    assert.deepEqual(await phoneHistory(actor, C, {}, { v3: async () => true, transaction: never }), { state: "forbidden" }, JSON.stringify(actor.role));
  assert.deepEqual(await phoneHistory(staff, "../x", {}, { v3: async () => true, transaction: never }), { state: "forbidden" });
  const seen: { sql: string; args?: unknown[] }[] = [];
  assert.deepEqual(await phoneHistory(staff, C, { after: "42" }, { v3: async () => true, transaction: client(page, seen) }), { state: "ready", ...page });
  assert.match(seen[0].sql, /statement_timeout = '2s'/); assert.match(seen[1].sql, /lock_timeout = '1s'/);
  assert.deepEqual(seen[2].args, [ORG, "live"]);
  assert.equal(seen[3].sql, "SELECT app.b076a_phone_history($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::bigint,$7::integer) AS result");
  assert.deepEqual(seen[3].args, [ORG, ORG, "live", staff.sessionId, C, "42", 20]);
  assert.deepEqual(await phoneHistory(staff, C, {}, { v3: async () => true, transaction: client(null, []) }), { state: "off" });
  // A full or unexpected number shape never renders: the whole page is unavailable instead.
  for (const bad of [{ ...rows[0], newMasked: "0912345678" }, { ...rows[0], oldMasked: "+886933123456" }, { ...rows[0], status: "verified" },
    { ...rows[0], actorRole: "accountant" }, { ...rows[0], phone: "x" }, { ...rows[0], at: "11/16" }])
    assert.deepEqual(await phoneHistory(staff, C, {}, { v3: async () => true, transaction: client({ ...page, rows: [bad] }, []) }), { state: "unavailable" }, JSON.stringify(bad));
  const deny = (async () => { throw Object.assign(new Error("denied"), { cause: { code: "42501" } }); }) as never;
  assert.deepEqual(await phoneHistory(staff, C, {}, { v3: async () => true, transaction: deny }), { state: "forbidden" });
});

test("helpers: masks, cursor and parser", () => {
  for (const ok of ["0933‑•••‑456", "•••‑•••‑123"]) assert.match(ok, MASKED);
  for (const bad of ["0933-123-456", "0933‑123‑456", "+886933123456", "•••‑•••‑1234"]) assert.doesNotMatch(bad, MASKED);
  assert.equal(parseAfter("42"), "42");
  for (const bad of ["0", "-1", "4a", ["42"], undefined]) assert.equal(parseAfter(bad), undefined);
  assert.equal(parsePhoneHistory(null), null);
  assert.throws(() => parsePhoneHistory({ ...page, next: "x" }));
});

test("wiring: route under brand_v3 with consent; link only when the reader admits; B-017 map; no outbound", () => {
  const route = read("src/app/m/tenants/[id]/phone-history/page.tsx");
  assert.match(route, /await requireCurrentConsent\(undefined, "page"\);/);
  assert.match(route, /if \(!\(await brandV3EnabledForOrg\(session\.orgId\)\)\) notFound\(\);/);
  assert.match(route, /if \(data\.state === "off"\) notFound\(\);/);
  assert.match(read("src/components/v3/m/tenants/tenant-one.tsx"), /\{data\.phoneHistory && <Link className="v3-tenant-one-history" href=\{phoneHistoryHref\(id\)\}/);
  assert.equal((JSON.parse(read("src/server/b017-entry-permissions.json")) as Record<string, unknown>)["src/server/b076a-phone-history.ts#phoneHistory"], "tenants.contact");
  const server = read("src/server/b076a-phone-history.ts");
  assert.match(server, /OPEN: only B-015 staff edits are listed/);
  assert.doesNotMatch(server, /fetch\(|sms|twilio|notification/i);
  assert.match(read("public/brand/v3/tenants.css"), /\.v3-tenant-one-history \{ display:inline-flex; align-items:center; min-height:44px; min-width:44px;/);
});
