import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import * as auditRead from "./audit-read";
import { encodeCursor, type RawAudit } from "./audit-read";
import {
  AUDIT_V3_ITEMS,
  PLAIN_FIELDS,
  auditV3Href,
  auditV3PageQuery,
  auditV3Read,
  auditV3When,
  itemOfTable,
  parseAuditV3,
  presentAuditV3,
  type AuditV3Page,
  type AuditV3PageInput,
  type RawAuditV3,
} from "./b073-audit";
import * as perms from "./perms";
import { crumbFor } from "./nav-v3";
import { brandV3AuditCopy, fillAudit } from "../i18n/lanes/brand-v3-r5-audit";
import { AuditError, AuditLoading, AuditView, entryText } from "../components/v3/m/settings/audit";
import type { OrgRole, Session } from "./types";

// B-073 / R5-AUDIT (設定 › 操作紀錄, company-wide part of MGT-136: AC2, AC3, AC4, AC5). Synthetic data only; no
// database (the integration test covers RLS, cross-org and the SQL); nothing outbound.
const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const BEFORE = "e4d9b6aed0ccdeb123a3e5f3f0e360f62539f038"; // origin/main before this slice (R5-TEAM merged)
const baseline = (p: string) => execFileSync("git", ["show", `${BEFORE}:${p}`], { encoding: "utf8" });
const ORG = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000004";
const staff = (role: OrgRole, locale: "zh-TW" | "en" = "zh-TW", calendar: "gregorian" | "roc" = "gregorian"): Session => ({ kind: "staff", role, orgId: ORG, liveOrgId: ORG,
  userId: ME, sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic",
  email: "fixture@example.invalid", environment: "live", locale, calendar, leaseId: null });
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const NOW = Date.parse("2026-11-17T12:00:00Z");

let seq = 1000;
function raw(over: Partial<RawAuditV3> = {}): RawAuditV3 {
  seq += 1;
  return {
    id: String(seq), occurred_key: "2026-11-14T07:02:00.000000Z", occurred_at: "2026-11-14T07:02:00Z", actor_name: "陳志明", has_actor: true,
    table_name: "leases", row_id: "10000000-0000-4000-8000-0000000000c1", action: "update", event_type: null, changed_cols: ["rent_amount_minor"],
    reason: null, plain_col: null, plain_old: null, plain_new: null, plain_currency: null, ...over,
  } as RawAuditV3;
}
const leaseHit = { text: "信義路四段 120 號 2 樓" };

test("MGT-136 copy: zh-TW verbatim from the approved frame (PR-018); GS-02 state lines; EN has every key", () => {
  const zh = brandV3AuditCopy("zh-TW"), en = brandV3AuditCopy("en");
  assert.equal(zh.lead, "操作紀錄：全公司誰改了什麼，可以依人、日期、項目找。");
  assert.equal(zh.allPeople, "全部的人"); assert.equal(zh.allItems, "全部項目");
  assert.deepEqual([zh.itemLease, zh.itemPayment, zh.itemUnit], ["租約", "繳款", "單位"]);
  assert.equal(zh.next, "下一頁"); assert.equal(zh.prev, "上一頁");
  assert.equal(zh.noMatch, "找不到符合的紀錄"); assert.equal(zh.clear, "清除篩選");
  assert.equal(zh.readFailed, "這裡暫時讀不到，請再試一次。"); assert.equal(zh.retry, "再試一次");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const value of Object.values(en)) assert.ok(value && !/[一-鿿]/.test(value), value);
  // The frame's three entries, character for character.
  assert.equal(fillAudit("zh-TW", zh.changed, { who: "陳志明", record: "信義路四段 120 號 2 樓", field: "租金", from: "NT$18,000", to: "NT$18,500" })
    + fillAudit("zh-TW", zh.reason, { reason: "續約調漲" }), "陳志明把信義路四段 120 號 2 樓的租金從 NT$18,000 改成 NT$18,500・原因：續約調漲");
  assert.equal(fillAudit("zh-TW", zh.changedQuoted, { who: "王怡君", record: "民生 3F 房間 A", field: "狀態", from: "招租中", to: "已出租" }),
    "王怡君把民生 3F 房間 A 的狀態從「招租中」改成「已出租」");
  assert.equal(fillAudit("zh-TW", zh.itemTime, { item: "租約", when: "11/14 15:02" }), "租約・11/14 15:02");
  assert.equal(fillAudit("zh-TW", zh.changed, { who: "Synthetic admin", record: "A", field: "租金", from: "1", to: "2" }), "Synthetic admin 把 A 的租金從 1 改成 2");
});

test("MGT-136-AC2 filters: person, Taipei days and item from GET params; junk is dropped; today's record filter maps to its item", () => {
  const cursor = encodeCursor("2026-11-14T07:02:00.000000Z", "42");
  assert.deepEqual(parseAuditV3({ user: OTHER, from: "2026-11-01", to: "2026-11-15", item: "lease", cursor }),
    { actorId: OTHER, from: "2026-11-01", to: "2026-11-15", item: "lease", cursor, before: null });
  assert.deepEqual(parseAuditV3({ user: "x", from: "11/01", to: "2026-1-1", item: "nope", cursor: "junk", before: "junk" }),
    { actorId: null, from: null, to: null, item: null, cursor: null, before: null });
  assert.equal(parseAuditV3({ record: "rooms" }).item, "unit");
  assert.equal(parseAuditV3({ record: "payments", item: "lease" }).item, "lease");
  assert.equal(parseAuditV3({ record: "contacts" }).item, "contacts");
  // 下一頁 wins over 上一頁 when both arrive; repeated params (arrays) are ignored.
  assert.deepEqual([parseAuditV3({ cursor, before: cursor }).cursor, parseAuditV3({ cursor, before: cursor }).before], [cursor, null]);
  assert.equal(parseAuditV3({ user: [OTHER, OTHER] as unknown as string }).actorId, null);
  const filters = parseAuditV3({ user: OTHER, from: "2026-11-01", item: "unit" });
  assert.equal(auditV3Href(filters), `/m/audit?user=${OTHER}&from=2026-11-01&item=unit`);
  assert.equal(auditV3Href(filters, { cursor: "c" }), `/m/audit?user=${OTHER}&from=2026-11-01&item=unit&cursor=c`);
  assert.equal(auditV3Href(filters, { before: "b" }), `/m/audit?user=${OTHER}&from=2026-11-01&item=unit&before=b`);
  assert.equal(auditV3Href(parseAuditV3({})), "/m/audit");
  // Items: the frame's three kinds first, then every other audited table once, by today's record name.
  assert.deepEqual(AUDIT_V3_ITEMS.slice(0, 3).map(item => item.id), ["lease", "payment", "unit"]);
  const tables = AUDIT_V3_ITEMS.flatMap(item => item.tables);
  assert.deepEqual([...tables].sort(), [...auditRead.AUDIT_TABLES].sort());
  assert.equal(itemOfTable("lease_charges"), "lease"); assert.equal(itemOfTable("payment_allocations"), "payment"); assert.equal(itemOfTable("organizations"), "organizations");
});

test("MGT-136-AC2 plain words: one named field changed → 「{誰}把{什麼}從 {舊} 改成 {新}」 in today's formats", () => {
  const admin = staff("admin");
  const rent = presentAuditV3(raw({ plain_col: "rent_amount_minor", plain_old: "1800000", plain_new: "1850000", plain_currency: "TWD", reason: "續約調漲" }), leaseHit, admin, NOW);
  assert.equal(entryText("zh-TW", rent), "陳志明把信義路四段 120 號 2 樓的租金從 NT$18,000 改成 NT$18,500・原因：續約調漲");
  assert.equal(rent.item, "租約"); assert.equal(rent.when, "11/14 15:02");
  const status = presentAuditV3(raw({ changed_cols: ["status"], plain_col: "status", plain_old: "active", plain_new: "terminated" }), leaseHit, admin, NOW);
  assert.equal(entryText("zh-TW", status), "陳志明把信義路四段 120 號 2 樓的狀態從「生效中」改成「提前結束」");
  const end = presentAuditV3(raw({ changed_cols: ["end_date", "updated_at"], plain_col: "end_date", plain_old: "2026-12-31", plain_new: "2027-06-30" }), leaseHit, staff("admin", "zh-TW", "roc"), NOW);
  assert.match(entryText("zh-TW", end), /結束日從 民國 115 年 12 月 31 日 改成 民國 116 年 6 月 30 日$/);
  const room = presentAuditV3(raw({ table_name: "rooms", changed_cols: ["label"], plain_col: "label", plain_old: "A", plain_new: "B" }), { text: "民生 3F" }, admin, NOW);
  assert.equal(entryText("zh-TW", room), "陳志明把民生 3F 的標籤從「A」改成「B」");
  assert.equal(room.item, "單位");
  const role = presentAuditV3(raw({ table_name: "org_members", actor_name: "", changed_cols: ["role"], plain_col: "role", plain_old: "manager", plain_new: "admin" }), { text: "王怡君", href: "/m/team" }, admin, NOW);
  assert.equal(entryText("zh-TW", role), "成員把王怡君的角色從「經理」改成「管理員」");
  const pay = presentAuditV3(raw({ table_name: "payments", actor_name: "林會計", changed_cols: ["status"], plain_col: "status", plain_old: "submitted", plain_new: "confirmed" }), { text: "陳怡君 民生 3F", href: "/m/leases/x" }, admin, NOW);
  assert.equal(pay.item, "繳款"); assert.match(entryText("zh-TW", pay), /^林會計把陳怡君 民生 3F 的狀態從「已送出」改成「已確認繳款」$/);
  const en = presentAuditV3(raw({ plain_col: "rent_amount_minor", plain_old: "1800000", plain_new: "1850000", plain_currency: "TWD" }), leaseHit, staff("admin", "en"), NOW);
  assert.equal(entryText("en", en), "陳志明 changed the Rent of 信義路四段 120 號 2 樓 from NT$18,000 to NT$18,500");
  // Older than this year: the year is written.
  assert.equal(auditV3When("2025-03-04 09:41", NOW), "2025/03/04 09:41");
  assert.equal(auditV3When("2026-11-10 09:41", NOW), "11/10 09:41");
});

test("MGT-136-AC4 masking: sensitive fields never get plain values; free text is masked as today; no ID, phone or email leaks", () => {
  const admin = staff("admin");
  const phone = presentAuditV3(raw({ table_name: "contacts", changed_cols: ["phone_e164"], reason: "改號 0912-345-678" }), { text: "王小明", tenant: true }, admin, NOW);
  assert.equal(phone.plain, null);
  assert.equal(entryText("zh-TW", phone), "陳志明 修改・租客 王小明・敏感欄位已遮罩・原因：改號 ••••••••••");
  assert.equal(phone.item, "租客");
  const name = presentAuditV3(raw({ table_name: "contacts", changed_cols: ["display_name"], plain_col: "display_name", plain_old: "王小明 A123456789", plain_new: "王小明 0912345678 a@example.com" }), { text: "王小明", tenant: true }, admin, NOW);
  const shown = entryText("zh-TW", name);
  assert.equal(shown, "陳志明把王小明的名稱從「王小明 ••••••••••」改成「王小明 •••••••••• ••••••••••」");
  assert.doesNotMatch(JSON.stringify([phone, name]), /A123456789|0912|example\.com/);
  // A sensitive or unnamed column alongside the named one: today's labels, never values.
  const mixed = presentAuditV3(raw({ changed_cols: ["rent_amount_minor", "number_hash"], plain_col: null }), leaseHit, admin, NOW);
  assert.equal(entryText("zh-TW", mixed), "陳志明 修改・租金・租約 信義路四段 120 號 2 樓・敏感欄位已遮罩");
  // The projection list is named, non-sensitive fields only.
  for (const key of Object.keys(PLAIN_FIELDS)) assert.equal(auditRead.sensitiveColumn(key.split(".")[1]), false, key);
});

test("MGT-136 legacy fallback: entries without approved plain words keep today's labels (action, fields, record)", () => {
  const admin = staff("admin");
  const cases: [Partial<RawAuditV3>, auditRead.RecordHit | null, string][] = [
    [{ action: "insert", changed_cols: null }, leaseHit, "陳志明 新增・租約 信義路四段 120 號 2 樓"],
    [{ action: "delete", changed_cols: null }, null, "陳志明 刪除・租約 已刪除"],
    [{ table_name: "auth_events", event_type: "sign_in", action: "insert", changed_cols: null, row_id: "x" }, null, "陳志明 登入・帳號"],
    [{ changed_cols: ["rent_amount_minor", "deposit_amount_minor"] }, leaseHit, "陳志明 修改・租金、押金・租約 信義路四段 120 號 2 樓"],
    [{ changed_cols: ["status"], plain_col: "status", plain_old: "active", plain_new: "mystery" }, leaseHit, "陳志明 修改・狀態・租約 信義路四段 120 號 2 樓"],
    [{ changed_cols: ["notes"], has_actor: false, actor_name: "" }, leaseHit, "系統 修改・備註・租約 信義路四段 120 號 2 樓"],
  ];
  for (const [over, hit, expected] of cases) assert.equal(entryText("zh-TW", presentAuditV3(raw(over), hit, admin, NOW)), expected, expected);
});

// In-memory keyset paging for the read logic (the SQL itself runs in the integration test).
function fakeLoad(rows: RawAuditV3[], calls: AuditV3PageInput[] = []) {
  const desc = [...rows].sort((a, b) => b.occurred_key.localeCompare(a.occurred_key) || Number(b.id) - Number(a.id));
  return async (_session: Session, input: AuditV3PageInput) => {
    calls.push(input);
    const key = (row: RawAuditV3) => `${row.occurred_key}|${row.id.padStart(19, "0")}`;
    const at = input.cursor ? `${input.cursor.at}|${input.cursor.id.padStart(19, "0")}` : null;
    let list = desc.filter(row => !input.tables || input.tables.includes(row.table_name));
    if (input.direction === "newer") list = list.filter(row => !at || key(row) > at).reverse();
    else list = list.filter(row => !at || key(row) < at);
    return { rows: list.slice(0, input.limit), actors: [{ id: OTHER, name: "王怡君 0912-345-678" }], hits: new Map() };
  };
}
const thirty = Array.from({ length: 30 }, (_, i) => raw({ id: String(5000 + i), occurred_key: `2026-11-${String(1 + i).padStart(2, "0")}T01:00:00.000000Z`, occurred_at: `2026-11-${String(1 + i).padStart(2, "0")}T01:00:00Z`, changed_cols: ["notes"] }));

test("MGT-136-AC3 permission: only an admin reads; others (and a custom role without audit) are forbidden before any read", async () => {
  let reads = 0;
  const load = async () => { reads += 1; return { rows: [] as RawAudit[], actors: [], hits: new Map() }; };
  for (const role of ["manager", "accountant", "maintenance"] as OrgRole[]) assert.deepEqual(await auditV3Read(staff(role), {}, { load }), { state: "forbidden" }, role);
  const custom = staff("admin");
  custom.customRole = { orgId: ORG, userId: ME, sessionId: custom.sessionId, nativeRole: "admin", keys: ["settings.edit"], photos: false, audit: false };
  assert.deepEqual(await auditV3Read(custom, {}, { load }), { state: "forbidden" });
  assert.deepEqual(await auditV3Read({ ...staff("admin"), kind: "owner" }, {}, { load }), { state: "forbidden" });
  assert.equal(reads, 0);
  assert.equal((await auditV3Read(staff("admin"), {}, { load })).state, "ready");
  // A failed read is 「這裡暫時讀不到」, never an empty log; an RLS refusal is forbidden.
  const errors: unknown[] = [];
  const original = console.error; console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    assert.deepEqual(await auditV3Read(staff("admin"), {}, { load: async () => { throw new Error("boom"); } }), { state: "unavailable" });
    assert.deepEqual(await auditV3Read(staff("admin"), {}, { load: async () => { throw Object.assign(new Error("rls"), { code: "42501" }); } }), { state: "forbidden" });
  } finally { console.error = original; }
});

test("MGT-136-AC2 paging: 25 a page, newest first; 下一頁 continues; 上一頁 from page 2 returns to the page before", async () => {
  const admin = staff("admin");
  const calls: AuditV3PageInput[] = [];
  const load = fakeLoad(thirty, calls);
  const first = await auditV3Read(admin, { item: "lease" }, { load, now: () => NOW });
  assert.equal(first.state, "ready"); if (first.state !== "ready") return;
  assert.equal(first.entries.length, 25); assert.equal(first.prev, null); assert.ok(first.next);
  assert.equal(first.entries[0].when, "11/30 09:00");
  assert.deepEqual(calls[0].tables, ["leases", "lease_parties", "lease_charges", "lease_signatures"]);
  assert.equal(calls[0].limit, 26); assert.equal(calls[0].direction, "older");
  assert.deepEqual(first.actors, [{ id: OTHER, name: "王怡君 ••••••••••" }]);
  const second = await auditV3Read(admin, { item: "lease", cursor: first.next! }, { load, now: () => NOW });
  if (second.state !== "ready") throw new Error("second");
  assert.equal(second.entries.length, 5); assert.equal(second.next, null); assert.equal(second.prev, second.entries[0].key);
  assert.equal(second.entries[0].when, "11/05 09:00");
  // 上一頁 with fewer than a full page newer: the first page itself (no 上一頁 there).
  const back = await auditV3Read(admin, { item: "lease", before: second.prev! }, { load, now: () => NOW });
  if (back.state !== "ready") throw new Error("back");
  assert.deepEqual(back.entries.map(e => e.key), first.entries.map(e => e.key)); assert.equal(back.prev, null); assert.equal(back.next, first.next);
  // 上一頁 in the middle: the 25 entries just newer, newest first, with both links.
  const sixty = Array.from({ length: 60 }, (_, i) => raw({ id: String(7000 + i), occurred_key: `2026-10-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000000Z`, changed_cols: ["notes"] }));
  const many = fakeLoad(sixty);
  const p1 = await auditV3Read(admin, {}, { load: many, now: () => NOW }); if (p1.state !== "ready") throw new Error("p1");
  const p2 = await auditV3Read(admin, { cursor: p1.next! }, { load: many, now: () => NOW }); if (p2.state !== "ready") throw new Error("p2");
  const p3 = await auditV3Read(admin, { cursor: p2.next! }, { load: many, now: () => NOW }); if (p3.state !== "ready") throw new Error("p3");
  assert.equal(p3.entries.length, 10);
  const up = await auditV3Read(admin, { before: p3.prev! }, { load: many, now: () => NOW }); if (up.state !== "ready") throw new Error("up");
  assert.deepEqual(up.entries.map(e => e.key), p2.entries.map(e => e.key)); assert.equal(up.prev, p2.entries[0].key); assert.equal(up.next, p2.next);
  // An empty later page still offers the way back to the first page.
  const empty = await auditV3Read(admin, { cursor: encodeCursor("2000-01-01T00:00:00.000000Z", "1") }, { load: many, now: () => NOW });
  if (empty.state !== "ready") throw new Error("empty");
  assert.deepEqual([empty.entries.length, empty.prev, empty.next], [0, "", null]);
});

test("MGT-136-AC2 SQL: one named field only, never a row snapshot; keyset both ways; filters appended only when set", () => {
  const base: AuditV3PageInput = { orgId: ORG, actorId: null, tables: null, from: null, to: null, cursor: null, direction: "older", limit: 26 };
  const plain = auditV3PageQuery(base);
  assert.doesNotMatch(plain.sql, /a\.(old|new)_row\s*(,|$|\n| AS)/);
  assert.doesNotMatch(plain.sql, /to_jsonb\(a\)|a\.\*/);
  assert.equal((plain.sql.match(/a\.(old|new)_row ->> x\.col/g) ?? []).length, 2);
  assert.match(plain.sql, /ORDER BY a\.occurred_at DESC, a\.id DESC/);
  assert.deepEqual(plain.params, [ORG, Object.keys(PLAIN_FIELDS), 26]);
  const all = auditV3PageQuery({ ...base, actorId: OTHER, tables: ["units", "rooms"], from: "2026-10-31T16:00:00.000Z", to: "2026-11-15T16:00:00.000Z", cursor: { at: "2026-11-14T07:02:00.000000Z", id: "42" }, direction: "newer" });
  assert.match(all.sql, /a\.actor_user_id = \$2::uuid/); assert.match(all.sql, /a\.table_name = ANY\(\$3::text\[\]\)/);
  assert.match(all.sql, /\(a\.occurred_at, a\.id\) > \(\$6::timestamptz, \$7::bigint\)/); assert.match(all.sql, /ORDER BY a\.occurred_at ASC, a\.id ASC/);
  assert.equal(auditV3PageQuery({ ...base, limit: 999 }).params.at(-1), 26);
});

const page = (over: Partial<AuditV3Page> = {}): AuditV3Page => ({
  entries: [presentAuditV3(raw({ plain_col: "rent_amount_minor", plain_old: "1800000", plain_new: "1850000", plain_currency: "TWD", reason: "續約調漲" }), leaseHit, staff("admin"), NOW)],
  actors: [{ id: ME, name: "陳志明" }, { id: OTHER, name: "" }], filters: parseAuditV3({}), next: null, prev: null, ...over,
});

test("MGT-136-AC2 page: filters (全部的人・dates・全部項目), plain entries with 「{哪一類}・{時間}」, 下一頁 and 上一頁 keep the filters", () => {
  const html = renderToStaticMarkup(<AuditView locale="zh-TW" page={page({ filters: parseAuditV3({ user: ME, from: "2026-11-01", to: "2026-11-15", item: "lease", cursor: encodeCursor("2026-11-14T07:02:00.000000Z", "9") }), next: "N", prev: "P" })} />);
  assert.match(html, /<form class="v3-audit-filters" data-testid="audit-v3-filters" action="\/m\/audit" method="get">/);
  assert.match(html, /<select class="inp" name="user" aria-label="成員"><option value="">全部的人<\/option><option value="[^"]+" selected="">陳志明<\/option><option value="[^"]+">成員<\/option><\/select>/);
  assert.match(html, /type="date" aria-label="從" name="from" value="2026-11-01"/); assert.match(html, /type="date" aria-label="到" name="to" value="2026-11-15"/);
  assert.match(html, /<select class="inp" name="item" aria-label="項目"><option value="">全部項目<\/option><option value="lease" selected="">租約<\/option><option value="payment">繳款<\/option><option value="unit">單位<\/option><option value="contacts">租客／屋主<\/option>/);
  assert.match(html, /<button class="btn txt" type="submit">篩選<\/button>/);
  assert.match(text(html), /陳志明把信義路四段 120 號 2 樓的租金從 NT\$18,000 改成 NT\$18,500・原因：續約調漲租約・11\/14 15:02/);
  assert.match(html, new RegExp(`<a class="btn txt" href="/m/audit\\?user=${ME}&amp;from=2026-11-01&amp;to=2026-11-15&amp;item=lease&amp;before=P" data-testid="audit-v3-prev">上一頁</a><a class="btn txt" href="/m/audit\\?user=${ME}&amp;from=2026-11-01&amp;to=2026-11-15&amp;item=lease&amp;cursor=N" data-testid="audit-v3-next">下一頁</a>`));
  // No solid button on this page, nothing disabled, no technical columns.
  assert.doesNotMatch(html, /btn pri|disabled|<table|old_row|new_row|changed_cols/);
  // The first page shows only 下一頁; 上一頁 to the first page drops the cursor.
  const firstOnly = renderToStaticMarkup(<AuditView locale="zh-TW" page={page({ next: "N" })} />);
  assert.doesNotMatch(firstOnly, /audit-v3-prev/); assert.match(firstOnly, /href="\/m\/audit\?cursor=N"/);
  assert.match(renderToStaticMarkup(<AuditView locale="zh-TW" page={page({ prev: "" })} />), /href="\/m\/audit" data-testid="audit-v3-prev"/);
  // An unknown selected person keeps a generic option instead of leaking an id.
  assert.match(renderToStaticMarkup(<AuditView locale="zh-TW" page={page({ filters: parseAuditV3({ user: "00000000-0000-4000-8000-0000000000ff" }) })} />), /<option value="00000000-0000-4000-8000-0000000000ff" selected="">成員<\/option>/);
  assert.match(renderToStaticMarkup(<AuditView locale="en" page={page()} />), /Everyone[^]*All items/);
});

test("MGT-136-AC5 states: no match → 「找不到符合的紀錄」 + 「清除篩選」; loading line skeletons; read failure GS-02 + 「再試一次」", () => {
  const none = renderToStaticMarkup(<AuditView locale="zh-TW" page={page({ entries: [], filters: parseAuditV3({ item: "unit" }) })} />);
  assert.match(none, /<p>找不到符合的紀錄<\/p><a class="btn txt" href="\/m\/audit" data-testid="audit-v3-clear">清除篩選<\/a>/);
  assert.doesNotMatch(none, /audit-v3-list|audit-v3-next/);
  const unfiltered = renderToStaticMarkup(<AuditView locale="zh-TW" page={page({ entries: [] })} />);
  assert.match(unfiltered, /找不到符合的紀錄/); assert.doesNotMatch(unfiltered, /清除篩選/);
  const loading = renderToStaticMarkup(<AuditLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/); assert.equal((loading.match(/v3-audit-skeleton/g) ?? []).length, 5);
  assert.doesNotMatch(loading, /<form|<a |<select|下一頁/);
  const error = renderToStaticMarkup(<AuditError locale="zh-TW" retryHref="/m/audit?item=unit" />);
  assert.match(error, /role="alert"><p>這裡暫時讀不到，請再試一次。<\/p><a class="btn" href="\/m\/audit\?item=unit">再試一次<\/a>/);
  assert.doesNotMatch(error, /<form|audit-v3-list/);
});

// ---- Route: flag OFF byte-for-byte; ON branch. ----
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
function auditMocks(v3: boolean, trace: string[], session: Session) {
  return {
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => { trace.push("flag"); return v3; } },
    "@/components/v3/m/settings/audit": { AuditLoading: box("audit-loading") },
    "@/components/v3/m/settings/audit-page": { AuditV3Section: box("audit-section") },
    "@/i18n/lanes/brand-v3-r5-audit": { brandV3AuditCopy },
    "@/components/management-empty-state": { ManagementEmptyState: box("empty") },
    "@/server/consent-gate": { requireCurrentConsent: async () => { trace.push("consent"); return null; } },
    "next/link": { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> },
    "next/navigation": { redirect: (to: string) => { trace.push(`redirect:${to}`); throw Object.assign(new Error("NEXT_REDIRECT"), { to }); } },
    "@/i18n": { makeT: () => (key: string, values?: Record<string, unknown>) => values ? `${key}${JSON.stringify(values)}` : key },
    "@/components/audit-log": { AuditRows: box("rows") },
    "@/components/ui": { PageHeader: box("header") },
    "@/server/demo": { showDemoLineCopy: () => false },
    "@/server/audit-read": { ...auditRead, loadAuditScreen: async (_s: Session, query: Record<string, string>) => {
      trace.push("audit-read");
      const filters = auditRead.parseAuditFilters(query);
      return { entries: query.empty ? [] : [{ cursor: "c1" }], hasMore: !query.empty, actors: [{ id: ME, name: "陳志明" }], filters };
    } },
    "@/server/perms": perms,
    "@/server/session": { getSession: async () => session },
  };
}
async function renderAudit(source: string, v3: boolean, session: Session, query: Record<string, string> = {}) {
  const trace: string[] = [];
  const pageFn = compile(source, auditMocks(v3, trace, session)).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>;
  try {
    return { html: renderToStaticMarkup(await pageFn({ searchParams: Promise.resolve(query) })), trace: trace.filter(step => step !== "flag") };
  } catch (error) {
    return { html: `redirect:${(error as { to?: string }).to}`, trace: trace.filter(step => step !== "flag") };
  }
}
const FILE = "src/app/m/audit/page.tsx";

test("MGT-136 flag OFF: /m/audit renders byte-for-byte as before, same reads in the same order", async () => {
  const queries: Record<string, string>[] = [{}, { empty: "1" }, { user: ME, action: "update", record: "leases", from: "2026-11-01", to: "2026-11-15", cursor: encodeCursor("2026-11-14T07:02:00.000000Z", "9") }];
  for (const session of [staff("admin"), staff("admin", "en"), staff("manager"), staff("accountant")])
    for (const query of queries)
      assert.deepEqual(await renderAudit(read(FILE), false, session, query), await renderAudit(baseline(FILE), false, session, query), `${session.role} ${session.locale} ${JSON.stringify(query)}`);
  const off = (await renderAudit(read(FILE), false, staff("admin"))).html;
  assert.match(off, /data-testid="audit-filters"/); assert.doesNotMatch(off, /settings-audit\.css|audit-section/);
});

test("MGT-136-AC3 flag ON: a non-admin is still sent to the no-permission page before anything is read; an admin gets the lead and the v3 log", async () => {
  for (const role of ["manager", "accountant", "maintenance"] as OrgRole[]) {
    const denied = await renderAudit(read(FILE), true, staff(role));
    assert.equal(denied.html, "redirect:/m/noperm?need=admin", role);
    assert.deepEqual(denied.trace, ["consent", "redirect:/m/noperm?need=admin"], role);
  }
  const on = await renderAudit(read(FILE), true, staff("admin"), { item: "unit" });
  assert.match(on.html, /^<link rel="stylesheet" href="\/brand\/v3\/settings-audit\.css"\/><div data-test="header">\{&quot;title&quot;:&quot;操作紀錄：全公司誰改了什麼，可以依人、日期、項目找。&quot;\}<\/div><div data-test="audit-section">/);
  assert.match(on.html, /&quot;query&quot;:\{&quot;item&quot;:&quot;unit&quot;\}/);
  assert.doesNotMatch(on.html, /audit-filters|data-test="rows"|i_audit_mask_note/);
  assert.deepEqual(on.trace, ["consent"], "no legacy read before the v3 section");
  // Only this page links the stylesheet; the crumb is the frame's 「設定 › 操作紀錄」 (brand_v3 navigation, admin only).
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  assert.deepEqual(walk("src").filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f) && read(f).includes("settings-audit.css")), [FILE]);
  assert.deepEqual(crumbFor("/m/audit", staff("admin")), ["設定", "操作紀錄"]);
  assert.equal(crumbFor("/m/audit", staff("manager")).includes("操作紀錄"), false);
});

test("R5-AUDIT CSS: v3-scoped, tokens only, ≥44px targets", () => {
  const css = read("public/brand/v3/settings-audit.css");
  postcss.parse(css).walkRules(rule => {
    for (const s of rule.selectors) assert.ok(s.startsWith('html[data-brand="v2"][data-brand-v3] .v3-audit'), s);
  });
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/i);
  assert.match(css, /\.v3-audit \.btn\{[^}]*min-height:44px; min-width:44px/);
  assert.match(css, /\.v3-audit-filters \.inp\{ min-height:44px/);
});
