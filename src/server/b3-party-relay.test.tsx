import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ownerEstimateRelay, vendorCaseRelay, vendorRelayDrawn, vendorRelayKind, type VendorRelayKind } from "../lib/b3-party-relay";
import { OwnerEstimateRelay, VendorCaseRelay } from "../components/v3/party-relay";
import { VendorCaseView, type VendorCaseViewProps } from "../components/v3/vendor/vendor-case";
import { partyRelayCopy } from "../i18n/lanes/brand-v3-party-relay";
import { ticketRelayCopy } from "../i18n/lanes/brand-v3-ticket-relay";

// PLT-52-AC6…AC10 (GS-59…GS-63 = A, Ron 2026-11-17): owner O-EST and vendor RV-JOB relays.
const read = (path: string) => readFileSync(path, "utf8");
const steps = (html: string) => [...html.matchAll(/<span class="v3-st-l">(?:<span class="turn-tag" aria-current="step">)?([^<]+)/g)].map(m => m[1]);
const subs = (html: string) => [...html.matchAll(/<span class="v3-st-s[^"]*">(?:<span class="v3-wait"[\s\S]*?<\/span>)?([^<]+)<\/span>/g)].map(m => m[1]);
const nowCount = (html: string) => (html.match(/aria-current="step"/g) ?? []).length;
const PERSON = /陳師傅|張先生|林小姐/;

test("PLT-52-AC6 / O-EST-RELAY: TK-RELAY steps, navy on 屋 核准估價 with 你, company subs, no day count", () => {
  const html = renderToStaticMarkup(<OwnerEstimateRelay state={{ kind: "pending" }} firm="安居物業" locale="zh-TW" />);
  assert.deepEqual(steps(html), ["租客回報", "派工", "核准估價", "到場維修", "核對費用"]);
  assert.deepEqual(subs(html), ["租客", "安居物業", "你", "廠商", "安居物業"]);
  assert.equal(nowCount(html), 1);
  assert.match(html, /data-state="now" data-party="o"/);
  assert.match(html, /aria-label="報修進度共五步，現在輪到你核准估價"/);
  assert.deepEqual([...html.matchAll(/data-state="(\w+)"/g)].map(m => m[1]), ["done", "done", "now", "next", "next"]);
  assert.doesNotMatch(html, /第 \d+ 天|v3-wait|data-wait|plain/);
  // No company name: the role word 管理方 stands in (never a blank sub or a person).
  const anonymous = renderToStaticMarkup(<OwnerEstimateRelay state={{ kind: "pending" }} firm="  " locale="zh-TW" />);
  assert.deepEqual(subs(anonymous), ["租客", "管理方", "你", "廠商", "管理方"]);
});

test("PLT-52-AC7 / O-EST-EMERG: same steps, no navy, no 你, no day count", () => {
  const html = renderToStaticMarkup(<OwnerEstimateRelay state={{ kind: "emergency" }} firm="安居物業" locale="zh-TW" />);
  assert.deepEqual(steps(html), ["租客回報", "派工", "核准估價", "到場維修", "核對費用"]);
  assert.equal(nowCount(html), 0); assert.doesNotMatch(html, /turn-tag|>你<|輪到|第 \d+ 天|v3-wait/);
  assert.deepEqual(subs(html), ["租客", "安居物業", "廠商", "安居物業"]);
  assert.match(html, /aria-label="報修進度共五步"/);
  assert.equal((html.match(/ plain"/g) ?? []).length, 3);
});

test("PLT-52-AC8 / O-EST-DONE-RELAY, O-EST-BACK-DONE: owner step done with its result; next step clock, no navy, no tick", () => {
  const approved = ownerEstimateRelay({ kind: "decided", decision: "approved" }, "安居物業");
  assert.deepEqual(approved.map(n => [n.party, n.step, n.state, !!n.wait]), [
    ["t", "report", "done", false], ["m", "dispatch", "done", false], ["o", "approve_estimate", "done", false],
    ["v", "do_repair", "next", true], ["m", "confirm_cost", "next", false]]);
  assert.deepEqual(approved[2].subs, [{ kind: "approved" }]);
  for (const [decision, word] of [["rejected", "退回"], ["more_information", "補資料"]] as const) {
    const nodes = ownerEstimateRelay({ kind: "decided", decision }, "安居物業");
    assert.deepEqual(nodes.map(n => [n.party, n.step, n.state, !!n.wait]), [
      ["t", "report", "done", false], ["m", "dispatch", "done", false], ["o", "approve_estimate", "done", false],
      ["m", "re_estimate", "next", true], ["v", "do_repair", "next", false], ["m", "confirm_cost", "next", false]]);
    const html = renderToStaticMarkup(<OwnerEstimateRelay state={{ kind: "decided", decision }} firm="安居物業" locale="zh-TW" />);
    assert.deepEqual(steps(html), ["租客回報", "派工", "核准估價", "重新估價", "到場維修", "核對費用"]);
    assert.deepEqual(subs(html), ["租客", "安居物業", word, "安居物業", "廠商", "安居物業"]);
    assert.match(html, new RegExp(`aria-label="報修進度，你已${word}，交給管理方重新估價"`));
    assert.equal(nowCount(html), 0); assert.equal((html.match(/class="v3-wait"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /i-ok|v3-check|completion-check|v3-tick/);
  }
  const html = renderToStaticMarkup(<OwnerEstimateRelay state={{ kind: "decided", decision: "approved" }} firm="安居物業" locale="zh-TW" />);
  assert.deepEqual(subs(html), ["租客", "安居物業", "已核准", "廠商", "安居物業"]);
  assert.match(html, /aria-label="報修進度，你已核准，交給廠商到場維修"/);
});

test("PLT-52-AC10: only the four ready projections map; restricted, terminal and viewerCanAct false draw none", () => {
  const ready = (holder: string | null, step: string | null, viewerCanAct = false) => ({ state: "ready" as const, holder, step, viewerCanAct });
  assert.equal(vendorRelayKind(ready("vendor", "do_repair", true)), "do_repair");
  assert.equal(vendorRelayKind(ready("vendor", "report_cost", true)), "report_cost");
  assert.equal(vendorRelayKind(ready("manager", "confirm_cost")), "confirm_cost");
  assert.equal(vendorRelayKind(ready("manager", "dispatch")), "dispatch");
  for (const turn of [null, undefined, ready("vendor", "do_repair", false), ready("vendor", "report_cost", false),
    ready("none", "done"), ready("manager", "in_progress"), ready("manager", "re_estimate"), ready("owner", "approve_estimate"),
    { state: "restricted" as const, holder: null, step: null, viewerCanAct: false },
    { state: "restricted" as const, holder: "vendor", step: "do_repair", viewerCanAct: true }]) {
    assert.equal(vendorRelayKind(turn), null, JSON.stringify(turn));
  }
  // OQ-097 (Ron 2026-11-17 「Draw R7a relay」): all four kinds are drawn.
  for (const kind of ["do_repair", "report_cost", "confirm_cost", "dispatch"] as const) assert.equal(vendorRelayDrawn(kind), true);
  assert.equal(vendorRelayDrawn(null), false);
});

test("PLT-52-AC9 / RV-RELAY, RV-RELAY-WAIT: 租 → 管 → 廠 → 管, no 屋 step, company subs, no times or day counts", () => {
  const expected: Record<VendorRelayKind, { steps: string[]; subs: string[]; now: string; label: string; wait: number }> = {
    do_repair: { steps: ["租客回報", "派工", "到場維修", "核對費用"], subs: ["租客", "安居物業", "你", "安居物業"], now: "v", label: "現在輪到你到場維修", wait: 0 },
    report_cost: { steps: ["租客回報", "派工", "回報費用", "核對費用"], subs: ["租客", "安居物業", "你", "安居物業"], now: "v", label: "現在輪到你回報費用", wait: 0 },
    confirm_cost: { steps: ["租客回報", "派工", "回報費用", "核對費用"], subs: ["租客", "安居物業", "已送出", "安居物業"], now: "m", label: "現在輪到安居物業核對費用", wait: 1 },
    dispatch: { steps: ["租客回報", "派工", "到場維修", "核對費用"], subs: ["租客", "安居物業", "廠商", "安居物業"], now: "m", label: "現在輪到安居物業派工", wait: 0 },
  };
  for (const [kind, want] of Object.entries(expected) as [VendorRelayKind, typeof expected[VendorRelayKind]][]) {
    const html = renderToStaticMarkup(<VendorCaseRelay kind={kind} firm="安居物業" locale="zh-TW" />);
    assert.deepEqual(steps(html), want.steps, kind); assert.deepEqual(subs(html), want.subs, kind);
    assert.equal(nowCount(html), 1, kind); assert.match(html, new RegExp(`data-state="now" data-party="${want.now}"`), kind);
    assert.match(html, new RegExp(`aria-label="報修進度共四步，${want.label}"`), kind);
    assert.equal((html.match(/class="v3-wait"/g) ?? []).length, want.wait, kind);
    assert.doesNotMatch(html, /data-party="o"|核准估價|第 \d+ 天|\d{1,2}:\d{2}/, kind);
  }
  // R2: the vendor's 回報費用 is done and handed over (clock, 已送出); the company holds 核對費用.
  const r2 = vendorCaseRelay("confirm_cost", "安居物業");
  assert.deepEqual([r2[2].state, r2[2].wait, r2[3].state], ["done", true, "now"]);
});

const base: VendorCaseViewProps = { locale: "zh-TW", token: "tok", heading: "信義路 2 樓・浴室天花板滴水", company: "安居物業",
  stage: "open", presetDate: null, scheduledOn: null, ownerWaitVersion: null, estimates: false, report: true };
const view = (props: Partial<VendorCaseViewProps>) => renderToStaticMarkup(<VendorCaseView {...base} {...props} />);

test("PLT-52-AC9 / RV-JOB: relay inside the job card above the stage primary; R2/R6 leads, status and no solid primary", () => {
  const r7b = view({ relay: "do_repair" });
  assert.match(r7b, /data-testid="vendor-case-relay"/); assert.match(r7b, /data-testid="vendor-case-report"/);
  assert.ok(r7b.indexOf("vendor-case-relay") < r7b.indexOf("vendor-case-report"), "relay above the primary");
  assert.ok(r7b.indexOf("v-case-card") < r7b.indexOf("vendor-case-relay") && r7b.indexOf("vendor-case-relay") < r7b.indexOf("v-case-other"));
  assert.doesNotMatch(r7b, /v-token-lead/);
  const r2 = view({ relay: "confirm_cost" });
  assert.match(r2, /<h1>費用已送出，等安居物業核對。<\/h1>/); assert.match(r2, /處理中/);
  assert.doesNotMatch(r2, /vendor-case-report|v-token-primary|已回報，待公司核對/);
  const r6 = view({ relay: "dispatch" });
  assert.match(r6, /<h1>這一案等安居物業派工。<\/h1>/); assert.match(r6, />待派工</);
  assert.doesNotMatch(r6, /vendor-case-report|v-token-primary/);
  // R7a (OQ-097, Ron 「Draw R7a relay」): relay with 廠 回報費用 「你」 and 處理中; no lead, no button yet.
  const r7a = view({ relay: "report_cost" });
  assert.match(r7a, /data-relay="report_cost"/); assert.match(r7a, /aria-label="報修進度共四步，現在輪到你回報費用"/);
  assert.match(r7a, /處理中/);
  assert.doesNotMatch(r7a, /v-token-lead|開立費用文件|vendor-case-report|v-token-primary/);
  // The company slot never goes blank.
  assert.match(view({ relay: "dispatch", company: "" }), /<h1>這一案等管理方派工。<\/h1>/);
  assert.equal(partyRelayCopy("zh-TW").costSent.replace("{company}", "安居物業"), "費用已送出，等安居物業核對。");
  assert.equal(partyRelayCopy("zh-TW").awaitDispatch.replace("{company}", "安居物業"), "這一案等安居物業派工。");
  assert.equal(partyRelayCopy("zh-TW").yourDecision, "你的決定");
  assert.equal(ticketRelayCopy("zh-TW").mntStatus.awaiting_dispatch, "待派工");
});

test("PLT-52-AC10 / RV-RELAY-NONE: no relay outside an open case or without a drawn projection; null is byte-identical", () => {
  for (const stage of ["accept", "owner_wait", "closed", "declined", "unavailable"] as const) {
    for (const relay of ["do_repair", "confirm_cost", "dispatch", "report_cost", null] as const) {
      const html = view({ stage, relay, ownerWaitVersion: stage === "owner_wait" ? 2 : null });
      assert.doesNotMatch(html, /v3-rail|vendor-case-relay|費用已送出|這一案等/, `${stage}/${relay}`);
      assert.equal(html, view({ stage, ownerWaitVersion: stage === "owner_wait" ? 2 : null }), `${stage}/${relay}`);
    }
  }
  // No projection: the open page is exactly the pre-relay page.
  for (const relay of [null, undefined] as const) assert.equal(view({ relay }), view({}));
});

test("relay CSS: owner/manager rules scoped to html[data-brand-v3]; vendor rules scoped to the bearer shell; 44px untouched", () => {
  for (const line of read("public/brand/v3/ticket-relay.css").split("\n").filter(line => line.includes("{") && !line.startsWith("@media")))
    assert.match(line.trim(), /^html\[data-brand="v2"\]\[data-brand-v3\] /, line);
  const vendor = read("public/brand/v3/vendor-case.css");
  for (const line of vendor.split("\n").filter(line => line.includes("{"))) assert.match(line, /^\.v-token-v3 /, line);
  for (const rule of [".v3-rail", ".v3-st.now", ".turn-tag", ".party-v", ".v3-st-wait"]) assert.ok(vendor.includes(rule), rule);
  assert.match(read("src/app/o/page.tsx"), /href="\/brand\/v3\/ticket-relay\.css"/);
});

test("GS-43 / 0 outbound: no personal names or outbound calls in the relay modules", () => {
  for (const file of ["src/lib/b3-party-relay.ts", "src/components/v3/party-relay.tsx", "src/server/b3-vendor-case-relay.ts", "src/i18n/lanes/brand-v3-party-relay.ts"]) {
    const text = read(file);
    assert.doesNotMatch(text, PERSON, file);
    assert.doesNotMatch(text, /line\/(?:push|messaging)|sendSms|sendEmail|resend|twilio|outbox|pushMessage|fetch\(/i, file);
  }
  // The loader runs the M3 projection and the B-105 case on one REPEATABLE READ client and fails closed.
  const loader = read("src/server/b3-vendor-case-relay.ts");
  assert.match(loader, /isolation: "repeatable read"/); assert.match(loader, /loadVendorRepairTurnsOn\(client, token, org\)/);
  assert.match(loader, /loadVendorCase\(token, async \(sql, params\) =>\s*\(await client\.query/);
  assert.match(loader, /catch \(error\) \{\s*logServerError\("b3_vendor_case_relay", error\);\s*return null;/);
});

test("relayForPage: the relay is drawn only when its snapshot's 回報完工 readiness matches the page's", async () => {
  const { relayForPage } = await import("./b3-vendor-case-relay");
  assert.equal(relayForPage({ kind: "do_repair", reportReady: true }, true), "do_repair");
  assert.equal(relayForPage({ kind: "do_repair", reportReady: false }, false), "do_repair");
  assert.equal(relayForPage({ kind: "do_repair", reportReady: false }, true), null);
  assert.equal(relayForPage({ kind: "confirm_cost", reportReady: true }, false), null);
  assert.equal(relayForPage(null, true), null);
});
