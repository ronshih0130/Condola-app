import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as i18n from "../i18n";
import * as copy from "../i18n/lanes/brand-v3";
import * as bankCopy from "../i18n/bank-matching";
import * as rules from "./bank-matching-rules";
import * as format from "./format";
import { bankCandidateState, type BankMonth, type BankMonthRow } from "./b3-bank-month";
import { EmptyState } from "../components/empty-state";

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
const ui = compile(source("src/components/v3/m/bank/bank.tsx"), {
  "../../../../i18n": i18n, "../../../../i18n/lanes/brand-v3": copy, "../../../../i18n/bank-matching": bankCopy,
  "../../../../server/bank-matching-rules": rules, "../../../../server/format": format, "../../../empty-state": { EmptyState },
  "next/link": { default: ({ children, ...props }: React.PropsWithChildren<{ href: string }>) => <a {...props}>{children}</a> },
  "next/navigation": { useRouter: () => ({ refresh() {} }) },
});
const View = ui.BankMonthView as typeof import("../components/v3/m/bank/bank").BankMonthView;
const Decision = ui.BankDecision as typeof import("../components/v3/m/bank/bank").BankDecision;
const Loading = ui.BankLoading as typeof import("../components/v3/m/bank/bank").BankLoading;
const submit = ui.submitBankRequest as typeof import("../components/v3/m/bank/bank").submitBankRequest;
const href = ui.bankHref as typeof import("../components/v3/m/bank/bank").bankHref;
const adjacent = ui.adjacentBankMonth as typeof import("../components/v3/m/bank/bank").adjacentBankMonth;
const amount = ui.bankAmount as typeof import("../components/v3/m/bank/bank").bankAmount;
const candidate = { paymentId: "payment", suggestionId: "suggestion", name: "Synthetic", paidOn: "2030-05-12", amountMinor: "3200000", currency: "TWD",
  basis: { amountExact: true, last5Matched: true, dateDeltaDays: 0 }, invoices: [{ id: "invoice", month: "2030-04", number: "INV-1", amountMinor: "3200000" }] };
const row: BankMonthRow = { id: "bank1", postedOn: "2030-05-12", last5: "12345", amountMinor: "3200000", currency: "TWD", memo: "Synthetic memo", account: "Synthetic account", status: "suggested", candidates: [candidate], candidateState: { kind: "exact", count: 1 } };
const ready: Extract<BankMonth, { state: "ready" }> = { state: "ready", month: "2030-05", filter: "review", timezone: "UTC",
  counts: { all: 42, matched: 36, review: 4, ignored: 2 }, filteredCount: 4, lastUploadAt: "2030-06-01T12:00:00Z", lastUploadScope: "org_unarchived_accounts_all_time",
  accounts: [{ id: "account", nickname: "Synthetic account", currency: "TWD" }], rows: [row], nextCursor: null };

test("R1-BANK labels/actions, exactly one solid primary, counts and upload scope; zh/en", () => {
  const several = [candidate, { ...candidate, paymentId: "p2", suggestionId: "s2", basis: { ...candidate.basis, dateDeltaDays: 2 } }];
  const sameDay = [candidate, { ...candidate, paymentId: "p3", suggestionId: "s3" }];
  const rows = [row, { ...row, id: "bank2", candidates: several, candidateState: bankCandidateState(several) },
    { ...row, id: "bank3", candidates: sameDay, candidateState: bankCandidateState(sameDay) },
    { ...row, id: "bank4", candidates: [], candidateState: bankCandidateState([]) }];
  const html = renderToStaticMarkup(<View data={{ ...ready, rows }} locale="zh-TW" />);
  for (const text of ["5 月的銀行明細有 42 筆，36 筆已經對上，4 筆要你看。", "三樣都對上，還沒確認", "有 2 筆可能", "同一天同金額有 2 筆", "沒有對得上的帳單", "確認配對", "不是這筆", "選一筆", "手動配對", "本組織未封存帳戶，不限月份。", "Synthetic memo", "INV-1", "2030-04"]) assert.ok(html.includes(text), text);
  assert.equal((html.match(/class="btn pri"/g) ?? []).length, 1);
  assert.equal((html.match(/data-testid="bank-row"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /onclick=|自動配對|自動確認/);
  const en = renderToStaticMarkup(<View data={ready} locale="en" />); assert.match(en, /All three match, not confirmed yet/);
  for (const status of ["matched", "ignored"] as const) {
    const done = renderToStaticMarkup(<View data={{ ...ready, rows: [{ ...row, status }] }} locale="zh-TW" />);
    assert.doesNotMatch(done, /<button[^>]*>確認配對|<button[^>]*>不是這筆/);
  }
});

test("loading and failure have no figures; retry preserves context; empty uses shipped BANK copy", () => {
  const loading = renderToStaticMarkup(<Loading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/); assert.doesNotMatch(loading, /0 筆|NT\$|月的銀行明細有/);
  const error = renderToStaticMarkup(<View data={{ state: "unavailable" }} locale="zh-TW" month="2030-04" filter="all" cursor="abc" />);
  assert.match(error, /再試一次/); assert.match(error, /month=2030-04/); assert.match(error, /filter=all/); assert.match(error, /cursor=abc/);
  assert.doesNotMatch(error, /0 筆|NT\$|還沒有對帳建議/);
  const empty = renderToStaticMarkup(<View data={{ ...ready, counts: { all: 0, matched: 0, review: 0, ignored: 0 }, filteredCount: 0, rows: [] }} locale="zh-TW" />);
  assert.match(empty, /還沒有對帳建議/); assert.match(empty, /上傳銀行明細後，會比對租客的繳租回報讓你確認。/);
  assert.equal((empty.match(/class="btn pri"/g) ?? []).length, 1);
});

test("decision UI keeps explicit reason, stored basis and payment target; no candidates disables confirmation", () => {
  const html = renderToStaticMarkup(<Decision row={row} locale="zh-TW" mode="match" onClose={() => {}} onSuccess={() => {}} />);
  assert.match(html, /name="reason"[^>]*required/); assert.match(html, /建立建議時的依據/); assert.match(html, /日期相差 0 天/);
  assert.match(html, /value="suggestion:suggestion"/); assert.doesNotMatch(html, /btn pri|name="invoiceId"/);
  const empty = renderToStaticMarkup(<Decision row={{ ...row, candidates: [] }} locale="zh-TW" mode="match" onClose={() => {}} onSuccess={() => {}} />);
  assert.match(empty, /沒有對得上的帳單/); assert.match(empty, /<button class="btn" disabled="">確認配對/);
  assert.match(source("src/components/v3/m/bank/bank.tsx"), /No optimistic financial state/);
});

test("month and chip changes discard cursor; keyset next keeps filter; signed/large minor values survive", () => {
  assert.equal(adjacent("2030-01", -1), "2029-12"); assert.equal(adjacent("2030-12", 1), "2031-01");
  assert.equal(href("2030-05", "matched"), "/m/bank?filter=matched&month=2030-05");
  assert.match(href("2030-05", "all", "abc"), /cursor=abc/);
  assert.match(amount("-10000", "TWD", "zh-TW"), /-NT\$100|NT\$-100/);
  assert.equal(amount("9007199254740993", "USD", "en"), "USD 90071992547409.93");
});

test("v3 submits unchanged decision payloads and file to the existing API; failed responses never count as success", async () => {
  for (const payload of [{ bankId: "b", suggestionId: "s", decision: "match", reason: "confirmed_amount" },
    { bankId: "b", suggestionId: "s", decision: "reject", reason: "wrong_payment" },
    { bankId: "b", paymentId: "p", decision: "match", reason: "other" }] as Record<string, string>[]) {
    await submit(payload, async (url, init) => {
      assert.equal(url, "/api/bank/matching"); assert.equal(init?.method, "POST"); assert.deepEqual(JSON.parse(String(init?.body)), payload);
      return Response.json({ ok: true });
    });
  }
  const file = new FormData(); file.set("file", new File(["date,amount\n2030-05-01,1"], "synthetic.csv"));
  await submit(file, async (_url, init) => { assert.equal(init?.body, file); assert.equal(init?.headers, undefined); return Response.json({ ok: true }); });
  for (const [status, ok] of [[400, false], [403, false], [200, false]] as const) await assert.rejects(submit({}, async () => Response.json({ ok }, { status })));
  await assert.rejects(submit({}, async () => { throw new Error("offline"); }));
});

const baseline = (path: string) => execFileSync("git", ["show", `52e290f1219813968331b9294f58c995ff4e3925:${path}`], { encoding: "utf8" });
test("OFF page is byte-identical after the v3 fork; existing read order and decision checks unchanged", async () => {
  const path = "src/app/m/bank/page.tsx", old = baseline(path), current = source(path);
  const marker = "  if (await bankMatchingEnabled(session)) {", now = "  if (matching) {";
  // The legacy branches after the matching check are byte-identical; only the condition line now reuses the read value.
  assert.ok(current.includes(now)); assert.equal(current.slice(current.indexOf(now) + now.length), old.slice(old.indexOf(marker) + marker.length));
  assert.match(current, /searchParams: Promise<BankSearchParams>/); assert.doesNotMatch(current, /BankPage\([^\n]*=\s*\{/);
  for (const file of ["src/server/bank-matching.ts", "src/server/bank-matching-actions.ts"]) assert.equal(source(file), baseline(file));
  // The JSON route changes in exactly one way: it forwards a client requestId to decideBankMatch (B009 idempotency, Codex r1).
  assert.equal(source("src/app/api/bank/matching/route.ts"), baseline("src/app/api/bank/matching/route.ts").replace(
    'suggestionId:typeof body.suggestionId === "string" ? body.suggestionId : undefined});',
    'suggestionId:typeof body.suggestionId === "string" ? body.suggestionId : undefined,...(typeof body.requestId === "string" ? {requestId:body.requestId} : {})});'));
  for (const matching of [false, true]) {
    const trace: string[] = [];
    const box = (name: string) => function Box(props: Record<string, unknown>) { return <div data-test={name}>{JSON.stringify(props, (_key, v) => typeof v === "function" ? undefined : v)}</div>; };
    const mocks = {
      "@/server/consent-gate": { requireCurrentConsent: async () => { trace.push("consent"); } },
      "@/server/session": { getSession: async () => { trace.push("session"); return { orgId: "org", locale: "en" }; } },
      "@/i18n": { makeT: () => (key: string) => key }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => false },
      "@/components/v3/m/bank/page": { BankV3Page: () => { throw new Error("OFF invokes v3"); } },
      "@/components/v3/m/bank/bank": { BankLoading: () => null },
      "@/server/bank-matching": { bankMatchingEnabled: async () => { trace.push("enabled"); return matching; }, bankBoard: async () => { trace.push("board"); return { synthetic: true }; } },
      "@/server/queries": { latestUnmatchedPayment: async () => { trace.push("payment"); return null; }, listMatches: async () => { trace.push("matches"); return []; } },
      "@/components/management-empty-state": { ManagementEmptyState: box("empty") }, "@/components/bank-matching": { BankMatching: box("bank") },
      "@/components/dialogs": { ApproveForm: box("approve"), BankImport: box("upload") }, "@/components/ui": { ErrorBanner: box("error"), PageHeader: box("header") },
      "@/server/domain": { sampleCsv: () => "" }, "@/server/format": format, "@/server/sandbox-data": { displaySampleName: (s: string) => s },
    };
    const render = async (text: string) => {
      trace.length = 0;
      const page = compile(text, mocks).default as (props: { searchParams: Promise<{ error?: string }> }) => Promise<React.ReactNode>;
      const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve({}) })); return { html, trace: [...trace] };
    };
    assert.deepEqual(await render(current), await render(old));
  }
});

test("existing API executes consent + literal bank.reconcile + existing ops for accept/reject/manual/import", async () => {
  const trace: unknown[] = [];
  const session = { orgId: "synthetic" };
  const api = compile(source("src/app/api/bank/matching/route.ts"), {
    "@/server/session": { readSession: async () => session },
    "@/server/b017-custom-role-governance": { guardEffectiveSession: async (s: unknown, key: string) => { trace.push(key); return s; } },
    "@/server/consent-gate": { requireCurrentConsent: async () => { trace.push("consent"); return null; } },
    "@/server/bank-matching": { decideBankMatch: async (s: unknown, input: unknown) => { assert.equal(s, session); trace.push(input); return true; },
      importBankFile: async (...args: unknown[]) => { trace.push(args); return { duplicate: true }; } },
    "next/server": { NextResponse: Response },
  }).POST as (r: Request) => Promise<Response>;
  for (const body of [{ bankId: "b", suggestionId: "s", decision: "match", reason: "confirmed_amount" },
    { bankId: "b", suggestionId: "s", decision: "reject", reason: "wrong_payment" }, { bankId: "b", paymentId: "p", decision: "match", reason: "other" }]) {
    trace.length = 0; const response = await api(new Request("http://localhost/api/bank/matching", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal(response.status, 200); assert.deepEqual(trace.slice(0, 2), ["bank.reconcile", "consent"]);
    assert.deepEqual(trace[2], { paymentId: undefined, suggestionId: undefined, ...body });
  }
  const form = new FormData(); form.set("file", new File(["date,amount\n2030-05-01,1"], "synthetic.csv")); form.set("account", "a"); form.set("encoding", "utf-8"); form.set("dateFormat", "iso");
  trace.length = 0; const response = await api(new Request("http://localhost/api/bank/matching", { method: "POST", body: form }));
  assert.equal(response.status, 200); assert.deepEqual(trace.slice(0, 2), ["bank.reconcile", "consent"]); assert.equal((trace[2] as unknown[])[1], "a");
});


test("client uses the existing closed reason set without importing server crypto", () => {
  for (const locale of ["zh-TW", "en"] as const) assert.deepEqual(Object.keys(bankCopy.bankMatchingStrings(locale).reasons), [...rules.BANK_MATCH_REASON_CODES]);
  assert.doesNotMatch(source("src/components/v3/m/bank/bank.tsx"), /import.*bank-matching-rules|node:crypto/);
});

test("R1-BANK-ROW / B009: the JSON decision route forwards requestId; the v3 panel reuses one id per operation (Codex r1)", async () => {
  const seen: unknown[] = [];
  const route = compile(source("src/app/api/bank/matching/route.ts"), {
    "@/server/b017-custom-role-governance": { guardEffectiveSession: async () => ({ orgId: "org", userId: "user" }) },
    "@/server/consent-gate": { requireCurrentConsent: async () => null },
    "@/server/bank-matching": { decideBankMatch: async (_session: unknown, input: unknown) => { seen.push(input); return true; }, importBankFile: async () => null },
    "@/server/session": { readSession: async () => ({}) },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
  }).POST as (request: Request) => Promise<Response>;
  const id = "0b9c3a52-5d0e-4c6b-9a3a-2f6f1b6f8c11";
  const post = (body: Record<string, string>) => route(new Request("http://x/api/bank/matching", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await post({ bankId: "bank1", decision: "match", reason: "r", suggestionId: "s", requestId: id })).status, 200);
  assert.equal((seen[0] as { requestId?: string }).requestId, id);
  await post({ bankId: "bank1", decision: "reject", reason: "r", suggestionId: "s" });
  assert.equal((seen[1] as { requestId?: string }).requestId, undefined, "absent id stays absent (legacy callers)");
  // Client: the operation key covers bank row, decision, candidate and reason; the same key keeps its id (retry after a
  // lost response returns the stored receipt), a different key gets a fresh id.
  const ui = source("src/components/v3/m/bank/bank.tsx");
  assert.match(ui, /const key = JSON\.stringify\(\[row\.id, mode, candidateKey\(selected\), reason\]\);/);
  assert.match(ui, /if \(operation\.current\?\.key !== key\) operation\.current = \{ key, id: crypto\.randomUUID\(\) \};/);
  assert.match(ui, /requestId: operation\.current\.id/);
});

test("R1-BANK: brand_v3 ON without bank_matching keeps today's import/match page (no v3 unavailable state)", async () => {
  const trace: string[] = [];
  const box = (name: string) => function Box() { return <div data-test={name} />; };
  for (const [matching, expectV3] of [[false, false], [true, true]] as const) {
    let v3Rendered = false;
    const mocks = {
      "@/server/consent-gate": { requireCurrentConsent: async () => {} },
      "@/server/session": { getSession: async () => ({ orgId: "org", locale: "en" }) },
      "@/i18n": { makeT: () => (key: string) => key }, "@/server/brand-v3": { brandV3EnabledForOrg: async () => { trace.push("v3"); return true; } },
      "@/components/v3/m/bank/page": { BankV3Page: () => { v3Rendered = true; return <div data-test="v3" />; } },
      "@/components/v3/m/bank/bank": { BankLoading: () => null },
      "@/server/bank-matching": { bankMatchingEnabled: async () => matching, bankBoard: async () => ({ synthetic: true }) },
      "@/server/queries": { latestUnmatchedPayment: async () => null, listMatches: async () => [] },
      "@/components/management-empty-state": { ManagementEmptyState: box("empty") }, "@/components/bank-matching": { BankMatching: box("bank") },
      "@/components/dialogs": { ApproveForm: box("approve"), BankImport: box("upload") }, "@/components/ui": { ErrorBanner: box("error"), PageHeader: box("header") },
      "@/server/domain": { sampleCsv: () => "" }, "@/server/format": format, "@/server/sandbox-data": { displaySampleName: (x: string) => x },
    };
    const page = compile(source("src/app/m/bank/page.tsx"), mocks).default as (props: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactNode>;
    const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve({}) }));
    if (expectV3) assert.match(html, /<link rel="stylesheet" href="\/brand\/v3\/bank.css"/);
    else { assert.equal(v3Rendered, false); assert.match(html, /data-test="upload"/); assert.doesNotMatch(html, /bank\.css/); }
  }
});

