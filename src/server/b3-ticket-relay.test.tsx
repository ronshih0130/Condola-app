import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { estimateRelay, maintenanceRelay, type EstimateFacts, type RelayNode } from "../lib/b3-ticket-relay";
import { loadTicketRelay, type TicketRelay } from "./b3-ticket-relay";
import { TicketRelayV3 } from "../components/v3/m/tickets/ticket-relay";
import { ticketRelayCopy } from "../i18n/lanes/brand-v3-ticket-relay";
import type { RepairRule, RepairStatus, RepairStep, RepairHolder } from "./b3-repair-turn-rules";
import type { StaffRepairTurns } from "./b3-repair-turns";
import type { ManagerApprovalRow } from "./repair-approval";
import { FlowError } from "./errors";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// MGT-150-AC1…AC5 / PLT-52-AC1, AC4 (TK-RELAY, TK-RELAY-MNT; batch 4 TK-RELAY-END, -BLOCKED, -MOREINFO,
// -MNT-STATES, TK-WHY-RULE). Synthetic data only.
const read = (p: string) => readFileSync(p, "utf8");
const TICKET = "00000000-0000-4000-8000-0000000000c1";
const staff: Session = { kind: "staff", role: "manager", orgId: "00000000-0000-4000-8000-000000000001", liveOrgId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic", email: "",
  environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const maintenanceSession: Session = { ...staff, role: "maintenance" };
const names = { tenant: "周小姐", vendor: "陳師傅", owner: "張先生" };
const facts = (over: Partial<EstimateFacts> & { rule: RepairRule; holder?: RepairHolder; step?: RepairStep; canAct?: boolean }): EstimateFacts => ({
  turn: { rule: over.rule, holder: over.holder ?? "manager", step: over.step ?? "dispatch", sinceExact: false, viewerCanAct: over.canAct ?? true },
  status: over.status ?? "in_progress", current: over.current === undefined ? null : over.current,
  pendingCost: over.pendingCost ?? false, names: over.names ?? names, ...(over.jobs ? { jobs: over.jobs } : {}),
});
const shape = (nodes: RelayNode[] | null) => nodes?.map(n => `${n.party}:${n.step}:${n.state}`);
const html = (relay: TicketRelay, locale: "zh-TW" | "en" = "zh-TW") =>
  renderToStaticMarkup(<TicketRelayV3 relay={relay} place="民生社區 5F" item="冷氣不冷" locale={locale} />);
const c = ticketRelayCopy("zh-TW");

test("approved zh-TW words are verbatim (screens.md Round 7 batch 2 and batch 4 new-word lists, B6 labels)", () => {
  assert.deepEqual(c.lead, {
    re_estimate: "屋主{name}退回了估價，輪到你重新估價。",
    more_info: "屋主{name}要求補充資料，輪到你重新估價。",
    declined: "廠商{name}沒有接，輪到你重新派工。",
  });
  assert.deepEqual(c.why, {
    blocked_declined: "廠商沒有接這一件。",
    blocked_link: "廠商的連結已失效，要重新分享或重新派工。",
    emergency_open: "已緊急處理，屋主還可以核准估價。",
    emergency_back: "已緊急處理；屋主退回了估價，之後要重新估價。",
    resolved_owner: "已標成已解決，但還在等屋主核准估價。",
    resolved_vendor: "已標成已解決，但還在等廠商回報費用。",
    resolved_vendor_repair: "已標成已解決，但還在等廠商到場維修。",
    resolved_manager_cost: "已標成已解決，但還在等管理方核對費用。",
    resolved_manager_redispatch: "已標成已解決，但還在等管理方重新派工。",
    resolved_need_cost: "已標成已解決，但還要核對費用。",
    resolved_need_redispatch: "已標成已解決，但還要重新派工。",
    cost_pending: "廠商已回報費用，等估價定案後才能核對。",
  });
  assert.equal(c.moreInfo, "補資料"); assert.equal(c.sentBack, "退回");
  assert.deepEqual(c.end, { resolved: "已解決", closed: "已結案", cancelled: "已取消" });
  assert.deepEqual(c.mntStatus, { awaiting_dispatch: "待派工", dispatched: "已派工", in_progress: "處理中", on_hold: "暫停",
    resolved: "已解決", closed: "已結案", cancelled: "已取消" });
  assert.deepEqual(Object.values(c.steps), ["租客回報", "派工", "處理中", "核准估價", "重新估價", "到場維修", "回報費用", "核對費用"]);
  // MGT-150-AC1: labels are 2–4 characters (relay subs too, GS-44).
  for (const label of [...Object.values(c.steps), c.moreInfo, c.sentBack, ...Object.values(c.end)]) assert.ok([...label].length >= 2 && [...label].length <= 4, label);
  const en = ticketRelayCopy("en");
  for (const key of ["steps", "lead", "why", "end", "mntStatus"] as const) assert.deepEqual(Object.keys(en[key]), Object.keys(c[key]));
});

test("MGT-150-AC1 R3: 租 → 管 → 屋 → 廠 → 管, current navy pill on 屋; 屋 only when the estimate needs approval", () => {
  const r3 = estimateRelay(facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false,
    current: { requiresOwner: true, decision: null, emergency: false } }));
  assert.deepEqual(shape(r3.nodes), ["t:report:done", "m:dispatch:done", "o:approve_estimate:now", "v:do_repair:next", "m:confirm_cost:next"]);
  assert.equal(r3.why, null); assert.equal(r3.lead, null);
  // Below the threshold (no owner approval) and approvals OFF: no 屋 step.
  for (const current of [{ requiresOwner: false, decision: null, emergency: false }, null]) {
    const r7b = estimateRelay(facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current }));
    assert.deepEqual(shape(r7b.nodes), ["t:report:done", "m:dispatch:done", "v:do_repair:now", "m:confirm_cost:next"]);
  }
  const page = html({ state: "ready", view: "estimate", relay: r3 });
  assert.match(page, /<span class="turn-tag" aria-current="step">核准估價<\/span>/);
  assert.equal((page.match(/aria-current="step"/g) ?? []).length, 1);
  assert.match(page, /aria-label="報修進度，現在輪到屋主張先生核准估價"/);
  for (const glyph of ["租", "管", "屋", "廠"]) assert.ok(page.includes(`>${glyph}</span>`));
});

test("MGT-150-AC1/AC3 approved emergency frame: 屋 still open, 廠 now, one why-line", () => {
  const relay = estimateRelay(facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, names: { tenant: "黃小姐", vendor: "陳師傅", owner: "張先生" },
    current: { requiresOwner: true, decision: null, emergency: true } }));
  assert.deepEqual(shape(relay.nodes), ["t:report:done", "m:dispatch:done", "o:approve_estimate:next", "v:do_repair:now", "m:confirm_cost:next"]);
  assert.equal(relay.why, "emergency_open");
  const page = html({ state: "ready", view: "estimate", relay });
  assert.ok(page.includes('aria-label="報修進度，現在輪到廠商陳師傅到場維修"'));
  assert.ok(page.includes(">已緊急處理，屋主還可以核准估價。</p>"));
  assert.equal((page.match(/class="v3-why"/g) ?? []).length, 1);
  for (const sub of ["黃小姐", "張先生", "陳師傅", "管理方"]) assert.ok(page.includes(`<span class="v3-st-s">${sub}</span>`), sub);
  // The vendor holds the turn: nobody on this page is told 「你」.
  assert.ok(!page.includes(">你<"));
  // R7a swaps the vendor label to 回報費用.
  const r7a = estimateRelay(facts({ rule: "R7a", holder: "vendor", step: "report_cost", canAct: false }));
  assert.deepEqual(shape(r7a.nodes), ["t:report:done", "m:dispatch:done", "v:report_cost:now", "m:confirm_cost:next"]);
});

const job = (over: Partial<NonNullable<EstimateFacts["jobs"]>> = {}) => ({ currentCreatedAt: "2030-11-14T10:00:00Z", any: true, latestRevoked: false, reported: false, confirmed: false, ...over });
test("TK-WHY-RULE: every why-line, one line only, priority blocked → 已緊急處理 → 已標成已解決 → 費用還不能核對", () => {
  const owner = { requiresOwner: true, decision: null, emergency: false };
  const declined = { requiresOwner: true, decision: "approved" as const, emergency: false, eventKind: "vendor_rejected", eventAt: "2030-11-15T10:00:00Z" };
  const cases: [EstimateFacts, string | null][] = [
    // TK-RELAY-BLOCKED
    [facts({ rule: "R6", step: "dispatch", current: declined, jobs: job() }), "blocked_declined"],
    [facts({ rule: "R8-blocked", step: "dispatch", current: declined, jobs: job() }), "blocked_declined"],
    [facts({ rule: "R8-blocked", step: "dispatch", current: { ...declined, eventAt: "2030-11-13T10:00:00Z" }, jobs: job() }), "blocked_link"], // older job's event
    [facts({ rule: "R8-blocked", step: "dispatch", jobs: job() }), "blocked_link"], // expired / unshared / reassigned
    [facts({ rule: "R8-blocked", step: "dispatch", jobs: job({ currentCreatedAt: null, latestRevoked: true }) }), "blocked_link"], // revoked
    [facts({ rule: "R8-blocked", step: "dispatch", jobs: job({ currentCreatedAt: null, any: false }) }), null], // never dispatched
    // emergency
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...owner, emergency: true } }), "emergency_open"],
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...owner, emergency: true, decision: "rejected" } }), "emergency_back"],
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...owner, emergency: true, decision: "more_information" } }), "emergency_back"],
    // 已標成已解決 slots: waiting on someone else, waiting on 管理方 (can't act), 還要 (can act)
    [facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false, current: owner, status: "resolved" }), "resolved_owner"],
    [facts({ rule: "R7a", holder: "vendor", step: "report_cost", canAct: false, status: "resolved" }), "resolved_vendor"],
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, status: "resolved" }), "resolved_vendor_repair"],
    [facts({ rule: "R2", step: "confirm_cost", canAct: false, status: "resolved" }), "resolved_manager_cost"],
    [facts({ rule: "R2", step: "confirm_cost", canAct: true, status: "resolved" }), "resolved_need_cost"],
    [facts({ rule: "R8-blocked", step: "dispatch", canAct: false, status: "resolved", jobs: job({ currentCreatedAt: null, any: false }) }), "resolved_manager_redispatch"],
    [facts({ rule: "R8-blocked", step: "dispatch", canAct: true, status: "resolved", jobs: job({ currentCreatedAt: null, any: false }) }), "resolved_need_redispatch"],
    // 費用還不能核對
    [facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false, current: owner, pendingCost: true }), "cost_pending"],
    [facts({ rule: "R5", step: "re_estimate", current: { ...owner, decision: "rejected" }, pendingCost: true }), "cost_pending"],
    [facts({ rule: "R8-blocked", step: "in_progress", pendingCost: true }), "cost_pending"],
    // Priority when two or more apply
    [facts({ rule: "R8-blocked", step: "dispatch", status: "resolved", current: { ...declined, decision: null, emergency: true }, jobs: job(), pendingCost: true }), "blocked_declined"],
    [facts({ rule: "R7a", holder: "vendor", step: "report_cost", canAct: false, status: "resolved", current: { ...owner, emergency: true } }), "emergency_open"],
    [facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false, current: owner, status: "resolved", pendingCost: true }), "resolved_owner"],
    // Plain cases have no line.
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...owner, decision: "approved" } }), null],
    [facts({ rule: "R2", step: "confirm_cost" }), null],
  ];
  for (const [input, expected] of cases) {
    const relay = estimateRelay(input);
    assert.equal(relay.why, expected, JSON.stringify(input));
    const page = html({ state: "ready", view: "estimate", relay });
    assert.equal((page.match(/class="v3-why"/g) ?? []).length, expected ? 1 : 0);
    if (expected) assert.ok(page.includes(`>${c.why[expected as keyof typeof c.why]}</p>`));
  }
});

test("TK-RELAY-BLOCKED: 廠商沒有接 → lead, 管 派工 now with 你, 廠 next without a name; reason not readable", () => {
  const declined = { requiresOwner: false, decision: null, emergency: false, eventKind: "vendor_rejected", eventAt: "2030-11-15T10:00:00Z" };
  const relay = estimateRelay(facts({ rule: "R6", step: "dispatch", current: declined, jobs: job() }));
  assert.deepEqual(shape(relay.nodes), ["t:report:done", "m:dispatch:now", "v:do_repair:next", "m:confirm_cost:next"]);
  assert.deepEqual(relay.lead, { kind: "declined", name: "陳師傅" });
  assert.deepEqual(relay.nodes?.[2].subs, []);
  assert.ok(relay.hidden.includes("decline_reason"));
  const page = html({ state: "ready", view: "estimate", relay });
  assert.ok(page.includes('<p data-testid="ticket-relay-lead">廠商陳師傅沒有接，輪到你重新派工。</p>'));
  assert.ok(page.includes(">廠商沒有接這一件。</p>"));
  assert.match(page, /aria-label="報修進度，現在輪到你派工"/);
  // Can't act: no lead, 管理方 on the pill; link failure: no lead, the link line.
  const cannot = estimateRelay(facts({ rule: "R6", step: "dispatch", canAct: false, current: declined, jobs: job() }));
  assert.equal(cannot.lead, null); assert.ok(cannot.hidden.includes("lead_cannot_act"));
  const link = estimateRelay(facts({ rule: "R8-blocked", step: "dispatch", jobs: job() }));
  assert.equal(link.lead, null); assert.equal(link.why, "blocked_link"); assert.ok(link.hidden.includes("lead_other"));
  const noJob = estimateRelay(facts({ rule: "R8-blocked", step: "dispatch", jobs: job({ currentCreatedAt: null, any: false }) }));
  assert.ok(noJob.nodes && noJob.why === null && noJob.hidden.includes("blocked_no_job"));
});

test("MGT-150-AC4 R5 / TK-RELAY-MOREINFO: navy pill on 管 重新估價, 退回 or 補資料 under 屋, the lead verbatim", () => {
  const relay = estimateRelay(facts({ rule: "R5", step: "re_estimate", current: { requiresOwner: true, decision: "rejected", emergency: false } }));
  assert.deepEqual(shape(relay.nodes), ["t:report:done", "m:dispatch:done", "o:approve_estimate:done", "m:re_estimate:now", "v:do_repair:next"]);
  assert.deepEqual(relay.lead, { kind: "re_estimate", name: "張先生" });
  const page = html({ state: "ready", view: "estimate", relay });
  assert.ok(page.includes('<p data-testid="ticket-relay-lead">屋主張先生退回了估價，輪到你重新估價。</p>'));
  assert.ok(page.includes('aria-label="報修進度，現在輪到你重新估價"'));
  assert.ok(page.includes('<span class="v3-st-s">張先生</span><span class="v3-st-s">退回</span>'));
  assert.ok(page.includes("<h1>民生社區 5F・冷氣不冷</h1>"));
  assert.match(page, /<a href="\/m\/tickets">維修<\/a><span aria-hidden="true"> › <\/span><span>民生社區 5F・冷氣不冷<\/span>/);
  const more = estimateRelay(facts({ rule: "R5", step: "re_estimate", current: { requiresOwner: true, decision: "more_information", emergency: false } }));
  assert.deepEqual(more.nodes?.[2].subs, [{ kind: "name", text: "張先生" }, { kind: "more_info" }]);
  assert.deepEqual(more.lead, { kind: "more_info", name: "張先生" });
  const morePage = html({ state: "ready", view: "estimate", relay: more });
  assert.ok(morePage.includes('<span class="v3-st-s">張先生</span><span class="v3-st-s">補資料</span>'));
  assert.ok(morePage.includes('<p data-testid="ticket-relay-lead">屋主張先生要求補充資料，輪到你重新估價。</p>'));
  assert.ok(!morePage.includes(">退回<"));
  const cannot = estimateRelay(facts({ rule: "R5", step: "re_estimate", canAct: false, current: { requiresOwner: true, decision: "rejected", emergency: false } }));
  assert.equal(cannot.lead, null); assert.ok(cannot.hidden.includes("lead_cannot_act"));
  const unnamed = estimateRelay(facts({ rule: "R5", step: "re_estimate", names: { ...names, owner: " " }, current: { requiresOwner: true, decision: "rejected", emergency: false } }));
  assert.equal(unnamed.lead, null); assert.ok(unnamed.hidden.includes("lead_no_name"));
  assert.ok(!html({ state: "ready", view: "estimate", relay: unnamed }).includes("ticket-relay-lead"));
});

test("TK-RELAY-END / MGT-150-AC5: grey end pills 已結案 / 已解決 / 已取消, never a tick or a day count", () => {
  const owner = { requiresOwner: true, decision: "approved" as const, emergency: false };
  const closed = estimateRelay(facts({ rule: "R1", holder: "none", step: "done", canAct: false, status: "closed", current: owner, jobs: job({ reported: true }) }));
  assert.deepEqual(shape(closed.nodes), ["t:report:done", "m:dispatch:done", "o:approve_estimate:done", "v:do_repair:done", "m:confirm_cost:done"]);
  assert.equal(closed.end, "closed"); assert.equal(closed.why, null); assert.equal(closed.now, null);
  const resolved = estimateRelay(facts({ rule: "R4", holder: "none", step: "done", canAct: false, status: "resolved", jobs: job({ reported: true }) }));
  assert.deepEqual(shape(resolved.nodes), ["t:report:done", "m:dispatch:done", "v:do_repair:done"]);
  assert.equal(resolved.end, "resolved");
  const confirmed = estimateRelay(facts({ rule: "R4", holder: "none", step: "done", canAct: false, status: "resolved", jobs: job({ reported: true, confirmed: true }) }));
  assert.deepEqual(shape(confirmed.nodes), ["t:report:done", "m:dispatch:done", "v:do_repair:done", "m:confirm_cost:done"]);
  // Cancelled: only the steps done before the cancel.
  const early = estimateRelay(facts({ rule: "R1", holder: "none", step: "done", canAct: false, status: "cancelled", jobs: job({ currentCreatedAt: null, any: false }) }));
  assert.deepEqual(shape(early.nodes), ["t:report:done"]); assert.equal(early.end, "cancelled");
  const dispatched = estimateRelay(facts({ rule: "R1", holder: "none", step: "done", canAct: false, status: "cancelled", current: { ...owner, decision: null }, jobs: job({ latestRevoked: true }) }));
  assert.deepEqual(shape(dispatched.nodes), ["t:report:done", "m:dispatch:done"]);
  for (const [relay, pill] of [[closed, "已結案"], [resolved, "已解決"], [early, "已取消"]] as const) {
    const page = html({ state: "ready", view: "estimate", relay });
    assert.ok(page.includes(`<li class="v3-st end" data-state="end"><span class="v3-end-pill">${pill}</span></li>`));
    assert.doesNotMatch(page, /<svg|check|aria-current|v3-why|第|天/);
    assert.ok(page.includes('aria-label="報修進度"'));
  }
  // R8: the 管 step reads 處理中, then 廠 and 管 核對費用 as usual; 你 only when actionable.
  const r8 = estimateRelay(facts({ rule: "R8", step: "in_progress" }));
  assert.deepEqual(shape(r8.nodes), ["t:report:done", "m:in_progress:now", "v:do_repair:next", "m:confirm_cost:next"]);
  assert.deepEqual(r8.nodes?.[1].subs, [{ kind: "you" }]);
  assert.match(html({ state: "ready", view: "estimate", relay: r8 }), /<span class="turn-tag" aria-current="step">處理中<\/span>/);
  assert.deepEqual(estimateRelay(facts({ rule: "R8-blocked", step: "in_progress", canAct: false })).nodes?.[1].subs, [{ kind: "manager" }]);
  const exact = estimateRelay({ ...facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false, current: { requiresOwner: true, decision: null, emergency: false } }),
    turn: { rule: "R3", holder: "owner", step: "approve_estimate", sinceExact: true, viewerCanAct: false } });
  assert.ok(exact.hidden.includes("day_count"));
  assert.doesNotMatch(html({ state: "ready", view: "estimate", relay: exact }), /第|天|day/i);
});

test("GS-44: a stale cross-read never guesses; resolved re-estimate stays without a line", () => {
  for (const [rule, current] of [["R3", null], ["R3", { requiresOwner: true, decision: "approved", emergency: false }],
    ["R5", { requiresOwner: true, decision: "rejected", emergency: true }], ["R5", { requiresOwner: false, decision: null, emergency: false }]] as const) {
    const relay = estimateRelay(facts({ rule, current }));
    assert.equal(relay.nodes, null, rule); assert.ok(relay.hidden.includes("snapshot_mismatch"));
  }
  const r5resolved = estimateRelay(facts({ rule: "R5", step: "re_estimate", status: "resolved", current: { requiresOwner: true, decision: "rejected", emergency: false } }));
  assert.ok(r5resolved.nodes); assert.equal(r5resolved.why, null); assert.ok(r5resolved.hidden.includes("resolved_other"));
});

test("estimate relay invariants over every rule × status × estimate state", () => {
  const rules: [RepairRule, RepairHolder, RepairStep][] = [["R1", "none", "done"], ["R2", "manager", "confirm_cost"], ["R3", "owner", "approve_estimate"],
    ["R5", "manager", "re_estimate"], ["R6", "manager", "dispatch"], ["R7a", "vendor", "report_cost"], ["R7b", "vendor", "do_repair"],
    ["R8-blocked", "manager", "dispatch"], ["R8-blocked", "manager", "in_progress"], ["R4", "none", "done"], ["R8", "manager", "dispatch"], ["R8", "manager", "in_progress"]];
  const statuses: RepairStatus[] = ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"];
  const currents = [null, ...[true, false].flatMap(requiresOwner => [null, "approved", "rejected", "more_information"].flatMap(decision =>
    [true, false].map(emergency => ({ requiresOwner, decision: decision as null, emergency }))))];
  let drawn = 0;
  for (const [rule, holder, step] of rules) for (const status of statuses) for (const current of currents) for (const pendingCost of [true, false]) for (const canAct of [true, false]) {
    const relay = estimateRelay(facts({ rule, holder, step, status, current, pendingCost, canAct }));
    // F2: only R1/R2 precede R3/R5 in §3's first-match order; any later rule with a head that implies
    // R3/R5 is a cross-read race and draws nothing.
    const impliesR3 = !!current && current.requiresOwner && current.decision === null && !current.emergency;
    const impliesR5 = !!current && current.requiresOwner && (current.decision === "rejected" || current.decision === "more_information") && !current.emergency;
    if (!["R1", "R2", "R3", "R5"].includes(rule) && (impliesR3 || impliesR5)) {
      assert.equal(relay.nodes, null, `${rule} with an R3/R5 head`); assert.ok(relay.hidden.includes("snapshot_mismatch"));
    }
    if (!relay.nodes) { assert.equal(relay.why, null); continue; }
    // F1: 「你」 only on the current 管 step, only when the viewer can act.
    for (const node of relay.nodes) if (node.subs.some(sub => sub.kind === "you")) {
      assert.equal(node.state, "now"); assert.equal(node.party, "m"); assert.equal(canAct, true);
    }
    drawn++;
    const now = relay.nodes.filter(n => n.state === "now");
    assert.equal(relay.nodes[0].party, "t");
    if (rule === "R1" || rule === "R4") {
      // TK-RELAY-END: no current step, an end pill, no why-line, no lead.
      assert.equal(now.length, 0); assert.ok(relay.end); assert.equal(relay.why, null); assert.equal(relay.lead, null);
      assert.ok(relay.nodes.every(n => n.state === "done"));
      if (status !== "cancelled") assert.equal(relay.nodes.some(n => n.party === "o"), current?.requiresOwner === true);
      continue;
    }
    assert.equal(relay.end, null);
    assert.equal(now.length, 1);
    assert.equal(relay.nodes.some(n => n.party === "o"), current?.requiresOwner === true);
    if (now[0].party === "o") assert.equal(rule, "R3");
    if (relay.lead) assert.ok(["R5", "R6", "R8-blocked"].includes(rule));
    // TK-RELAY-END: R8 and blocked-in-progress put 處理中 on the 管 step.
    if ((rule === "R8" || rule === "R8-blocked") && step === "in_progress") assert.deepEqual([now[0].party, now[0].step], ["m", "in_progress"]);
  }
  assert.ok(drawn > 1000);
});

test("F1: a viewer who cannot act is never told 「你」, on the current step or on done steps", () => {
  const rejected = { requiresOwner: true, decision: "rejected" as const, emergency: false };
  const cannot: EstimateFacts[] = [
    facts({ rule: "R5", step: "re_estimate", canAct: false, current: rejected }), // before reestimate_ready
    facts({ rule: "R2", step: "confirm_cost", canAct: false }), // expense conflict or no exp.add
    facts({ rule: "R6", step: "dispatch", canAct: false, status: "resolved" }),
    facts({ rule: "R8", step: "dispatch", canAct: false, status: "open" }),
    facts({ rule: "R8-blocked", step: "dispatch", canAct: false }),
  ];
  for (const input of cannot) {
    const relay = estimateRelay(input);
    assert.ok(relay.nodes, input.turn.rule);
    assert.ok(relay.nodes.every(n => n.subs.every(sub => sub.kind !== "you")), input.turn.rule);
    const now = relay.nodes.find(n => n.state === "now")!;
    assert.deepEqual(now.subs, [{ kind: "manager" }]);
    const page = html({ state: "ready", view: "estimate", relay });
    assert.ok(!page.includes(">你<"), input.turn.rule);
    assert.match(page, /aria-label="報修進度，現在輪到管理方/);
    assert.ok(!page.includes("ticket-relay-lead"));
  }
  // A viewer who can act: 「你」 on the current step only; the done 派工 says 管理方 (batch 3 redraw), never a person.
  const can = estimateRelay(facts({ rule: "R2", step: "confirm_cost" }));
  assert.deepEqual(can.nodes?.map(n => n.party === "m" ? `${n.step}:${n.state}:${n.subs.map(x => x.kind).join(",")}` : n.party),
    ["t", "dispatch:done:manager", "v", "confirm_cost:now:you"]);
  const canPage = html({ state: "ready", view: "estimate", relay: can });
  assert.match(canPage, /aria-label="報修進度，現在輪到你核對費用"/);
  assert.match(canPage, />管理方</, "the done 派工 step shows 管理方 on the page");
});

test("F2: turn R6/R7/R8 with an approval head that implies R3/R5 (cross-read race) draws no relay", () => {
  const pending = { requiresOwner: true, decision: null, emergency: false };
  const back = { requiresOwner: true, decision: "rejected" as const, emergency: false };
  const more = { requiresOwner: true, decision: "more_information" as const, emergency: false };
  const races: [RepairRule, RepairHolder, RepairStep][] = [["R6", "manager", "dispatch"], ["R7a", "vendor", "report_cost"],
    ["R7b", "vendor", "do_repair"], ["R8", "manager", "dispatch"], ["R8-blocked", "manager", "dispatch"]];
  for (const [rule, holder, step] of races) for (const current of [pending, back, more]) {
    const relay = estimateRelay(facts({ rule, holder, step, canAct: false, current }));
    assert.equal(relay.nodes, null, `${rule}/${current.decision}`); assert.equal(relay.why, null);
    assert.ok(relay.hidden.includes("snapshot_mismatch"));
    assert.doesNotMatch(html({ state: "ready", view: "estimate", relay }), /data-testid="ticket-relay"/);
  }
  // Controls: emergency heads and approved heads are valid for these rules; R2 legitimately precedes R3.
  assert.ok(estimateRelay(facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...pending, emergency: true } })).nodes);
  assert.ok(estimateRelay(facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...pending, decision: "approved" } })).nodes);
  assert.ok(estimateRelay(facts({ rule: "R2", step: "confirm_cost", current: pending })).nodes);
});

test("TK-RELAY-MNT-STATES / MGT-150-AC2: every status draws a status-only relay; no 屋, no timing, no why-line", () => {
  assert.equal(maintenanceRelay.length, 1);
  const n = { tenant: "黃小姐", vendor: "陳師傅" };
  const expected: Record<RepairStatus, [string, string[], string | null]> = {
    open: ["待派工", ["t:report:done", "m:dispatch:now", "v:do_repair:next", "m:confirm_cost:next"], null],
    triaged: ["待派工", ["t:report:done", "m:dispatch:now", "v:do_repair:next", "m:confirm_cost:next"], null],
    assigned: ["已派工", ["t:report:done", "m:dispatch:done", "v:do_repair:now", "m:confirm_cost:next"], null],
    in_progress: ["處理中", ["t:report:done", "m:dispatch:done", "v:do_repair:now", "m:confirm_cost:next"], null],
    on_hold: ["暫停", ["t:report:done", "m:dispatch:done", "v:do_repair:now", "m:confirm_cost:next"], null],
    resolved: ["已解決", ["t:report:done", "m:dispatch:done", "v:do_repair:done"], "已解決"],
    closed: ["已結案", ["t:report:done", "m:dispatch:done", "v:do_repair:done", "m:confirm_cost:done"], "已結案"],
    cancelled: ["已取消", ["t:report:done"], "已取消"],
  };
  for (const [status, [word, nodes, end]] of Object.entries(expected) as [RepairStatus, [string, string[], string | null]][]) {
    const relay = maintenanceRelay({ status, names: n });
    assert.deepEqual(shape(relay.nodes), nodes, status);
    assert.deepEqual(relay.hidden, []);
    const page = html({ state: "ready", view: "maintenance", relay });
    assert.ok(page.includes(`<p data-testid="ticket-relay-lead">狀態：${word}</p>`), status);
    assert.ok(page.includes('aria-label="報修進度"'));
    if (end) assert.ok(page.includes(`<span class="v3-end-pill">${end}</span>`)); else assert.ok(!page.includes("v3-end-pill"));
    for (const m of relay.nodes.filter(x => x.party === "m")) assert.deepEqual(m.subs, [{ kind: "manager" }]);
    for (const hidden of ["屋", "核准估價", "估價", "v3-why", "第", "天", ">你<", "<svg", "新進", "已完成"]) assert.ok(!page.includes(hidden), `${status}: ${hidden}`);
  }
});

const turnsFor = (detail: unknown, projection?: "maintenance") => (async () => ({ state: "ready", ...(projection ? { projection } : {}), counts: [], yourTurn: 0,
  mine: [], others: [], next: { mine: null, others: null }, detail }) as StaffRepairTurns);
const approvalRow = (over: Partial<ManagerApprovalRow>): ManagerApprovalRow => ({ version_id: "v", version_no: "1", amount_minor: "12000", currency: "TWD", minor_unit: 0,
  captured_threshold_minor: "3000", submitted_at: "2030-11-11T00:00:00Z", requires_owner_decision: true, decision: null, decided_at: null, decision_reason: null,
  emergency_category: null, emergency_reason: null, emergency_photo_refs: [], emergency_notice_intent_at: null, is_current: true,
  threshold_source: "owner_default", submitted_by: "u", decided_by: null, appointment_event_kind: null, appointment_occurred_at: null, reminder_intent_at: null, ...over });
const fail = (async () => { throw new Error("hidden-state reader must not run for maintenance"); }) as never;

test("hidden state NEVER changes the maintenance view: no approval or estimate read runs; output identical under every hidden variant", async () => {
  for (const status of ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"] as const) await maintenanceInvariant(status);
});
async function maintenanceInvariant(status: RepairStatus) {
  const detail = { ticketId: TICKET, status, holder: null, step: null, viewerCanAct: false, since: null, sinceExact: false };
  const publicFacts = async () => ({ tenant: "黃小姐", vendor: "陳師傅" });
  const baseline = await loadTicketRelay(maintenanceSession, TICKET, { turns: turnsFor(detail, "maintenance"), publicFacts, approvals: fail, estimateFacts: fail });
  assert.equal(baseline.state, "ready");
  const baseHtml = html(baseline);
  const variants: ManagerApprovalRow[][] = [[], [approvalRow({})], [approvalRow({ decision: "rejected", decided_by: staff.userId })],
    [approvalRow({ emergency_category: "water" })], [approvalRow({ decision: "more_information", emergency_category: "water" })]];
  for (const rows of variants) for (const pendingCost of [true, false]) {
    const seen: string[] = [];
    const out = await loadTicketRelay(maintenanceSession, TICKET, { turns: turnsFor(detail, "maintenance"), publicFacts,
      approvals: async () => { seen.push("approvals"); return rows; },
      estimateFacts: async () => { seen.push("estimate"); return { status: "resolved", tenant: null, vendor: null, owner: "張先生", pendingCost,
        currentJobCreatedAt: "2030-11-14T10:00:00Z", anyJob: true, latestRevoked: pendingCost, jobReported: pendingCost, jobConfirmed: false }; } });
    assert.deepEqual(seen, []); assert.deepEqual(out, baseline); assert.equal(html(out), baseHtml);
  }
  // A malformed maintenance projection is unavailable, never a guessed view.
  assert.deepEqual(await loadTicketRelay(maintenanceSession, TICKET, { turns: turnsFor({ ...detail, status: "weird" }, "maintenance"), publicFacts, approvals: fail, estimateFacts: fail }), { state: "unavailable" });
}

test("loader: estimate path composes the turn, the current head and facts; states map without guessing", async () => {
  const detail = { ticketId: TICKET, rule: "R5", holder: "manager", step: "re_estimate", viewerCanAct: true, since: null, sinceExact: false, timezone: "Asia/Taipei", place: "x" };
  let decidedBy: string | null = "unset";
  const out = await loadTicketRelay(staff, TICKET, { turns: turnsFor(detail),
    approvals: async (_s, input) => { assert.equal(input.ticketId, TICKET); return [approvalRow({ is_current: false, decision: "approved" }),
      approvalRow({ decision: "rejected", decided_by: "00000000-0000-4000-8000-0000000000d1" })]; },
    estimateFacts: async (_s, id, by) => { assert.equal(id, TICKET); decidedBy = by; return { status: "in_progress", tenant: "周小姐", vendor: "陳師傅", owner: "張先生", pendingCost: false }; },
    publicFacts: fail });
  assert.equal(decidedBy, "00000000-0000-4000-8000-0000000000d1");
  assert.ok(out.state === "ready" && out.view === "estimate" && out.relay.lead?.name === "張先生");
  const never = (async () => { throw new Error("must not run"); }) as never;
  assert.deepEqual(await loadTicketRelay(staff, "not-a-uuid", { turns: never }), { state: "forbidden" });
  for (const state of ["off", "unavailable"] as const)
    assert.deepEqual(await loadTicketRelay(staff, TICKET, { turns: async () => ({ state }), approvals: never }), { state });
  assert.deepEqual(await loadTicketRelay(staff, TICKET, { turns: turnsFor(null), approvals: never }), { state: "forbidden" });
  assert.deepEqual(await loadTicketRelay(staff, TICKET, { turns: async () => { throw new FlowError("errors.forbidden"); } }), { state: "forbidden" });
  assert.deepEqual(await loadTicketRelay(staff, TICKET, { turns: turnsFor(detail), approvals: async () => { throw new Error("boom"); } }), { state: "unavailable" });
  assert.deepEqual(await loadTicketRelay(staff, TICKET, { turns: turnsFor(detail), approvals: async () => [approvalRow({}), approvalRow({})] }), { state: "unavailable" });
  assert.deepEqual(await loadTicketRelay(staff, TICKET, { turns: turnsFor({ ...detail, ticketId: "00000000-0000-4000-8000-0000000000c2" }), approvals: never }), { state: "forbidden" });
  // Off/unavailable/forbidden render the head only: no relay, no lead, no error copy that the frames don't draw.
  for (const state of ["off", "unavailable", "forbidden"] as const) {
    const page = html({ state });
    assert.ok(page.includes("<h1>民生社區 5F・冷氣不冷</h1>"));
    assert.doesNotMatch(page, /data-testid="ticket-relay"|ticket-relay-lead|ticket-relay-why/);
  }
});

test("insurance: the estimate facts read itself refuses a non-admin/manager native role before any DB access", async () => {
  const detail = { ticketId: TICKET, rule: "R7b", holder: "vendor", step: "do_repair", viewerCanAct: false, since: null, sinceExact: false, timezone: "Asia/Taipei", place: "x" };
  // Even if a full (non-maintenance) DTO reached a maintenance session, the real readEstimateFacts denies it.
  assert.deepEqual(await loadTicketRelay(maintenanceSession, TICKET, { turns: turnsFor(detail), approvals: async () => [] }), { state: "forbidden" });
  const reader = read("src/server/b3-ticket-relay.ts");
  assert.match(reader.slice(reader.indexOf("async function readEstimateFacts"), reader.indexOf("return tx(", reader.indexOf("async function readEstimateFacts"))),
    /\["admin", "manager"\]\.includes\(native\)\) throw new FlowError\("errors\.forbidden"\)/);
});

test("REVIEW-CHECKLIST 11: the only control is the 維修 crumb link, ≥44px; CSS is brand_v3-scoped tokens; no tick", () => {
  const relay = estimateRelay(facts({ rule: "R5", step: "re_estimate", current: { requiresOwner: true, decision: "rejected", emergency: false } }));
  const page = html({ state: "ready", view: "estimate", relay });
  assert.equal((page.match(/<a /g) ?? []).length, 1);
  assert.doesNotMatch(page, /<button|<input|<svg/);
  const css = read("public/brand/v3/ticket-relay.css");
  assert.match(css, /\.v3-ticket-crumb a \{[^}]*min-height:44px; min-width:44px;/);
  for (const line of css.split("\n").filter(l => l.includes("{") && !l.trim().startsWith("@media") && !l.trim().startsWith("/*")))
    assert.ok(line.trim().startsWith('html[data-brand="v2"][data-brand-v3]'), line);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-f]{3,6}\b/i);
});

test("page wiring: brand_v3 only; the legacy header stays for OFF; the relay reader owns its admission", () => {
  const page = read("src/app/m/tickets/[id]/page.tsx");
  assert.match(page, /const relay = await brandV3EnabledForOrg\(session\.orgId\) \? await loadTicketRelay\(session, ticket\.id\) : null;/);
  assert.match(page, /relay \? <>[\s\S]*ticket-relay\.css[\s\S]*<TicketRelayV3[\s\S]*: <PageHeader/);
  const reader = read("src/server/b3-ticket-relay.ts");
  const maintenance = reader.slice(reader.indexOf('if (turns.projection === "maintenance")'), reader.indexOf('if (!("rule" in detail))'));
  assert.doesNotMatch(maintenance, /approvals|estimateFacts|managerApprovalView|readEstimateFacts/);
  const publicRead = reader.slice(reader.indexOf("async function readPublicFacts"), reader.indexOf("/**\n * Estimate viewers only"));
  assert.doesNotMatch(publicRead, /b013|estimate|repair_vendor_jobs|property_owners|status/);
  assert.match(publicRead, /guardEffectiveSession\(input, "tickets.update"\);\n  assertPerm\(session, "tickets.update"\);/);
});
