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

// MGT-150-AC1…AC5 / PLT-52-AC1, AC4 (TK-RELAY, TK-RELAY-MNT). Synthetic data only.
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
  pendingCost: over.pendingCost ?? false, names: over.names ?? names,
});
const shape = (nodes: RelayNode[] | null) => nodes?.map(n => `${n.party}:${n.step}:${n.state}`);
const html = (relay: TicketRelay, locale: "zh-TW" | "en" = "zh-TW") =>
  renderToStaticMarkup(<TicketRelayV3 relay={relay} place="民生社區 5F" item="冷氣不冷" locale={locale} />);
const c = ticketRelayCopy("zh-TW");

test("approved zh-TW words are verbatim (screens.md Round 7 batch 2 new-word list, B6 labels)", () => {
  assert.equal(c.reEstimateLead, "屋主{name}退回了估價，輪到你重新估價。");
  assert.deepEqual(c.why, {
    cost_pending: "廠商已回報費用，等估價定案後才能核對。",
    resolved_owner: "已標成已解決，但還在等屋主核准估價。",
    resolved_vendor: "已標成已解決，但還在等廠商回報費用。",
    emergency_open: "已緊急處理，屋主還可以核准估價。",
    emergency_back: "已緊急處理；屋主退回了估價，之後要重新估價。",
  });
  assert.deepEqual(Object.values(c.steps), ["租客回報", "派工", "核准估價", "重新估價", "到場維修", "回報費用", "核對費用"]);
  // MGT-150-AC1: labels are 2–4 characters.
  for (const label of Object.values(c.steps)) assert.ok([...label].length >= 2 && [...label].length <= 4, label);
  assert.deepEqual(Object.keys(ticketRelayCopy("en").why), Object.keys(c.why));
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

test("MGT-150-AC3 every why-line case, one line at most; none for a combined state", () => {
  const owner = { requiresOwner: true, decision: null, emergency: false };
  const cases: [EstimateFacts, string | null][] = [
    [facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false, current: owner, pendingCost: true }), "cost_pending"],
    [facts({ rule: "R5", step: "re_estimate", current: { ...owner, decision: "rejected" }, pendingCost: true }), "cost_pending"],
    [facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false, current: owner, status: "resolved" }), "resolved_owner"],
    [facts({ rule: "R7a", holder: "vendor", step: "report_cost", canAct: false, status: "resolved" }), "resolved_vendor"],
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...owner, emergency: true } }), "emergency_open"],
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...owner, emergency: true, decision: "rejected" } }), "emergency_back"],
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...owner, emergency: true, decision: "more_information" } }), "emergency_back"],
    // The vendor's cost report resolves the ticket: the cost line, not the resolved line.
    [facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false, current: owner, status: "resolved", pendingCost: true }), "cost_pending"],
    // Two cases at once otherwise: not drawn → no line (GS-44).
    [facts({ rule: "R7a", holder: "vendor", step: "report_cost", canAct: false, status: "resolved", current: { ...owner, emergency: true } }), null],
    // Plain cases have no line.
    [facts({ rule: "R7b", holder: "vendor", step: "do_repair", canAct: false, current: { ...owner, decision: "approved" } }), null],
    [facts({ rule: "R2", step: "confirm_cost" }), null],
  ];
  for (const [input, expected] of cases) {
    const relay = estimateRelay(input);
    assert.equal(relay.why, expected, JSON.stringify(input));
    if (expected === null && relay.hidden.includes("why_conflict")) assert.ok(relay.nodes);
  }
});

test("MGT-150-AC4 R5: navy pill on 管 重新估價 and the lead verbatim; hidden when the viewer can't act or has no name", () => {
  const relay = estimateRelay(facts({ rule: "R5", step: "re_estimate", current: { requiresOwner: true, decision: "rejected", emergency: false } }));
  assert.deepEqual(shape(relay.nodes), ["t:report:done", "m:dispatch:done", "o:approve_estimate:done", "m:re_estimate:now", "v:do_repair:next"]);
  assert.deepEqual(relay.lead, { kind: "re_estimate", owner: "張先生" });
  const page = html({ state: "ready", view: "estimate", relay });
  assert.ok(page.includes('<p data-testid="ticket-relay-lead">屋主張先生退回了估價，輪到你重新估價。</p>'));
  assert.ok(page.includes('aria-label="報修進度，現在輪到你重新估價"'));
  assert.ok(page.includes('<span class="v3-st-s">張先生</span><span class="v3-st-s">退回</span>'));
  assert.ok(page.includes("<h1>民生社區 5F・冷氣不冷</h1>"));
  assert.match(page, /<a href="\/m\/tickets">維修<\/a><span aria-hidden="true"> › <\/span><span>民生社區 5F・冷氣不冷<\/span>/);
  // More information is also 重新估價 (frame caption), but 「退回」 is not drawn under 屋 for it.
  const more = estimateRelay(facts({ rule: "R5", step: "re_estimate", current: { requiresOwner: true, decision: "more_information", emergency: false } }));
  assert.equal(more.nodes?.[2].subs.some(s => s.kind === "sent_back"), false);
  assert.ok(more.lead && more.hidden.includes("more_information_sub"));
  const cannot = estimateRelay(facts({ rule: "R5", step: "re_estimate", canAct: false, current: { requiresOwner: true, decision: "rejected", emergency: false } }));
  assert.equal(cannot.lead, null); assert.ok(cannot.hidden.includes("lead_cannot_act"));
  const unnamed = estimateRelay(facts({ rule: "R5", step: "re_estimate", names: { ...names, owner: " " }, current: { requiresOwner: true, decision: "rejected", emergency: false } }));
  assert.equal(unnamed.lead, null); assert.ok(unnamed.hidden.includes("lead_no_name"));
  assert.ok(!html({ state: "ready", view: "estimate", relay: unnamed }).includes("ticket-relay-lead"));
});

test("MGT-150-AC5: closed, cancelled and resolved-done show no relay and no tick; never a day count", () => {
  for (const [rule, status] of [["R1", "closed"], ["R1", "cancelled"], ["R4", "resolved"]] as const) {
    const relay = estimateRelay(facts({ rule, holder: "none", step: "done", canAct: false, status, current: { requiresOwner: true, decision: null, emergency: true } }));
    assert.equal(relay.nodes, null); assert.equal(relay.why, null); assert.ok(relay.hidden.includes("done"));
    const page = html({ state: "ready", view: "estimate", relay });
    assert.doesNotMatch(page, /<svg|v3-done|check|data-testid="ticket-relay"/);
  }
  const exact = estimateRelay({ ...facts({ rule: "R3", holder: "owner", step: "approve_estimate", canAct: false, current: { requiresOwner: true, decision: null, emergency: false } }),
    turn: { rule: "R3", holder: "owner", step: "approve_estimate", sinceExact: true, viewerCanAct: false } });
  assert.ok(exact.hidden.includes("day_count"));
  assert.doesNotMatch(html({ state: "ready", view: "estimate", relay: exact }), /第|天|day/i);
});

test("GS-44: states outside the frames draw nothing and are named; a stale cross-read never guesses", () => {
  const inProgress = estimateRelay(facts({ rule: "R8", step: "in_progress" }));
  assert.equal(inProgress.nodes, null); assert.ok(inProgress.hidden.includes("manager_in_progress"));
  const blocked = estimateRelay(facts({ rule: "R8-blocked", step: "in_progress", current: { requiresOwner: true, decision: "rejected", emergency: true } }));
  assert.equal(blocked.nodes, null); assert.equal(blocked.why, null);
  const redispatch = estimateRelay(facts({ rule: "R8-blocked", step: "dispatch" }));
  assert.deepEqual(shape(redispatch.nodes), ["t:report:done", "m:dispatch:now", "v:do_repair:next", "m:confirm_cost:next"]);
  assert.ok(redispatch.hidden.includes("blocked_reason"));
  // Turn says R3/R5 but the approval read disagrees (separate snapshots): no relay at all.
  for (const [rule, current] of [["R3", null], ["R3", { requiresOwner: true, decision: "approved", emergency: false }],
    ["R5", { requiresOwner: true, decision: "rejected", emergency: true }], ["R5", { requiresOwner: false, decision: null, emergency: false }]] as const) {
    const relay = estimateRelay(facts({ rule, current }));
    assert.equal(relay.nodes, null, rule); assert.ok(relay.hidden.includes("snapshot_mismatch"));
  }
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
    assert.equal(now.length, 1);
    assert.equal(relay.nodes.some(n => n.party === "o"), current?.requiresOwner === true);
    assert.equal(relay.nodes[0].party, "t");
    if (now[0].party === "o") assert.equal(rule, "R3");
    if (relay.lead) assert.equal(rule, "R5");
  }
  assert.ok(drawn > 100);
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
  assert.ok(can.hidden.includes("dispatcher_name"));
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

test("MGT-150-AC2 / PLT-52-AC4 maintenance frame: 租 → 管 → 廠 → 管, status only, no 屋, no timing, no why-line", () => {
  assert.equal(maintenanceRelay.length, 1);
  const relay = maintenanceRelay({ status: "in_progress", names: { tenant: "黃小姐", vendor: "陳師傅" } });
  assert.deepEqual(shape(relay.nodes), ["t:report:done", "m:dispatch:done", "v:do_repair:now", "m:confirm_cost:next"]);
  const page = html({ state: "ready", view: "maintenance", relay });
  assert.ok(page.includes('<p data-testid="ticket-relay-lead">狀態：處理中</p>'));
  assert.ok(page.includes('aria-label="報修進度"'));
  assert.ok(page.includes('<span class="v3-st-s">管理方</span>'));
  for (const hidden of ["屋", "核准估價", "估價", "重新估價", "v3-why", "第", "天", "你"]) assert.ok(!page.includes(hidden), hidden);
  assert.deepEqual(shape(maintenanceRelay({ status: "open", names: { tenant: null, vendor: null } }).nodes),
    ["t:report:done", "m:dispatch:now", "v:do_repair:next", "m:confirm_cost:next"]);
  for (const status of ["assigned", "on_hold", "resolved", "closed", "cancelled"] as const) {
    const other = maintenanceRelay({ status, names: { tenant: null, vendor: null } });
    assert.equal(other.nodes, null); assert.ok(other.hidden.includes("maintenance_status"));
    assert.doesNotMatch(html({ state: "ready", view: "maintenance", relay: other }), /data-testid="ticket-relay"|<svg/);
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
  const detail = { ticketId: TICKET, status: "in_progress", holder: null, step: null, viewerCanAct: false, since: null, sinceExact: false };
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
      estimateFacts: async () => { seen.push("estimate"); return { status: "resolved", tenant: null, vendor: null, owner: "張先生", pendingCost }; } });
    assert.deepEqual(seen, []); assert.deepEqual(out, baseline); assert.equal(html(out), baseHtml);
  }
  // A malformed maintenance projection is unavailable, never a guessed view.
  assert.deepEqual(await loadTicketRelay(maintenanceSession, TICKET, { turns: turnsFor({ ...detail, status: "weird" }, "maintenance"), publicFacts, approvals: fail, estimateFacts: fail }), { state: "unavailable" });
});

test("loader: estimate path composes the turn, the current head and facts; states map without guessing", async () => {
  const detail = { ticketId: TICKET, rule: "R5", holder: "manager", step: "re_estimate", viewerCanAct: true, since: null, sinceExact: false, timezone: "Asia/Taipei", place: "x" };
  let decidedBy: string | null = "unset";
  const out = await loadTicketRelay(staff, TICKET, { turns: turnsFor(detail),
    approvals: async (_s, input) => { assert.equal(input.ticketId, TICKET); return [approvalRow({ is_current: false, decision: "approved" }),
      approvalRow({ decision: "rejected", decided_by: "00000000-0000-4000-8000-0000000000d1" })]; },
    estimateFacts: async (_s, id, by) => { assert.equal(id, TICKET); decidedBy = by; return { status: "in_progress", tenant: "周小姐", vendor: "陳師傅", owner: "張先生", pendingCost: false }; },
    publicFacts: fail });
  assert.equal(decidedBy, "00000000-0000-4000-8000-0000000000d1");
  assert.ok(out.state === "ready" && out.view === "estimate" && out.relay.lead?.owner === "張先生");
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
