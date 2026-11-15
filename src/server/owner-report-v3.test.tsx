import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import * as i18n from "../i18n";
import * as copy from "../i18n/lanes/brand-v3";
import * as format from "./format";
import * as privacy from "./privacy";
import * as scope from "./owner-scope";
import type { Session } from "./types";
import type { OwnerReportData } from "./owner-report-v3";

const BASE = "1c8b89a37fa297966ede8e461b4df6a2d12e88d5";
const source = (path: string) => readFileSync(path, "utf8");
const old = (path: string) => execFileSync("git", ["show", `${BASE}:${path}`], { encoding: "utf8" });
const requireHere = createRequire(import.meta.url);
function compile<T = Record<string, React.ComponentType<Record<string, unknown>>>>(code: string, mocks: Record<string, unknown>): T {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function("require", "exports", js)((name: string) => {
    if (name in mocks) return mocks[name];
    if (name === "react" || name === "react/jsx-runtime") return requireHere(name);
    throw new Error(`Unmocked ${name}`);
  }, exports);
  return exports as T;
}
const actor: Session = { kind: "owner", role: null, orgId: "org", liveOrgId: "org", userId: "owner", sessionId: "session", name: "Owner", email: "", locale: "zh-TW", environment: "live", calendar: "gregorian", leaseId: null };
const row = { id: "s1", owner_id: "o", owner_name: "Owner", properties: "A", period_start: "2026-10-01", period_end: "2026-10-31", currency: "TWD", opening: "70000", rent: "1500000", other: "5000", fee: "150000", expenses: "30000", payouts: "20000", closing: "1375000", status: "issued" };
const lines = [{ line_type: "rent", description: "A", amount: "1500000" }, { line_type: "expense", description: "Private Tenant repair", amount: "-30000" }];
const link = { __esModule: true, default: "a" };
const docMocks = { "@/components/brand": { BrandImage: () => <span data-testid="logo" /> }, "@/server/format": format };
const document = compile(source("src/components/statement-document.tsx"), docMocks);
const pdf = { PdfDownloadButton: (props: Record<string, unknown>) => <button data-href={props.href}>{String(props.label)}</button> };
const ledgerPanel = { OwnerNetLedgerPanel: ({ view }: { view: unknown }) => <div data-testid="ledger">{JSON.stringify(view)}</div> };
const repliesPanel = { OwnerReportReplies: ({ view }: { view: unknown }) => <div data-testid="replies">{JSON.stringify(view)}</div> };
function ui(loader: unknown = async () => { throw new Error("unavailable"); }) {
  return compile<{
    OwnerReportView: React.ComponentType<{ data: OwnerReportData; locale: i18n.Locale }>;
    OwnerReportLoading: React.ComponentType<{ locale: i18n.Locale }>;
    OwnerReportPage: (props: { session: Session; month: unknown }) => Promise<React.ReactElement>;
  }>(source("src/components/v3/o/report/page.tsx"), {
    "next/link": link, "@/i18n": i18n, "@/i18n/lanes/brand-v3": copy,
    "@/components/statement-document": document, "@/components/pdf-download-button": pdf,
    "@/components/owner-net-ledger-panel": ledgerPanel, "@/components/owner-report-replies": repliesPanel,
    "@/server/owner-report-v3": { loadOwnerReport: loader },
  });
}
function model(overrides: Record<string, unknown> = {}) {
  const reads: string[] = [];
  const queryMocks = {
    listStatements: async (...args: unknown[]) => { assert.equal(args.length, 1); return [row]; },
    ownerStatementPropertyNames: async (_s: Session, ids: string[]) => ids.map(id => ({ id, properties: "A" })),
    statementDetail: async (_s: Session, id: string) => { reads.push(id); return { statement: row, lines }; },
    ownerStatementRentSource: async () => ({ count: 1, date: "2026-10-05" }), ...overrides,
  };
  const loaded = compile<{
    selectReportMonth: (rows: typeof row[], month: unknown) => { month?: string; previous?: string; next?: string; rows: typeof row[] };
    loadOwnerReport: (session: Session, month: unknown) => Promise<OwnerReportData>;
  }>(source("src/server/owner-report-v3.ts"), {
    "./queries": queryMocks, "@/i18n": i18n, "./privacy": privacy,
    "./auth": { ownerPrivacy: async () => ({ showName: false }), tenantDisplayNames: async () => ["Private Tenant"] },
    "./owner-net-ledger": { ownerNetLedgerView: async () => null },
    "./owner-net-ledger-presentation": { ledgerPanelView: () => assert.fail("no ledger") },
    "./owner-finance-replies": { ownerTransferHistory: async () => null, reportRepliesView: async () => null },
    "./owner-finance-replies-presentation": { repliesPanelView: () => assert.fail("no replies") },
  });
  return { ...loaded, reads };
}

test("O-RPT / OWN-27-AC4 / OWN-02: OFF list and detail are byte-identical to the pinned owner-shell baseline", async () => {
  for (const locale of ["zh-TW", "en"] as const) for (const v2 of [false, true]) for (const rent of ["0", "1500000", "-100000"]) for (const empty of [false, true]) {
    const detail = empty ? null : { statement: { ...row, rent }, lines };
    const mocks = {
      "react": React, "next/link": link, "next/navigation": { notFound: () => { throw new Error("404"); }, redirect: () => assert.fail("OFF redirect") },
      "@/i18n": i18n, "@/server/format": format, "@/server/consent-gate": { requireCurrentConsent: async () => {} },
      "@/server/session": { getSession: async () => ({ ...actor, locale }) },
      "@/server/brand-v2": { brandV2EnabledForOrg: async () => v2 }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => false },
      "@/components/v3/o/report/page": { OwnerReportPage: () => assert.fail("OFF v3"), OwnerReportLoading: () => assert.fail("OFF loading") },
      "@/server/queries": { listStatements: async () => empty ? [] : [{ ...row, rent }], statementDetail: async () => detail },
      "@/server/auth": { ownerPrivacy: async () => ({ showName: false }), tenantDisplayNames: async () => ["Private Tenant"] },
      "@/server/privacy": privacy, "@/components/pdf-download-button": pdf, "@/components/statement-document": document,
      "@/server/owner-net-ledger": { ownerNetLedgerView: async () => ({ versions: [] }) },
      "@/server/owner-net-ledger-presentation": { ledgerPanelView: () => ({ original: true }) },
      "@/components/owner-net-ledger-panel": ledgerPanel, "@/components/owner-report-replies": repliesPanel,
      "@/server/owner-finance-replies": { ownerTransferHistory: async () => [], reportRepliesView: async () => ({}) },
      "@/server/owner-finance-replies-presentation": { repliesPanelView: () => ({ original: true }) },
    };
    for (const path of ["src/app/o/statements/page.tsx", "src/app/o/statements/[id]/page.tsx"]) {
      type Page = { default: (p: unknown) => Promise<React.ReactNode> };
      const before = compile<Page>(old(path), { ...mocks, "@/components/statement-document": compile(old("src/components/statement-document.tsx"), docMocks) }).default;
      const after = compile<Page>(source(path), mocks).default;
      const props = { params: Promise.resolve({ id: row.id }), searchParams: Promise.resolve({ month: "invalid" }) };
      if (empty && path.includes("[id]")) { await assert.rejects(before(props), /404/); await assert.rejects(after(props), /404/); }
      else assert.equal(renderToStaticMarkup(await after(props)), renderToStaticMarkup(await before(props)), `${path}/${locale}/${v2}/${rent}/${empty}`);
    }
  }
});

test("O-RPT: latest default, invalid/absent/array months and nearest issued navigation across gaps and years", () => {
  const { selectReportMonth } = model();
  const rows = [row, { ...row, id: "old", period_start: "2025-12-01" }, { ...row, id: "middle", period_start: "2026-07-01" }, { ...row, id: "draft", period_start: "2027-01-01", status: "draft" }];
  for (const value of [undefined, "", "2026-13", "2026-7", "2026-09", ["2026-07"], "2026-10&x=1"]) {
    const selected = selectReportMonth(rows, value);
    assert.equal(selected.month, "2026-10"); assert.equal(selected.previous, "2026-07"); assert.equal(selected.next, undefined);
  }
  const middle = selectReportMonth(rows, "2026-07"); assert.equal(middle.previous, "2025-12"); assert.equal(middle.next, "2026-10");
  assert.equal(selectReportMonth(rows, "2025-12").previous, undefined);
  assert.equal(selectReportMonth([], undefined).month, undefined);
});

test("O-RPT / OWN-02: every issued statement in the month, ordered property then currency", async () => {
  const rows = [{ ...row, id: "b", properties: "B" }, { ...row, id: "usd", currency: "USD" }, row, { ...row, id: "void", status: "void" }];
  const m = model({
    listStatements: async () => [...rows, { ...row, id: "historical", period_start: "2025-12-01" }],
    ownerStatementPropertyNames: async (_s: Session, ids: string[]) => {
      assert.deepEqual([...ids].sort(), ["b", "s1", "usd"]);
      return rows.filter(r => ids.includes(r.id)).map(r => ({ id: r.id, properties: r.properties }));
    },
  });
  const data = await m.loadOwnerReport(actor, "2026-10");
  assert.deepEqual(data.reports.map(r => r.id), ["s1", "usd", "b"]);
  assert.deepEqual(m.reads, ["s1", "usd", "b"]);
  assert.equal(data.previous, "2025-12");
});

test("O-RPT / OWN-27-AC4 / OWN-02 / OWN-21: original document figures and lines, privacy retained; no invented one-off section", async () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const data = await model().loadOwnerReport({ ...actor, locale }, undefined);
    const { OwnerReportView } = ui();
    const html = renderToStaticMarkup(<OwnerReportView data={data} locale={locale} />);
    const Document = document.StatementDocument;
    const expected = renderToStaticMarkup(<Document v2 t={i18n.makeT(locale)} locale={locale} row={row} lines={data.reports[0].lines} note={<p className="small">{i18n.makeT(locale)("i_actor")}</p>} />);
    for (const id of ["statement-opening", "statement-rent", "statement-fee", "statement-payouts", "statement-net", "statement-closing", "statement-formula", "statement-line", "statement-line-amount"]) {
      const matches = (text: string) => [...text.matchAll(new RegExp(`data-testid="${id}"[^>]*>(.*?)</(?:td|p)>`, "g"))].map(m => m[1]);
      assert.deepEqual(matches(html), matches(expected), id); assert.ok(matches(expected).length, id);
    }
    assert.doesNotMatch(html, /Private Tenant|一次性費用|19-envelope/);
    assert.match(html, new RegExp(copy.brandV3OwnerReportCopy(locale).note.replaceAll(".", "\\.")));
    assert.match(html, /data-href="\/api\/pdf\/statements\/s1"/);
  }
});

test("O-RPT-SRC / D14: disclosure only within rent; hidden on unavailable or incomplete provenance", async () => {
  const { OwnerReportView } = ui();
  for (const read of [async () => ({ count: 2, date: "2026-10-05" }), async () => null, async () => { throw new Error("source unavailable"); }]) {
    const data = await model({ ownerStatementRentSource: read }).loadOwnerReport(actor, undefined);
    const html = renderToStaticMarkup(<OwnerReportView data={data} locale="zh-TW" />);
    if (data.reports[0].source) {
      assert.equal((html.match(/查來源/g) ?? []).length, 1);
      assert.match(html, /<td>租金收入<details[^>]*data-testid="report-rent-source"/);
      assert.match(html, /2 筆已確認的繳款・2026-10-05/);
    } else assert.doesNotMatch(html, /查來源|report-rent-source/);
    assert.match(html, /statement-rent/);
  }
});

test("O-RPT-EMPTY / O-STATES: only shipped empty text, blank loading, in-place error and retry", async () => {
  const { OwnerReportView, OwnerReportLoading, OwnerReportPage } = ui();
  const data = await model({ listStatements: async () => [], ownerStatementPropertyNames: async () => assert.fail("empty report has no property query") }).loadOwnerReport(actor, undefined);
  assert.deepEqual(data.reports, []);
  const empty = renderToStaticMarkup(<OwnerReportView data={data} locale="zh-TW" />);
  assert.match(empty, new RegExp(i18n.makeT("zh-TW")("i_statement_empty")));
  assert.doesNotMatch(empty, /svg|img|沒有月報|statement-document|查來源/);
  const loading = renderToStaticMarkup(<OwnerReportLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/); assert.doesNotMatch(loading, /NT\$|0 件|statement-rent/);
  const failure = renderToStaticMarkup(await OwnerReportPage({ session: actor, month: "2026-10" }));
  assert.match(failure, /這裡暫時讀不到，請再試一次。/); assert.match(failure, /href="\/o\/statements\?month=2026-10"[^>]*>再試一次/);
  assert.doesNotMatch(failure, /statement-document|NT\$|btn pri/);
});

test("O-RPT / OWN-02: removed authority after listing produces error without partial figures", async () => {
  const { loadOwnerReport } = model({ statementDetail: async () => null });
  await assert.rejects(loadOwnerReport(actor, undefined), /Report unavailable/);
  const { OwnerReportPage } = ui(loadOwnerReport);
  const html = renderToStaticMarkup(await OwnerReportPage({ session: actor, month: undefined }));
  assert.match(html, /owner-report-error/); assert.doesNotMatch(html, /statement-rent/);
});

test("O-RPT: ON list resolves required searchParams and streams blank loading; detail redirects only authorized issued ids", async () => {
  const calls: string[] = [];
  const mocks = {
    "react": React, "next/link": link, "@/i18n": i18n, "@/server/format": format,
    "@/server/consent-gate": { requireCurrentConsent: async () => { calls.push("consent"); } },
    "@/server/session": { getSession: async () => actor }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => true },
    "@/server/brand-v2": { brandV2EnabledForOrg: async () => true },
    "@/components/v3/o/report/page": { OwnerReportPage: (p: { month: string }) => <div data-month={p.month} />, OwnerReportLoading: () => <div aria-busy="true" /> },
    "@/server/queries": { listStatements: async () => assert.fail("ON legacy list"), statementDetail: async (_s: Session, id: string) => id === "allowed" ? { statement: row, lines } : null },
    "next/navigation": { redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); }, notFound: () => { throw new Error("404"); } },
    "@/server/auth": { ownerPrivacy: async () => assert.fail("read after redirect") }, "@/server/privacy": privacy,
    "@/components/pdf-download-button": pdf, "@/components/statement-document": document,
    "@/components/owner-net-ledger-panel": ledgerPanel, "@/server/owner-net-ledger": {}, "@/server/owner-net-ledger-presentation": {},
    "@/components/owner-report-replies": repliesPanel, "@/server/owner-finance-replies": {}, "@/server/owner-finance-replies-presentation": {},
  };
  type Page = { default: (p: unknown) => Promise<React.ReactNode> };
  const list = compile<Page>(source("src/app/o/statements/page.tsx"), mocks).default;
  const html = renderToStaticMarkup(await list({ searchParams: Promise.resolve({ month: "2026-07" }) }));
  assert.match(html, /data-month="2026-07"/);
  const detail = compile<Page>(source("src/app/o/statements/[id]/page.tsx"), mocks).default;
  await assert.rejects(detail({ params: Promise.resolve({ id: "allowed" }) }), /REDIRECT \/o\/statements\?month=2026-10/);
  await assert.rejects(detail({ params: Promise.resolve({ id: "foreign" }) }), /^Error: 404$/);
  assert.equal(calls.length, 3);
});

// Execute the actual reader functions with a transaction spy; no privileged or live DB.
function queryReaders(result: unknown) {
  const text = source("src/server/queries.ts");
  const list = text.slice(text.indexOf("export async function listStatements"), text.indexOf("export type RosterRow"));
  const properties = text.slice(text.indexOf("export async function ownerStatementPropertyNames"), text.indexOf("/** O-RPT-SRC:"));
  const rent = text.slice(text.indexOf("export async function ownerStatementRentSource"), text.indexOf("export async function listTicketProperties"));
  const calls: Array<{ sql: string; params: unknown }> = []; const events: unknown[] = [];
  const deps = {
    guardEffectiveSession: async (s: Session, key: string) => { events.push(["guard", s, key]); return s; },
    admitCustomRead: async () => {}, ownerStatementScope: scope.ownerStatementScope, ownerPropertyScope: scope.ownerPropertyScope,
    requireOrgScope: (s: Session) => ({ orgId: s.orgId, environment: s.environment }), effectiveReadOptions: () => undefined,
    tx: async (user: string, fn: (client: object) => unknown, org: unknown, options: unknown) => { events.push(["tx", user, org, options]); return fn({}); },
    withEffectiveReadAuthority: async (_client: unknown, _session: Session, key: string, fn: () => unknown) => { events.push(["authority", key]); return fn(); },
    maybe: async (_client: unknown, sql: string, params: unknown) => { calls.push({ sql, params }); return result; },
    many: async (_client: unknown, sql: string, params: unknown) => { calls.push({ sql, params }); return []; },
  };
  const imports = `import { ${Object.keys(deps).join(",")} } from "test-deps";\n`;
  return { calls, events, ...compile<{ listStatements: (s: Session) => Promise<unknown>; ownerStatementPropertyNames: (s: Session, ids: string[]) => Promise<unknown>; ownerStatementRentSource: (s: Session, id: string) => Promise<unknown> }>(imports + list + properties + rent, { "test-deps": deps }) };
}

test("O-RPT-SRC / OWN-02: bound owner SQL, B-017 guard, same scope, read-only snapshot; incomplete sources hidden", async () => {
  for (const result of [null, { complete: false, count: "2", date: "2026-10-05" }, { complete: true, count: "0", date: null }, { complete: true, count: "9007199254740993", date: "2026-10-05" }, { complete: true, count: "2", date: "2026-10-05" }]) {
    const reader = queryReaders(result);
    const value = await reader.ownerStatementRentSource(actor, "statement-id");
    assert.deepEqual(value, result?.complete && result.count === "2" ? { count: 2, date: "2026-10-05" } : null);
    assert.deepEqual(reader.calls[0].params, ["statement-id", actor.orgId]);
    const sql = reader.calls[0].sql;
    assert.ok(sql.includes(scope.ownerStatementScope)); assert.ok(sql.includes(scope.ownerPropertyScope("p.property_id")));
    for (const fragment of ["p.ledger_transaction_id=sl.ledger_transaction_id", "p.status='confirmed'", "NOT p.is_deposit", "sum(amount_minor)=rent_received_minor", "count(DISTINCT payment_id)", "max(confirmed_at)", "p.updated_at<=s.issued_at",
      "sum(sl.amount_minor) OVER (PARTITION BY p.id)", "attributed_minor>0 AND attributed_minor<=payment_amount", "count(line_id)=count(DISTINCT line_id)",
      "p.confirmed_at<=s.issued_at", "p.paid_on BETWEEN s.period_start AND s.period_end", "p.currency=s.currency", "p.property_id=sl.property_id"]) assert.ok(sql.includes(fragment), fragment);
    assert.deepEqual(reader.events[0], ["guard", actor, "stmt.view"]);
    assert.deepEqual(reader.events[1], ["tx", actor.userId, { orgId: actor.orgId, environment: actor.environment }, { isolation: "repeatable read", readOnly: true }]);
    assert.deepEqual(reader.events[2], ["authority", "stmt.view"]);
  }
  const denied = queryReaders(null);
  assert.equal(await denied.ownerStatementRentSource({ ...actor, kind: "staff" }, "id"), null); assert.equal(denied.calls.length, 0);
});

test("O-RPT / OWN-02: month property lookup is bounded, owner-scoped and read-only; legacy SQL bytes unchanged", async () => {
  const reader = queryReaders(null);
  await reader.listStatements(actor);
  const ids = Array.from({ length: 205 }, (_, i) => `statement-${i}`);
  await reader.ownerStatementPropertyNames(actor, [...ids, ids[0]]);
  assert.equal(reader.calls.length, 4);
  for (let i = 1; i <= 3; i++) {
    assert.deepEqual(reader.calls[i].params, [ids.slice((i - 1) * 100, i * 100), actor.orgId]);
    assert.match(reader.calls[i].sql, /s.id=ANY\(\$1::uuid\[\]\) AND s.org_id=\$2/);
    assert.ok(reader.calls[i].sql.includes(scope.ownerStatementScope));
  }
  assert.ok(reader.events.some(e => JSON.stringify(e) === JSON.stringify(["tx", actor.userId,
    { orgId: actor.orgId, environment: actor.environment }, { isolation: "repeatable read", readOnly: true }])));
  const noQuery = queryReaders(null);
  assert.deepEqual(await noQuery.ownerStatementPropertyNames(actor, []), []);
  assert.deepEqual(await noQuery.ownerStatementPropertyNames({ ...actor, kind: "staff" }, ids), []);
  assert.equal(noQuery.calls.length, 0);
  assert.ok(reader.calls[1].sql.includes(scope.ownerStatementScope)); assert.match(reader.calls[1].sql, /string_agg\(p.name/);
  assert.doesNotMatch(reader.calls[0].sql, /string_agg/);
  // Pin the legacy SELECT literally; property names are a separate month-only query.
  const original = old("src/server/queries.ts");
  const snippet = original.slice(original.indexOf("export async function listStatements"), original.indexOf("export type RosterRow"));
  const template = snippet.slice(snippet.indexOf("`SELECT") + 1, snippet.indexOf("`,\n      [session.orgId]"));
  assert.equal(reader.calls[0].sql, template.replace('${session.kind === "owner" ? `AND ${ownerStatementScope}` : ""}', `AND ${scope.ownerStatementScope}`));
});

test("O-RPT / O-STATES: CSS stays v3-scoped, token colors, 44px targets, no filled primary", () => {
  const css = source("public/brand/v3/theme.css").split("/* Batch 2 O-RPT:")[1];
  const tree = postcss.parse(css.slice(css.indexOf("*/") + 2));
  tree.walkRules(rule => { for (const selector of rule.selectors) assert.ok(selector.startsWith('html[data-brand="v2"][data-brand-v3] .v3-owner-report')); });
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(|gradient\(/i);
  assert.match(css, /min-width: 44px; min-height: 44px/);
  assert.match(css, /\.btn:hover \{ background: var\(--c-surface\)/);
  const first = JSON.parse(source("package.json")).scripts["test:unit"].split("&&")[0];
  assert.ok(first.includes("src/server/owner-report-v3.test.tsx"));
});
