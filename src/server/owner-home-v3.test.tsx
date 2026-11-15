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
import * as repairCopy from "../i18n/repair-approval";
import * as rules from "./repair-approval-rules";
import * as wire from "../app/o/approvals/decision-request";
import { Illustration } from "../components/v3/illustrations";
import { WaitMark } from "../components/v3/wait-mark";
import type { EstimateRow, OwnerHomeState } from "../components/v3/owner/home";

const requireHere = createRequire(import.meta.url);
const source = (path: string) => readFileSync(path, "utf8");
function compile(text: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime", "node:crypto"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}
const row: EstimateRow = { ticketId: "11111111-1111-4111-8111-111111111111", versionId: "22222222-2222-4222-8222-222222222222", requestId: "33333333-3333-4333-8333-333333333333", version: "2", property: "松山公寓", item: "水龍頭", amount: "NT$5,200", vendor: "水務廠商", scope: "更換進水零件", managementExplanation: "請依這個範圍施工", emergency: null };
const emergency = compile(source("src/app/o/approvals/emergency.tsx"), { "@/server/repair-approval-rules": rules });
const uiMocks = { "../../../i18n": i18n, "../../../i18n/lanes/brand-v3": copy, "../../../i18n/repair-approval": repairCopy,
  "../../../server/repair-approval-rules": rules, "../../../app/o/approvals/decision-request": wire,
  "../../../app/o/approvals/emergency": emergency, "../illustrations": { Illustration }, "../wait-mark": { WaitMark },
  "next/navigation": { useRouter: () => ({ refresh() {}, replace() {} }) } };
const ui = compile(source("src/components/v3/owner/home.tsx"), uiMocks);
const Home = ui.OwnerHomeV3 as React.ComponentType<{ name: string; locale: i18n.Locale; state: OwnerHomeState; estimate?: string }>;
const Panel = ui.EstimatePanel as React.ComponentType<{ row: EstimateRow; locale: i18n.Locale; onClose: () => void; onReturned: () => void }>;

test("O-HOME / O-ROW / OWN-26-AC1…4: uncapped rows, NONAME, no summary or other task types", () => {
  const rows = Array.from({ length: 57 }, (_, n) => ({ ...row, versionId: String(n) }));
  for (const name of ["林小姐", "", "  "]) {
    const html = renderToStaticMarkup(<Home name={name} locale="zh-TW" state={{ status: "ready", rows }} />);
    assert.match(html, /有 57 件事要你處理。/);
    assert.equal(html.includes("林小姐，有"), Boolean(name.trim()));
    assert.equal((html.match(/data-testid="owner-estimate-row"/g) ?? []).length, 57);
    assert.match(html, /松山公寓水龍頭/); assert.match(html, /估價 NT\$5,200/); assert.match(html, /待核准/);
    assert.doesNotMatch(html, /owner-primary|總覽|空租|續約|退租|確認已收到/);
  }
});
test("O-EMPTY / O-STATES / OWN-26-AC6…8 / P52: zero uses home title, errors never masquerade as zero", () => {
  const empty = renderToStaticMarkup(<Home name="林小姐" locale="zh-TW" state={{ status: "ready", rows: [] }} />);
  assert.match(empty, /<h2[^>]*>首頁<\/h2>/); assert.match(empty, /data-v3-illustration="20"/);
  assert.match(empty, /目前沒有要你處理的事，放心。/); assert.doesNotMatch(empty, /0 件|看總覽|owner-primary/);
  const failed = renderToStaticMarkup(<Home name="林小姐" locale="zh-TW" state={{ status: "error" }} />);
  assert.match(failed, /這裡暫時讀不到，請再試一次。/); assert.match(failed, /再試一次/);
  assert.equal((failed.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(failed, /0 件|目前沒有|data-v3-illustration/);
});
test("O-EST / OWN-31-AC1 / P52: fields, optional version and unlabeled management explanation", () => {
  for (const version of ["1", "2"]) {
    const html = renderToStaticMarkup(<Panel row={{ ...row, version }} locale="zh-TW" onClose={() => {}} onReturned={() => {}} />);
    for (const label of ["核准這筆估價", "物件", "項目", "估價", "廠商", "說明", row.scope, row.managementExplanation!]) assert.ok(html.includes(label));
    assert.equal(html.includes("第 2 版"), version === "2");
    assert.doesNotMatch(html, /管理方說明|填收據抬頭|v3-completion/);
    assert.match(html, /<dd><p>更換進水零件<\/p><p>請依這個範圍施工<\/p><\/dd>/);
    assert.equal((html.match(/owner-primary/g) ?? []).length, 1);
  }
});

// Run the actual client handlers with React hook storage; fetch is the only write boundary.
function harness(component: "EstimatePanel" | "OwnerHomeV3", props: Record<string, unknown>) {
  const slots: unknown[] = []; let cursor = 0;
  const effects: (() => void | (() => void))[] = [];
  const hooks = { ...React,
    useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useId: () => "panel-id", useEffect(fn: () => void | (() => void)) { effects.push(fn); },
  };
  const exports = compile(source("src/components/v3/owner/home.tsx"), { ...uiMocks, react: hooks });
  const Component = exports[component] as (props: Record<string, unknown>) => React.ReactElement;
  return { render() { cursor = 0; effects.length = 0; return Component(props); }, effects };
}
type Element = React.ReactElement<Record<string, unknown>>;
function all(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...all(element.props.children as React.ReactNode)];
}
function button(tree: React.ReactNode, label: string) {
  const found = all(tree).find(node => node.type === "button" && node.props.children === label);
  assert.ok(found, `missing button ${label}`); return found;
}
function click(tree: React.ReactNode, label: string) { (button(tree, label).props.onClick as () => void)(); }
async function submit(tree: React.ReactNode) {
  const form = all(tree).find(node => node.type === "form")!;
  (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
}
function changeReason(tree: React.ReactNode, value: string) {
  const field = all(tree).find(node => node.type === "textarea")!;
  (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

test("O-EST / O-EST-BACK / OWN-31-AC1…5: all outcomes post existing API, reasons, retries, conflicts, done clock", async t => {
  for (const outcome of ["approved", "rejected", "more_information"] as const) {
    let returned = 0; let closed: boolean | undefined; const bodies: wire.DecisionRequest[] = [];
    t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(url, "/api/owner-repair-decision"); assert.equal(init?.method, "POST");
      bodies.push(JSON.parse(String(init?.body))); return Response.json({ status: "recorded" });
    });
    const h = harness("EstimatePanel", { row, locale: "zh-TW", onClose: (done: boolean) => { closed = done; }, onReturned: () => { returned++; } });
    let tree = h.render();
    if (outcome !== "approved") {
      click(tree, "退回"); tree = h.render();
      if (outcome === "more_information") { click(tree, "要求補充資料"); tree = h.render(); }
      await submit(tree); assert.equal(bodies.length, 0);
      assert.match(renderToStaticMarkup(h.render()), /請確認決定與原因。/);
      changeReason(h.render(), "  請補充規格  "); tree = h.render();
    }
    await submit(tree);
    assert.deepEqual(bodies, [{ requestId: row.requestId, versionId: row.versionId, decision: outcome, reason: outcome === "approved" ? null : "請補充規格" }]);
    if (outcome === "approved") {
      tree = h.render(); const html = renderToStaticMarkup(tree);
      assert.match(html, /估價已核准/); assert.match(html, /v3-wait/); assert.match(html, /核准版本/);
      assert.doesNotMatch(html, /owner-primary|completion-check|填收據抬頭/);
      click(tree, "關閉"); assert.equal(closed, true);
    } else assert.equal(returned, 1);
    t.mock.restoreAll();
  }
  let calls = 0; const bodies: wire.DecisionRequest[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); calls++; if (calls === 1) throw new Error("offline"); return Response.json({ status: "rejected_conflict" }); });
  const h = harness("EstimatePanel", { row, locale: "zh-TW", onClose() {}, onReturned() {} });
  click(h.render(), "退回"); changeReason(h.render(), "保留原因"); await submit(h.render());
  assert.match(renderToStaticMarkup(h.render()), /再試一次/);
  assert.equal(all(h.render()).find(node => node.type === "textarea")!.props.value, "保留原因");
  await submit(h.render()); assert.deepEqual(bodies[0], bodies[1]);
  assert.match(renderToStaticMarkup(h.render()), /版本或決定已變更，請重新查看。/);
  assert.doesNotMatch(renderToStaticMarkup(h.render()), /owner-primary/);
});

test("O-EST-BACK: whitespace and over-limit reasons never write; cancel/close never write", async t => {
  let writes = 0; let closes = 0;
  t.mock.method(globalThis, "fetch", async () => { writes++; return Response.json({ status: "recorded" }); });
  const h = harness("EstimatePanel", { row, locale: "zh-TW", onClose: () => { closes++; }, onReturned() {} });
  click(h.render(), "退回");
  for (const value of ["   ", "長".repeat(4001)]) { changeReason(h.render(), value); await submit(h.render()); }
  assert.equal(writes, 0);
  click(h.render(), "取消"); assert.match(renderToStaticMarkup(h.render()), /核准這筆估價/);
  click(h.render(), "關閉"); assert.equal(closes, 1); assert.equal(writes, 0);
});

test("O-HOME / O-EST-DONE: removal after approved close or returned success; pending deep link admission", t => {
  const originalFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => { callback(0); return 1; };
  t.after(() => { globalThis.requestAnimationFrame = originalFrame; });
  for (const returned of [false, true]) {
    const h = harness("OwnerHomeV3", { name: "林小姐", locale: "zh-TW", state: { status: "ready", rows: [row] } });
    const tree = h.render();
    (button(tree, "核准估價").props.onClick as (event: unknown) => void)({ currentTarget: { isConnected: false } });
    const panel = all(h.render()).find(node => typeof node.type === "function" && node.type.name === "EstimatePanel")!;
    assert.ok(panel); assert.match(renderToStaticMarkup(h.render()), /有 1 件/);
    if (returned) (panel.props.onReturned as () => void)(); else (panel.props.onClose as (done: boolean) => void)(true);
    const html = renderToStaticMarkup(h.render()); assert.doesNotMatch(html, /owner-estimate-row|0 件/); assert.match(html, /目前沒有要你處理/);
    if (returned) assert.match(html, /決定已記錄。/);
  }
  for (const estimate of [row.ticketId, "unknown", "decided"]) {
    const h = harness("OwnerHomeV3", { name: "", locale: "zh-TW", state: { status: "ready", rows: [row] }, estimate });
    h.render(); h.effects[0]();
    assert.equal(all(h.render()).some(node => typeof node.type === "function" && node.type.name === "EstimatePanel"), estimate === row.ticketId);
  }
});

const actor = { kind: "owner", name: "林小姐", locale: "zh-TW", orgId: "org" };
const Stub = () => <span />;
function pageMocks(v3: boolean, pending = [row]) {
  return {
    "@/server/session": { getSession: async () => actor },
    "@/server/consent-gate": { requireCurrentConsent: async () => {} },
    "@/server/b017-custom-role-governance": { guardEffectiveSession: async (session: unknown) => session },
    "@/server/brand-v2": { brandV2EnabledForOrg: async () => true },
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => v3 }, "@/i18n": i18n,
    "@/server/auth": { ownerPrivacy: async () => ({ name: "管理公司", showName: false, showPhone: false }) },
    "@/server/queries": { ownerHome: async () => [{ lease_id: "lease", tenant_name: "Hidden Name", tenant_phone: "0912345678", phone_visible: true, property_name: "物件", unit_label: "A", room_label: null, currency: "TWD", rent: "1000" }] },
    "@/server/format": { moneyLabel: () => "NT$10" }, "@/server/sandbox-data": { displaySampleName: (name: string) => name },
    "@/components/notification-center-entry": { NotificationCenterEntry: Stub },
    "@/components/v3/owner/home": { OwnerHomeV3: Home },
    "@/server/owner-home-v3": { ownerHomeEstimates: async () => ({ status: "ready", rows: pending }) },
    "@/server/repair-approval": { repairApprovalsEnabled: async () => true, ownerPending: async () => pending.map(r => ({ ticket_id: r.ticketId })), ownerHistory: async () => [] },
    "@/server/repair-rules": { isUuid: (id: string) => /^[0-9a-f-]{36}$/.test(id) },
    "./approval-cards": { ApprovalCards: Stub }, "../approval-cards": { ApprovalHistoryCards: Stub },
    "next/navigation": { redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); }, notFound: () => { throw new Error("NOT_FOUND"); } },
  };
}
const pageFunction = (text: string, mocks: Record<string, unknown>) => compile(text, mocks).default as (props?: unknown) => Promise<React.ReactNode>;
test("O-HOME / OQ-055: OFF /o and approvals HTML equal baseline; ON preserves exact privacy table", async () => {
  for (const path of ["src/app/o/page.tsx", "src/app/o/approvals/page.tsx", "src/app/o/approvals/[ticketId]/page.tsx"]) {
    const before = execFileSync("git", ["show", `7adc7c343dd3f408655a815cf19b49b669e9f6ad:${path}`], { encoding: "utf8" });
    const props = { params: Promise.resolve({ ticketId: row.ticketId }) };
    const mocks = pageMocks(false);
    const baseline = renderToStaticMarkup(await pageFunction(before, mocks)(props));
    assert.equal(renderToStaticMarkup(await pageFunction(source(path), mocks)(props)), baseline);
  }
  const html = renderToStaticMarkup(await pageFunction(source("src/app/o/page.tsx"), pageMocks(true))());
  const baseline = renderToStaticMarkup(await pageFunction(source("src/app/o/page.tsx"), pageMocks(false))());
  assert.ok(html.includes(baseline)); assert.doesNotMatch(html, /Hidden Name|0912345678/);
  assert.ok(html.indexOf("owner-task-card") < html.indexOf("v3-owner-legacy"));
  const failed = renderToStaticMarkup(await pageFunction(source("src/app/o/page.tsx"), { ...pageMocks(true), "@/server/owner-home-v3": { ownerHomeEstimates: async () => ({ status: "error" }) } })());
  assert.doesNotMatch(failed, /v3-owner-legacy|0 件/);
});
test("OQ-055 / O-EST: ON redirects list and pending detail; decided and unknown stay read-only", async () => {
  await assert.rejects(pageFunction(source("src/app/o/approvals/page.tsx"), pageMocks(true))(), /REDIRECT:\/o$/);
  const detail = pageFunction(source("src/app/o/approvals/[ticketId]/page.tsx"), pageMocks(true));
  await assert.rejects(detail({ params: Promise.resolve({ ticketId: row.ticketId }) }), new RegExp(`REDIRECT:/o\\?estimate=${row.ticketId}`));
  for (const id of ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"]) {
    const html = renderToStaticMarkup(await detail({ params: Promise.resolve({ ticketId: id }) }));
    assert.doesNotMatch(html, /<form|<button|owner-home-v3/);
  }
});

test("O-HOME / OWN-26-AC9: reader admission, emergency completeness, errors and exact scaled money", async () => {
  let enabled = false; let fail = false; let hasEmergency = false; let history = false; let pendingCalls = 0; let guarded = 0;
  const reader = compile(source("src/server/owner-home-v3.ts"), {
    // B-017: the effective-session guard runs (with no permission key, as on owner pages) before any read.
    "./b017-custom-role-governance": { guardEffectiveSession: async (session: unknown, key: unknown) => { assert.equal(key, null); guarded++; return session; } },
    "./repair-approval": {
      repairApprovalsEnabled: async () => { assert.ok(guarded > 0, "guard before the flag read"); return enabled; },
      ownerPending: async (_session: unknown, options: unknown) => { pendingCalls++; assert.deepEqual(options, { homeDetails: true }); if (fail) throw new Error("unavailable");
        return [{ ticket_id: row.ticketId, version_id: row.versionId, version_no: "2", property_name: row.property, item: row.item, vendor_name: row.vendor, amount_minor: "520000", currency: "TWD", minor_unit: 2, work_scope: row.scope, has_emergency: hasEmergency }]; },
      ownerHistory: async () => history ? [{ version_id: row.versionId, emergency_category: "water" }] : [],
    }, "./repair-approval-rules": rules, "./sandbox-data": { displaySampleName: (name: string) => name },
  });
  const read = reader.ownerHomeEstimates as (session: unknown) => Promise<OwnerHomeState>;
  assert.deepEqual(await read(actor), { status: "ready", rows: [] }); assert.equal(pendingCalls, 0);
  enabled = true; const ready = await read(actor); assert.equal(ready.status, "ready");
  if (ready.status === "ready") { assert.equal(ready.rows[0].amount, "NT$5,200"); assert.equal(ready.rows[0].managementExplanation, null); }
  fail = true; assert.deepEqual(await read(actor), { status: "error" }); fail = false;
  hasEmergency = true; assert.deepEqual(await read(actor), { status: "error" }); history = true;
  assert.equal((await read(actor)).status, "ready");
  const amount = reader.ownerEstimateAmount as (amount: string, currency: string, scale: number) => string;
  assert.equal(amount("900719925474099312", "USD", 2), "USD 9,007,199,254,740,993.12");
  assert.equal(amount("5200", "TWD", 0), "NT$5,200");
  const query = source("src/server/repair-approval.ts");
  assert.match(query, /gateway \+ "\(" \+ args/);
  assert.match(query, /t\.id=r\.ticket_id AND t\.org_id=\$1 AND t\.property_id=r\.property_id/);
  assert.match(query, /p\.id=r\.property_id AND p\.org_id=\$1/);
});
test("O-EST emergency fields preserve the existing read-only card content", () => {
  const history = { version_id: row.versionId, emergency_category: "water", emergency_reason: "水管破裂", emergency_photo_refs: [{ id: "photo-reference" }], emergency_notice_intent_at: "2026-11-15T10:00:00Z" } as NonNullable<EstimateRow["emergency"]>;
  const html = renderToStaticMarkup(<Panel row={{ ...row, emergency: history }} locale="zh-TW" onClose={() => {}} onReturned={() => {}} />);
  for (const value of ["緊急例外", "水務", "水管破裂", "photo-reference", "通知意圖", "意圖已記錄"]) assert.ok(html.includes(value));
});
test("O-EMPTY drawing 20 / O-STATES / OWN-26-AC3: token-only adopted drawing and scoped responsive CSS", () => {
  const svg = renderToStaticMarkup(<Illustration name="20" />);
  assert.match(svg, /M62 46c-6-12 2-24 14-24/); assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b/i);
  for (const match of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) assert.ok(match[1] === "none" || match[1].startsWith("var(--c-"));
  const css = source("public/brand/v3/owner.css");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i); assert.match(css, /min-height:44px/);
  assert.match(css, /@media\(min-width:64em\)/);
  for (const line of css.split("\n").filter(line => line.includes(" { "))) assert.ok(line.trim().startsWith('html[data-brand="v2"][data-brand-v3]'));
});

test("O-EST / OWN-31-AC5: in-flight duplicate submit is ignored and edited retries get a new request ID", async t => {
  let resolveResponse: (response: Response) => void = () => {};
  const bodies: wire.DecisionRequest[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return new Promise<Response>(resolve => { resolveResponse = resolve; });
    return Response.json({ status: "recorded" });
  });
  const h = harness("EstimatePanel", { row, locale: "zh-TW", onClose() {}, onReturned() {} });
  click(h.render(), "退回"); changeReason(h.render(), "原原因");
  await submit(h.render()); await submit(h.render()); assert.equal(bodies.length, 1);
  resolveResponse(Response.json({ status: "busy" })); await new Promise(resolve => setImmediate(resolve));
  changeReason(h.render(), "修改原因"); await submit(h.render());
  assert.equal(bodies.length, 2); assert.notEqual(bodies[0].requestId, bodies[1].requestId);
  assert.equal(bodies[1].reason, "修改原因");
});

test("O-EST / OWN-31-AC3: Escape closes without submitting", t => {
  let writes = 0; let closed: boolean | undefined; let prevented = false;
  t.mock.method(globalThis, "fetch", async () => { writes++; return Response.json({ status: "recorded" }); });
  const h = harness("EstimatePanel", { row, locale: "zh-TW", onClose: (done: boolean) => { closed = done; }, onReturned() {} });
  const dialog = h.render() as Element;
  (dialog.props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(closed, false); assert.equal(writes, 0);
});
