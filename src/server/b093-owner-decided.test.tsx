import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { cursorParam, ownerDecidedList, ownerDecidedTicket, parseCursor, type DecidedLine, type DecidedTicket } from "./b093-owner-decided";
import { DecidedError, DecidedListView, DecidedLoading, DecidedNoPerm, DecidedTicketView, decidedPageHref } from "../components/v3/o/decided/decided";
import { brandV3OwnerDecidedCopy } from "../i18n/lanes/brand-v3-owner-decided";
import { repairApprovalCopy } from "../i18n/repair-approval";
import { Illustration } from "../components/v3/illustrations";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// OWN-35-AC1…AC3 / RO-DECIDED (B-093). Synthetic data only.
const read = (p: string) => readFileSync(p, "utf8");
const owner: Session = { kind: "owner", role: null, orgId: "00000000-0000-4000-8000-000000000001", liveOrgId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic", email: "",
  environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const T1 = "00000000-0000-4000-8000-0000000000a1", T2 = "00000000-0000-4000-8000-0000000000a2", V1 = "00000000-0000-4000-8000-0000000000b1",
  V2 = "00000000-0000-4000-8000-0000000000b2", V3 = "00000000-0000-4000-8000-0000000000b3";
const lines: DecidedLine[] = [
  { ticketId: T1, versionId: V1, property: "景興路套房", item: "洗手台漏水", currency: "TWD", minorUnit: 0, amountMinor: "4500", decision: "approved", decidedAt: "2030-11-12T02:00:00.123456+00:00", decidedOn: "2030-11-12" },
  { ticketId: T2, versionId: V2, property: "信義路 2 樓", item: "換熱水器", currency: "TWD", minorUnit: 0, amountMinor: "12800", decision: "rejected", decidedAt: "2030-10-28T02:00:00+00:00", decidedOn: "2030-10-28" },
  { ticketId: T2, versionId: V3, property: "和平東路 5 樓", item: "門鎖", currency: "USD", minorUnit: 2, amountMinor: "6250", decision: "more_information", decidedAt: "2030-10-03T02:00:00+00:00", decidedOn: "2030-10-03" },
];
const detail: DecidedTicket = { ticketId: T2, property: "信義路 2 樓", item: "換熱水器", status: "in_progress", versions: [
  { versionId: V3, versionNo: "2", currency: "TWD", minorUnit: 0, amountMinor: "13500", workScope: "更換熱水器\n含管線", decision: "approved", reason: null, decidedAt: "2030-11-01T02:00:00+00:00", decidedOn: "2030-11-01" },
  { versionId: V2, versionNo: "1", currency: "TWD", minorUnit: 0, amountMinor: "12800", workScope: "更換熱水器", decision: "rejected", reason: "請附兩家報價", decidedAt: "2030-10-28T02:00:00+00:00", decidedOn: "2030-10-28" },
] };
const never = (async () => { throw new Error("transaction must not run"); }) as never;
function client(result: unknown, seen: { sql: string; args?: unknown[] }[]) {
  return (async (user: string, callback: (c: unknown) => Promise<unknown>, options: unknown) => {
    assert.equal(user, owner.userId); assert.deepEqual(options, { isolation: "repeatable read" });
    return callback({ query: async (sql: string, args?: unknown[]) => { seen.push({ sql, args }); return { rows: sql.includes("app.b093_") ? [{ result }] : [] }; } });
  }) as never;
}

test("OWN-35 reader: OFF never opens a transaction, flag failure is unavailable, non-owners are 403", async () => {
  assert.deepEqual(await ownerDecidedList(owner, {}, { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await ownerDecidedTicket(owner, T1, { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await ownerDecidedList(owner, {}, { v3: async () => { throw new Error("flag read failed"); }, transaction: never }), { state: "unavailable" });
  for (const actor of [{ ...owner, kind: "tenant" as const }, { ...owner, kind: "staff" as const, role: "admin" as const }, { ...owner, sessionId: "not-a-uuid" }, { ...owner, environment: "other" as never }]) {
    assert.deepEqual(await ownerDecidedList(actor, {}, { v3: async () => true, transaction: never }), { state: "forbidden" });
    assert.deepEqual(await ownerDecidedTicket(actor, T1, { v3: async () => true, transaction: never }), { state: "forbidden" });
  }
  assert.deepEqual(await ownerDecidedTicket(owner, "../x", { v3: async () => true, transaction: never }), { state: "forbidden" });
  await assert.rejects(ownerDecidedList(owner, { after: { decidedAt: "nope", versionId: V1 } }, { v3: async () => true, transaction: never }), /required/);
});

test("OWN-35-AC1 reader: pinned org/env, bounded timeouts, repeatable read, exact gateway args and strict DTO", async () => {
  const seen: { sql: string; args?: unknown[] }[] = [];
  const next = { decidedAt: lines[2].decidedAt, versionId: V3 };
  const page = await ownerDecidedList(owner, { after: { decidedAt: lines[0].decidedAt, versionId: V1 }, limit: 500 }, { v3: async () => true, transaction: client({ rows: lines, next }, seen) });
  assert.deepEqual(page, { state: "ready", rows: lines, next });
  assert.match(seen[0].sql, /statement_timeout = '2s'/); assert.match(seen[1].sql, /lock_timeout = '1s'/);
  assert.deepEqual(seen[2].args, [owner.orgId, owner.environment]); assert.match(seen[2].sql, /app\.active_org_id.*app\.env/);
  assert.equal(seen[3].sql, "SELECT app.b093_owner_decided($1::uuid,$2::uuid,$3::text,$4::uuid,$5::jsonb,$6::integer) AS result");
  assert.deepEqual(seen[3].args, [owner.orgId, owner.liveOrgId, "live", owner.sessionId, { decidedAt: lines[0].decidedAt, versionId: V1 }, 50]);
  // Malformed payloads never render partially; a denied gateway is 403; a timeout is unavailable.
  for (const bad of [null, { rows: [{ ...lines[0], decision: "pending" }], next: null }, { rows: [{ ...lines[0], amountMinor: "1.5" }], next: null }, { rows: lines, next: { decidedAt: "x" } }])
    assert.deepEqual(await ownerDecidedList(owner, {}, { v3: async () => true, transaction: client(bad, []) }), { state: "unavailable" });
  const deny = (async () => { throw Object.assign(new Error("denied"), { cause: { code: "42501" } }); }) as never;
  assert.deepEqual(await ownerDecidedList(owner, {}, { v3: async () => true, transaction: deny }), { state: "forbidden" });
  assert.deepEqual(await ownerDecidedTicket(owner, T1, { v3: async () => true, transaction: deny }), { state: "forbidden" });
  const timeout = (async () => { throw Object.assign(new Error("statement timeout"), { code: "57014" }); }) as never;
  assert.deepEqual(await ownerDecidedList(owner, {}, { v3: async () => true, transaction: timeout }), { state: "unavailable" });
});

test("OWN-35-AC2/AC3 reader: one ticket view; nothing admitted (other owner / company / missing) is 403", async () => {
  const seen: { sql: string; args?: unknown[] }[] = [];
  assert.deepEqual(await ownerDecidedTicket(owner, T2, { v3: async () => true, transaction: client(detail, seen) }), { state: "ready", detail });
  assert.equal(seen[3].sql, "SELECT app.b093_owner_decided_ticket($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid) AS result");
  assert.deepEqual(seen[3].args, [owner.orgId, owner.liveOrgId, "live", owner.sessionId, T2]);
  assert.deepEqual(await ownerDecidedTicket(owner, T2, { v3: async () => true, transaction: client(null, []) }), { state: "forbidden" });
  for (const bad of [{ ...detail, ticketId: T1 }, { ...detail, versions: [] }, { ...detail, versions: [{ ...detail.versions[0], workScope: 1 }] }])
    assert.deepEqual(await ownerDecidedTicket(owner, T2, { v3: async () => true, transaction: client(bad, []) }), { state: "unavailable" });
});

test("cursor round-trips through the URL without person data; junk falls back to the first page", () => {
  const cursor = { decidedAt: lines[0].decidedAt, versionId: V1 };
  assert.deepEqual(parseCursor(cursorParam(cursor)), cursor);
  assert.equal(decidedPageHref(cursor), `/o/decided?after=${encodeURIComponent(`${lines[0].decidedAt}_${V1}`)}`);
  assert.ok(!decidedPageHref(cursor).includes("+"));
  for (const junk of ["", "x", `nope_${V1}`, `${lines[0].decidedAt}_x`, ["a"], 7]) assert.equal(parseCursor(junk), null);
  assert.equal(parseCursor(undefined), undefined);
});

test("RO-DECIDED list: 物件・項目, 金額, date, existing result labels in gateway order; read-only rows open the view", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const html = renderToStaticMarkup(<DecidedListView locale={locale} calendar="gregorian" rows={lines} next={null} />);
    const labels = repairApprovalCopy(locale);
    const found = [...html.matchAll(/class="decided-badge [^"]+">([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(found, [labels.approved, labels.rejected, labels.more_information]);
    if (locale === "zh-TW") assert.deepEqual(found, ["已核准", "已拒絕", "要求補充資料"]);
    assert.deepEqual([...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]), [`/o/approvals/${T1}`, `/o/approvals/${T2}`, `/o/approvals/${T2}`]);
    assert.ok(html.indexOf("景興路套房・洗手台漏水") < html.indexOf("信義路 2 樓・換熱水器"));
    assert.ok(html.includes("NT$4,500")); assert.ok(html.includes("NT$12,800")); assert.ok(html.includes("USD 62.50"));
    assert.ok(html.includes('dateTime="2030-11-12"') || html.includes('datetime="2030-11-12"'));
    assert.ok(html.includes(`<h2 class="decided-sr">${brandV3OwnerDecidedCopy(locale).title}</h2>`));
    assert.doesNotMatch(html, /owner-primary|<button|<form|<input|<textarea/);
    assert.doesNotMatch(html, /owner-decided-next/);
  }
  const roc = renderToStaticMarkup(<DecidedListView locale="zh-TW" calendar="roc" rows={[lines[0]]} next={null} />);
  assert.ok(roc.includes("119"), "ROC calendar setting is honoured");
  const paged = renderToStaticMarkup(<DecidedListView locale="zh-TW" calendar="gregorian" rows={lines} next={{ decidedAt: lines[2].decidedAt, versionId: V3 }} />);
  assert.ok(paged.includes(`href="${decidedPageHref({ decidedAt: lines[2].decidedAt, versionId: V3 }).replaceAll("&", "&amp;")}"`));
  assert.match(paged, /data-testid="owner-decided-next" href="[^"]+">下一頁</);
  assert.doesNotMatch(paged, /owner-primary/);
});

test("RO-DECIDED states: approved empty sentence, skeleton without numbers, in-place read error, B1-NOPERM", () => {
  const empty = renderToStaticMarkup(<DecidedListView locale="zh-TW" calendar="gregorian" rows={[]} next={null} />);
  assert.match(empty, /data-testid="owner-decided-empty"><p>還沒有決定過的估價。<\/p>/);
  assert.doesNotMatch(empty, /owner-primary|<button/);
  for (const detailLoading of [false, true]) {
    const loading = renderToStaticMarkup(<DecidedLoading locale="zh-TW" detail={detailLoading} />);
    assert.match(loading, /aria-busy="true"/); assert.match(loading, /decided-skeleton/);
    assert.doesNotMatch(loading.replace(/<[^>]+>/g, ""), /[0-9０-９]|NT\$|件/);
  }
  const error = renderToStaticMarkup(<DecidedError locale="zh-TW" retryHref="/o/decided" />);
  assert.match(error, /role="alert"><p>這裡暫時讀不到，請再試一次。<\/p><a class="owner-action" href="\/o\/decided">再試一次<\/a>/);
  for (const locale of ["zh-TW", "en"] as const) {
    const noperm = renderToStaticMarkup(<DecidedNoPerm locale={locale} />);
    const copy = brandV3OwnerDecidedCopy(locale);
    assert.ok(noperm.includes(renderToStaticMarkup(<Illustration name="26" />)));
    assert.ok(noperm.includes(`<p>${copy.noPerm.replaceAll("'", "&#x27;")}</p>`));
    assert.match(noperm, new RegExp(`<a class="owner-action owner-primary" href="/o">${copy.home}</a>`));
    assert.equal((noperm.match(/owner-primary/g) ?? []).length, 1);
    assert.doesNotMatch(noperm, /景興路|信義路|NT\$/);
  }
  assert.equal(brandV3OwnerDecidedCopy("zh-TW").noPerm, "你目前的角色看不到這一頁，需要的話請公司管理員幫你開。");
  assert.equal(brandV3OwnerDecidedCopy("zh-TW").home, "回到首頁");
});

test("OWN-35-AC2 view: version, scope, the owner's reason only when given, later progress; read-only, headings in order", () => {
  const html = renderToStaticMarkup(<DecidedTicketView locale="zh-TW" calendar="gregorian" detail={detail} />);
  assert.ok(html.includes("<h2>信義路 2 樓・換熱水器</h2>"));
  assert.match(html, /<dt>狀態<\/dt><dd data-testid="owner-decided-status">處理中<\/dd>/);
  assert.deepEqual([...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map(m => m[1]), ["第 2 版", "第 1 版"]);
  assert.deepEqual([...html.matchAll(/<(h[1-6])/g)].map(m => m[1]), ["h2", "h3", "h3"]);
  assert.ok(html.includes("更換熱水器\n含管線")); assert.ok(html.includes("NT$13,500"));
  assert.equal((html.match(/<dt>原因<\/dt>/g) ?? []).length, 1); assert.ok(html.includes("請附兩家報價"));
  assert.ok(html.includes("<dt>工作範圍</dt>")); assert.ok(html.includes("<dt>決定時間</dt>"));
  assert.match(html, /<a class="owner-text-link" href="\/o\/decided">核准紀錄<\/a>/);
  assert.doesNotMatch(html, /owner-primary|<button|<form|<input|<textarea|核准估價|退回/);
  const unknown = renderToStaticMarkup(<DecidedTicketView locale="en" calendar="gregorian" detail={{ ...detail, status: "mystery" }} />);
  assert.match(unknown, /data-testid="owner-decided-status">—</);
});

test("RO-DECIDED CSS: owner.css tokens only, scoped, 44px rows, no solid primary on list rows", () => {
  const css = read("public/brand/v3/owner.css");
  const decided = css.slice(css.indexOf("/* RO-DECIDED"));
  assert.ok(decided.length > 200); assert.doesNotMatch(decided, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  for (const line of decided.split("\n").filter(line => line.includes(" { "))) assert.ok(line.startsWith('html[data-brand="v2"][data-brand-v3] '), line);
  assert.match(decided, /\.decided-line \{[^}]*min-height:44px/);
  assert.doesNotMatch(decided, /\.decided-[a-z-]+ \{[^}]*background:var\(--c-primary\)/);
});

// ---- Page wiring: OQ-055 OFF parity and the brand_v3 branch (compiled with mocks, no DB). ----
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
const BASE = "f371515";
const ticketPage = "src/app/o/approvals/[ticketId]/page.tsx";
function pageMocks(calls: string[], { v3, approvals, pending = [] as string[] }: { v3: boolean; approvals: boolean; pending?: string[] }) {
  const history = [{ version_id: V1 }];
  return {
    "@/server/brand-v3": { brandV3EnabledForOrg: async (id: string) => { calls.push(`v3:${id}`); return v3; } },
    "@/server/consent-gate": { requireCurrentConsent: async (_: unknown, mode: string) => { calls.push(`consent:${mode}`); } },
    "@/i18n": { makeT: () => (key: string) => `t:${key}` },
    "@/server/brand-v2": { brandV2EnabledForOrg: async () => { calls.push("v2"); return false; } },
    "@/server/session": { getSession: async () => { calls.push("session"); return owner; } },
    "@/server/repair-approval": {
      repairApprovalsEnabled: async () => { calls.push("approvals"); return approvals; },
      ownerPending: async () => { calls.push("pending"); return pending.map(ticket_id => ({ ticket_id })); },
      ownerHistory: async (_: unknown, input: { ticketId: string }) => { calls.push(`history:${input.ticketId}`); return history; },
    },
    "@/server/repair-rules": { isUuid: (value: string) => /^[0-9a-f-]{36}$/.test(value) },
    "next/navigation": { notFound: () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); }, redirect: (to: string) => { calls.push(`redirect:${to}`); throw new Error(`redirect:${to}`); } },
    "../approval-cards": { ApprovalHistoryCards: ({ rows }: { rows: unknown[] }) => <i data-rows={rows.length}>legacy cards</i> },
    react: requireHere("react"),
    "@/components/v3/o/decided/decided": { DecidedLoading: () => <b>loading</b> },
    "@/components/v3/o/decided/page": { DecidedTicketPage: () => <b>decided view</b> },
  };
}
async function runPage(text: string, mocks: Record<string, unknown>, ticketId: string) {
  const Page = compile(text, mocks).default as (p: { params: Promise<{ ticketId: string }> }) => Promise<React.ReactElement>;
  try { return await Page({ params: Promise.resolve({ ticketId }) }); } catch (e) { return (e as Error).message; }
}

test("OQ-055 / OWN-35-AC2: with brand_v3 OFF /o/approvals/[ticketId] is byte-identical to main (markup and reader calls)", async () => {
  const old = execFileSync("git", ["show", `${BASE}:${ticketPage}`], { encoding: "utf8" });
  for (const approvals of [false, true]) for (const ticketId of [T1, "not-a-ticket"]) for (const pending of [[], [T1]]) {
    const before: string[] = [], after: string[] = [];
    const a = await runPage(old, pageMocks(before, { v3: false, approvals, pending }), ticketId);
    const b = await runPage(read(ticketPage), pageMocks(after, { v3: false, approvals, pending }), ticketId);
    assert.deepEqual(after, before);
    assert.equal(typeof b === "string" ? b : renderToStaticMarkup(b), typeof a === "string" ? a : renderToStaticMarkup(a));
    assert.ok(!after.includes("pending"), "OFF never reads the pending list");
  }
  // The OFF tail of the new file is the old file's tail, character for character.
  const tail = (text: string) => text.slice(text.indexOf("  const rows = await ownerHistory(session, { ticketId });"));
  assert.equal(tail(read(ticketPage)), tail(old));
});

test("OQ-055 / OWN-35-AC2: brand_v3 ON keeps pending deep links on 首頁 and replaces only the decided page", async () => {
  const calls: string[] = [];
  assert.equal(await runPage(read(ticketPage), pageMocks(calls, { v3: true, approvals: true, pending: [T1] }), T1), `redirect:/o?estimate=${T1}`);
  const on: string[] = [];
  const element = await runPage(read(ticketPage), pageMocks(on, { v3: true, approvals: true }), T2) as React.ReactElement<{ children: React.ReactElement<{ ticketId: string; session: Session }>; fallback: React.ReactElement<{ detail: boolean }> }>;
  assert.equal(element.type, React.Suspense);
  assert.equal(element.props.children.props.ticketId, T2); assert.equal(element.props.children.props.session, owner);
  assert.equal(element.props.fallback.props.detail, true);
  assert.ok(!on.some(call => call.startsWith("history:")), "the legacy history reader is not used under brand_v3");
  assert.deepEqual(on, ["consent:page", "session", "v2", "approvals", "v3:" + owner.orgId, "pending"]);
  // Approvals OFF keeps today's placeholder before any v3 read.
  const off: string[] = [];
  const placeholder = await runPage(read(ticketPage), pageMocks(off, { v3: true, approvals: false }), T2);
  assert.match(renderToStaticMarkup(placeholder as React.ReactElement), /t:i_no_approvals/);
  assert.ok(!off.includes("pending"));
});

test("RO-DECIDED route: brand_v3 OFF is a 404 with no reader; ON streams the list behind a number-free skeleton", async () => {
  const text = read("src/app/o/decided/page.tsx");
  for (const v3 of [false, true]) {
    const calls: string[] = [];
    const mocks = {
      ...pageMocks(calls, { v3, approvals: true }),
      "@/components/v3/o/decided/decided": { DecidedLoading: (p: { locale: string }) => <b data-locale={p.locale}>loading</b> },
      "@/components/v3/o/decided/page": { DecidedListPage: () => <b>list</b> },
      "next/navigation": { notFound: () => { calls.push("notFound"); throw new Error("NEXT_NOT_FOUND"); } },
    };
    const Page = compile(text, mocks).default as (p: { searchParams: Promise<{ after?: string }> }) => Promise<React.ReactElement<{ children: React.ReactElement<{ after: unknown }> }>>;
    if (!v3) { await assert.rejects(Page({ searchParams: Promise.resolve({}) }), /NEXT_NOT_FOUND/); assert.deepEqual(calls, ["consent:page", "session", `v3:${owner.orgId}`, "notFound"]); continue; }
    const element = await Page({ searchParams: Promise.resolve({ after: "cursor" }) });
    assert.equal(element.type, React.Suspense); assert.equal(element.props.children.props.after, "cursor");
    assert.deepEqual(calls, ["consent:page", "session", `v3:${owner.orgId}`]);
  }
});

test("page wrappers map reader states: 403 → B1-NOPERM, unavailable → in-place retry, ready → view", async () => {
  const text = read("src/components/v3/o/decided/page.tsx");
  for (const state of ["forbidden", "unavailable", "off", "ready"] as const) {
    const seen: unknown[] = [];
    const mocks = {
      react: requireHere("react"),
      "../../../../server/b093-owner-decided": {
        parseCursor: (raw: unknown) => raw === "good" ? { decidedAt: lines[0].decidedAt, versionId: V1 } : raw === undefined ? undefined : null,
        ownerDecidedList: async (_: Session, options: unknown) => { seen.push(options); return state === "ready" ? { state, rows: lines, next: null } : { state }; },
        ownerDecidedTicket: async (_: Session, id: string) => { seen.push(id); return state === "ready" ? { state, detail } : { state }; },
      },
      "./decided": {
        DecidedNoPerm: () => "NOPERM", DecidedError: (p: { retryHref: string }) => `ERROR ${p.retryHref}`,
        DecidedListView: (p: { rows: unknown[] }) => `LIST ${p.rows.length}`, DecidedTicketView: (p: { detail: DecidedTicket }) => `VIEW ${p.detail.ticketId}`,
        decidedPageHref: (after?: unknown) => after ? "/o/decided?after=x" : "/o/decided", decidedTicketHref: (id: string) => `/o/approvals/${id}`,
      },
    };
    const mod = compile(text, mocks) as Record<string, (p: Record<string, unknown>) => Promise<React.ReactElement>>;
    const list = renderToStaticMarkup(await mod.DecidedListPage({ session: owner, after: "junk" }));
    const view = renderToStaticMarkup(await mod.DecidedTicketPage({ session: owner, ticketId: T2 }));
    assert.deepEqual(seen, [{ after: undefined }, T2]);
    assert.equal(list, state === "forbidden" ? "NOPERM" : state === "ready" ? "LIST 3" : "ERROR /o/decided");
    assert.equal(view, state === "forbidden" ? "NOPERM" : state === "ready" ? `VIEW ${T2}` : `ERROR /o/approvals/${T2}`);
  }
});

test("RO-DECIDED view imports labels only: never the B-013 service, no money/decision writer, no new result strings", () => {
  const view = read("src/components/v3/o/decided/decided.tsx");
  assert.doesNotMatch(view, /server\/repair-approval["']|decision-request|postOwnerDecision|"use client"/);
  assert.match(view, /repairApprovalCopy\(locale\)\[decision\]/);
  const lane = read("src/i18n/lanes/brand-v3-owner-decided.ts");
  assert.doesNotMatch(lane, /已核准|已拒絕|退回|要求補充資料/);
});
