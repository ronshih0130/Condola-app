import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ownerRulesAvailable, ownerRulesPage } from "./b094-owner-rules";
import { ownerNavigationV3 } from "./nav-v3";
import { RulesError, RulesLoading, RulesNoPerm, RulesView, repairPolicyHref } from "../components/v3/o/rules/rules";
import { brandV3OwnerRulesCopy } from "../i18n/lanes/brand-v3-owner-rules";
import type { OwnerRuleView } from "./b091-owner-rules";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// B-094 / RO-RULES (更多 › 授權規則, OWN-34-AC1…AC5). Synthetic data only.
const read = (p: string) => readFileSync(p, "utf8");
const owner: Session = { kind: "owner", role: null, orgId: "00000000-0000-4000-8000-000000000001", liveOrgId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic", email: "",
  environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const P1 = "00000000-0000-4000-8000-0000000000c1", P2 = "00000000-0000-4000-8000-0000000000c2", P3 = "00000000-0000-4000-8000-0000000000c3";
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const render = (node: React.ReactElement) => renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const ready: OwnerRuleView = { state: "ready", rule: "delegate_notify", revision: 0, changedAt: null };
const firm = async () => ({ name: "安居物業" }) as never;
const names = async () => [{ id: P1, name: "信義路 2 樓" }, { id: P2, name: "景興路套房" }, { id: P3, name: "松山路套房" }];
const enabled = (effectiveMinor: string | null) => ({ state: "enabled" as const, propertyId: "", ownershipId: "", currency: "TWD", minorUnit: 0, defaultMinor: null,
  defaultSource: "", overrideMinor: null, effectiveMinor, effectiveSource: "", verified: true, snapshot: "" });

test("RO-RULES copy: the approved zh-TW strings (PR-023) and never 收款 or 入帳", () => {
  const zh = brandV3OwnerRulesCopy("zh-TW");
  assert.equal(zh.title, "授權規則");
  assert.deepEqual([zh.repairs, zh.renewal, zh.edit], ["修繕", "續租", "修改"]);
  assert.deepEqual(zh.rules, { delegate_notify: "交給管理方，只要通知我", delegate_unless_lower: "租金不降就交給管理方，要降價才問我", ask_every_time: "每次都問我" });
  assert.equal(zh.limit("信義路 2 樓", "NT$5,000"), "信義路 2 樓・NT$5,000 以下直接修");
  assert.equal(zh.note("安居物業"), "改了會通知安居物業，也會留下紀錄。");
  assert.equal(zh.saveFailed, "沒有存成功，請再試一次。");
  assert.doesNotMatch(JSON.stringify(zh) + zh.limit("a", "b") + zh.note("c"), /收款|入帳/);
  const en = brandV3OwnerRulesCopy("en");
  assert.deepEqual(Object.keys(en.rules), Object.keys(zh.rules));
});

test("OWN-34-AC2/AC3: per-property repair limits with 「修改」, three renewal options, the stored one checked, the note; no solid primary", () => {
  const html = render(<RulesView locale="zh-TW" company="安居物業" rule="delegate_unless_lower" revision={3}
    repairs={[{ propertyId: P1, name: "信義路 2 樓", minor: "5000", currency: "TWD", minorUnit: 0 }, { propertyId: P2, name: "景興路套房", minor: null, currency: "TWD", minorUnit: 0 }]} />);
  const t = text(html);
  assert.match(t, /信義路 2 樓・NT\$5,000 以下直接修/);
  assert.match(t, /景興路套房修改/, "a property without an effective limit shows its name and 「修改」, never a guessed amount");
  assert.equal((html.match(/>修改</g) ?? []).length, 2);
  assert.ok(html.includes(`href="${repairPolicyHref(P1)}"`) && html.includes(`href="${repairPolicyHref(P2)}"`));
  assert.match(t, /交給管理方，只要通知我.*租金不降就交給管理方，要降價才問我.*每次都問我/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  assert.match(html, /<input type="radio" name="renewal-rule" checked="" value="delegate_unless_lower"\/>/);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  assert.match(t, /改了會通知安居物業，也會留下紀錄。/);
  assert.doesNotMatch(html, /owner-primary|btn pri|<button/);
  assert.doesNotMatch(t, /沒有存成功/);
});

test("OWN-34: no repair policy entries → only the renewal section", () => {
  const html = render(<RulesView locale="zh-TW" company="安居物業" rule="delegate_notify" revision={0} repairs={[]} />);
  assert.doesNotMatch(html, /owner-rules-repairs|修繕/);
  assert.match(html, /<input type="radio" name="renewal-rule" checked="" value="delegate_notify"\/>/);
});

test("OWN-34-AC5 / states: loading has skeletons and no control or amount; read error and B1-NOPERM in place", () => {
  const loading = render(<RulesLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading, /<input|<a |NT\$/);
  assert.doesNotMatch(text(loading).replace("授權規則", ""), /\S/, "no text beyond the hidden title");
  const error = text(render(<RulesError locale="zh-TW" />));
  assert.match(error, /這裡暫時讀不到，請再試一次。再試一次/);
  const noPerm = render(<RulesNoPerm locale="zh-TW" />);
  assert.match(noPerm, /owner-rules-noperm/);
  assert.match(noPerm, /href="\/o"/);
});

test("loader: off/forbidden/unavailable pass through; policies off or recovery-only are left out; one unreadable policy fails the read", async () => {
  for (const state of ["off", "forbidden", "unavailable"] as const)
    assert.deepEqual(await ownerRulesPage(owner, { rule: async () => ({ state }), names: async () => { throw new Error("no read expected"); }, firm: async () => { throw new Error("no firm read before admission"); } }), { state });
  const seen: string[] = [];
  const page = await ownerRulesPage(owner, {
    rule: async () => ready, names, firm, entries: async (_s, ids) => ids.filter(id => id !== P3),
    policy: async (_s, id) => { seen.push(id); return id === P1 ? enabled("5000") : { state: "recovery_only" }; },
  });
  assert.deepEqual(seen, [P1, P2]);
  assert.deepEqual(page, { state: "ready", rule: ready, repairs: [{ propertyId: P1, name: "信義路 2 樓", minor: "5000", currency: "TWD", minorUnit: 0 }], company: "安居物業" });
  for (const bad of ["unavailable", "busy"] as const)
    assert.deepEqual(await ownerRulesPage(owner, { rule: async () => ready, names, entries: async (_s, ids) => ids,
      policy: async (_s, id) => id === P2 ? { state: bad } : enabled("1") }), { state: "unavailable" });
  assert.deepEqual(await ownerRulesPage(owner, { rule: async () => ready, names: async () => { throw new Error("boom"); } }), { state: "unavailable" });
});

test("RO-MORE: the entry is live only when the rule reads ready; a failed read hides it", async () => {
  assert.equal(await ownerRulesAvailable(owner, { rule: async () => ready }), true);
  for (const state of ["off", "forbidden", "unavailable"] as const) assert.equal(await ownerRulesAvailable(owner, { rule: async () => ({ state }) }), false);
  assert.equal(await ownerRulesAvailable(owner, { rule: async () => { throw new Error("boom"); } }), false);
});

test("RO-MORE / OWN-34-AC1: 授權規則 first in 更多; it replaces the per-property 修繕規則 entries; OFF keeps today's list", () => {
  const properties = [{ id: P1, name: "信義路 2 樓" }, { id: P2, name: "景興路套房" }];
  const off = ownerNavigationV3(owner, properties, [P1, P2], "enabled", true, true);
  assert.deepEqual(off.more.map(e => e.id), ["decided", "receipt-title", `repair-policy-${P1}`, `repair-policy-${P2}`]);
  assert.deepEqual(ownerNavigationV3(owner, properties, [P1, P2], "enabled", true, true, false), off);
  const on = ownerNavigationV3(owner, properties, [P1, P2], "enabled", true, true, true);
  assert.deepEqual(on.more.map(e => e.id), ["rules", "decided", "receipt-title"]);
  assert.deepEqual(on.more[0], { id: "rules", href: "/o/rules", label: "授權規則", icon: "tool" });
  assert.deepEqual(on.areas, off.areas);
});

test("wiring: the route 404s only when off; the layout passes the live flag; the action repeats consent and the effective-session guard", () => {
  const route = read("src/app/o/rules/page.tsx");
  assert.match(route, /if \(!\(await brandV3EnabledForOrg\(session\.orgId\)\)\) notFound\(\);/);
  assert.match(route, /if \(\(await ownerRuleView\(session\)\)\.state === "off"\) notFound\(\);/);
  assert.match(route, /<Suspense fallback=\{<RulesLoading/);
  const layout = read("src/app/o/layout.tsx");
  assert.match(layout, /const rules = await ownerRulesAvailable\(session\);/);
  assert.match(layout, /Boolean\(receiptTitle\), decided, rules\)/);
  const action = read("src/server/b094-owner-rules-actions.ts");
  assert.match(action, /^"use server";/);
  assert.match(action, /await requireCurrentConsent\(\);\n  return setOwnerRule\(await guardEffectiveSession\(await getSession\(\), null\), input\);/);
  const choice = read("src/components/v3/o/rules/rule-choice.tsx");
  assert.match(choice, /disabled=\{pending\}/);
  assert.match(choice, /expectedRevision: previous\.revision/);
});
