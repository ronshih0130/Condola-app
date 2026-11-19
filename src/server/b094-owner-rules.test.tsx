import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ownerRulesAvailable, ownerRulesPage, repairLimitState, type RepairLimitLine } from "./b094-owner-rules";
import { ownerNavigationV3 } from "./nav-v3";
import { RulesError, RulesLoading, RulesNoPerm, RulesView, repairPolicyHref } from "../components/v3/o/rules/rules";
import { brandV3OwnerRulesCopy } from "../i18n/lanes/brand-v3-owner-rules";
import { afterSave, startsSave, syncFromServer } from "../components/v3/o/rules/rule-choice-state";
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
const enabled = (effectiveMinor: string | null, effectiveSource = "property_override", currency = "TWD", minorUnit = 0) => ({ state: "enabled" as const, propertyId: "", ownershipId: "",
  currency, minorUnit, defaultMinor: null, defaultSource: "", overrideMinor: null, effectiveMinor, effectiveSource, verified: true, snapshot: "" });

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
    repairs={[{ propertyId: P1, name: "信義路 2 樓", minor: "5000", currency: "TWD", minorUnit: 0, state: "owner" }, { propertyId: P2, name: "景興路套房", minor: null, currency: "TWD", minorUnit: 0, state: "pending" }]} />);
  const t = text(html);
  assert.match(t, /信義路 2 樓・NT\$5,000 以下直接修/);
  assert.match(t, /景興路套房修改/, "a limit awaiting confirmation shows its name and 「修改」, never a guessed amount");
  assert.equal((html.match(/>修改</g) ?? []).length, 2);
  assert.ok(html.includes(`href="${repairPolicyHref(P1)}"`) && html.includes(`href="${repairPolicyHref(P2)}"`));
  assert.match(t, /交給管理方，只要通知我.*租金不降就交給管理方，要降價才問我.*每次都問我/);
  assert.equal((html.match(/<button type="button"/g) ?? []).length, 3);
  assert.match(html, /aria-pressed="true" data-rule="delegate_unless_lower"/);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 2);
  assert.match(html, /role="group" aria-labelledby="([^"]+)"[^>]*>.*<h3 class="rules-section" id="\1">續租<\/h3>/);
  assert.doesNotMatch(html, /aria-disabled/);
  assert.match(t, /改了會通知安居物業，也會留下紀錄。/);
  assert.doesNotMatch(html, /owner-primary|btn pri/);
  assert.doesNotMatch(t, /沒有存成功/);
});

test("OWN-34: no repair policy entries → only the renewal section", () => {
  const html = render(<RulesView locale="zh-TW" company="安居物業" rule="delegate_notify" revision={0} repairs={[]} />);
  assert.doesNotMatch(html, /owner-rules-repairs|修繕/);
  assert.match(html, /aria-pressed="true" data-rule="delegate_notify"/);
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
  assert.deepEqual(page, { state: "ready", rule: ready, repairs: [{ propertyId: P1, name: "信義路 2 樓", minor: "5000", currency: "TWD", minorUnit: 0, state: "owner" }], company: "安居物業" });
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
  assert.match(route, /^export default withPageFlagGate\(\{\n  flagKey: "brand_v3",\n  flag: async session => brandV3EnabledForOrg\(session\.orgId\),\n\}, /m); // Lauren 2d: consent, session and the brand_v3 404 run in withPageFlagGate
  assert.match(route, /if \(\(await ownerRuleViewOnce\(session\)\)\.state === "off"\) notFound\(\);/);
  assert.match(route, /<Suspense fallback=\{<RulesLoading/);
  const layout = read("src/app/o/layout.tsx");
  assert.match(layout, /const rules = await ownerRulesAvailable\(session\);/);
  assert.match(layout, /Boolean\(receiptTitle\), decided, rules\)/);
  const action = read("src/server/b094-owner-rules-actions.ts");
  assert.match(action, /^"use server";/);
  assert.match(action, /await requireCurrentConsent\(\);\n  return setOwnerRule\(await guardEffectiveSession\(await getSession\(\), null\), input\);/);
  const choice = read("src/components/v3/o/rules/rule-choice.tsx");
  assert.match(choice, /if \(!startsSave\(busy\.current \|\| pending, state\.saved\.rule, next\)\) return;/);
  assert.match(choice, /expectedRevision: previous\.revision/);
  assert.match(choice, /catch \{ outcome = "threw"; \}/);
  assert.doesNotMatch(read("src/components/v3/o/rules/rules.tsx"), /<RenewalRuleChoice key=/, "no remount on a new revision (focus)");
  assert.match(choice, /useEffect\(\(\) => \{ setState\(current => syncFromServer\(current, busy\.current, rule, revision\)\); \}, \[rule, revision\]\);/);
});

test("OWN-34-AC5 save outcomes: success stores; stale shows the stored rule; any other failure or a throw keeps the previous rule; all failures show the error", () => {
  const prev = { rule: "delegate_notify" as const, revision: 2 };
  assert.deepEqual(afterSave(prev, { ok: true, rule: "ask_every_time", revision: 3 }), { saved: { rule: "ask_every_time", revision: 3 }, selected: "ask_every_time", error: false, refresh: true });
  assert.deepEqual(afterSave(prev, { ok: false, reason: "stale", rule: "delegate_unless_lower", revision: 5 }), { saved: { rule: "delegate_unless_lower", revision: 5 }, selected: "delegate_unless_lower", error: true, refresh: false });
  for (const reason of ["off", "forbidden", "invalid", "conflict", "failed"])
    assert.deepEqual(afterSave(prev, { ok: false, reason }), { saved: prev, selected: "delegate_notify", error: true, refresh: false }, reason);
  assert.deepEqual(afterSave(prev, "threw"), { saved: prev, selected: "delegate_notify", error: true, refresh: false });
  assert.equal(startsSave(false, "delegate_notify", "ask_every_time"), true);
  assert.equal(startsSave(true, "delegate_notify", "ask_every_time"), false, "a second choice while saving is ignored");
  assert.equal(startsSave(false, "delegate_notify", "delegate_notify"), false, "choosing the stored rule saves nothing");
  const state = { saved: prev, selected: "ask_every_time" as const, error: true };
  assert.deepEqual(syncFromServer(state, false, "delegate_unless_lower", 3), { saved: { rule: "delegate_unless_lower", revision: 3 }, selected: "delegate_unless_lower", error: false });
  assert.equal(syncFromServer(state, true, "delegate_unless_lower", 3), state, "never while saving");
  assert.equal(syncFromServer(state, false, "delegate_unless_lower", 2), state, "same revision: keep local state (error stays)");
  assert.equal(syncFromServer(state, false, "delegate_unless_lower", 1), state, "never back to an older revision");
});

test("client bundle: rule-choice reaches no server module (db, pg, node:*) through its relative imports", () => {
  const seen = new Set<string>(), bad: string[] = [];
  const resolve = (from: string, spec: string) => {
    const base = path.resolve(path.dirname(from), spec);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(candidate) && !candidate.endsWith("/")) try { if (readFileSync(candidate)) return candidate; } catch { /* directory */ }
    throw new Error(`unresolved ${spec} from ${from}`);
  };
  const walk = (file: string) => {
    if (seen.has(file)) return; seen.add(file);
    const src = read(file);
    // A "use server" module is an action reference in the client bundle, not its code.
    if (file !== path.resolve("src/components/v3/o/rules/rule-choice.tsx") && /^["']use server["'];/.test(src)) return;
    for (const m of src.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["'];?|import\(\s*["']([^"']+)["']\s*\)/gm)) {
      const typeOnly = m[1], spec = m[2] ?? m[3];
      if (typeOnly) continue;
      if (spec === "pg" || spec.startsWith("node:") || /(^|\/)db$/.test(spec)) { bad.push(`${path.relative(process.cwd(), file)} → ${spec}`); continue; }
      if (spec.startsWith(".")) walk(resolve(file, spec));
      else if (spec.startsWith("@/")) walk(resolve(path.resolve("src/x"), `./${spec.slice(2)}`));
    }
  };
  walk(path.resolve("src/components/v3/o/rules/rule-choice.tsx"));
  assert.deepEqual(bad, []);
  assert.ok([...seen].some(f => f.endsWith("b091-owner-rules-values.ts")));
  assert.ok(![...seen].some(f => f.endsWith("b091-owner-rules.ts")), "the server module must not be in the client graph");
});

// B-113 / R8-OWNRULE, OWN-34-AC6: which limit applies when the owner has not set one (B-021 facts, app a0aa278e).
const line = (state: RepairLimitLine["state"], minor: string | null, extra: Partial<RepairLimitLine> = {}): RepairLimitLine =>
  ({ propertyId: P1, name: "景興路套房", minor, currency: "TWD", minorUnit: 2, state, ...extra });
const rules = (repairs: RepairLimitLine[]) => render(<RulesView locale="zh-TW" company="安居物業" rule="delegate_notify" revision={0} repairs={repairs} />);

test("OWN-34-AC6 copy: verbatim from stories.md § Round 8 and the approved frame; never 收款 or 入帳", () => {
  const zh = brandV3OwnerRulesCopy("zh-TW");
  assert.equal(zh.regional("景興路套房", "NT$5,000"), "景興路套房・你還沒設定，目前用預設：NT$5,000 以下直接修");
  assert.equal(zh.zero("仁愛路 6F"), "仁愛路 6F・每一筆都會先問你");
  assert.equal(zh.unset("景興路套房"), "景興路套房・還沒設定上限，請先設定，廠商才能送估價");
  assert.equal(zh.set, "設定");
  assert.doesNotMatch(zh.regional("a", "b") + zh.zero("c") + zh.unset("d") + zh.set, /收款|入帳|任何維修都會先問你/);
  const en = brandV3OwnerRulesCopy("en");
  assert.equal(typeof en.regional("a", "b"), "string");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test("OWN-34-AC6 state: B-021's resolution maps to the four states; 0 is a limit, NULL is not set; confirmations stay name-only", () => {
  assert.equal(repairLimitState("property_override", "5000"), "owner");
  assert.equal(repairLimitState("owner_default", "600000"), "owner");
  assert.equal(repairLimitState("property_override", "0"), "zero");
  assert.equal(repairLimitState("owner_default", "0"), "zero");
  assert.equal(repairLimitState("regional_default", "500000"), "regional");
  assert.equal(repairLimitState("configuration_required", null), "unset");
  for (const source of ["owner_default_confirmation_required", "legacy_confirmation_required", "", "unknown"]) assert.equal(repairLimitState(source, null), "pending", source);
  assert.equal(repairLimitState("regional_default", null), "pending", "a regional source without an amount never guesses one");
  assert.equal(repairLimitState("property_override", null), "pending");
});

test("OWN-34-AC6 render: the four states, each with its own sentence and link; only 「請先設定」 has a solid 「設定」", () => {
  const owned = rules([line("owner", "500000", { name: "信義路 2 樓" })]);
  assert.match(text(owned), /信義路 2 樓・NT\$5,000 以下直接修修改/);
  assert.doesNotMatch(owned, /owner-primary/);
  const zero = rules([line("zero", "0", { name: "仁愛路 6F" })]);
  assert.match(text(zero), /修繕仁愛路 6F・每一筆都會先問你修改續租/);
  assert.doesNotMatch(text(zero), /NT\$0/, "0 is said as 「每一筆都會先問你」, not an amount");
  const regional = rules([line("regional", "500000")]);
  assert.match(text(regional), /景興路套房・你還沒設定，目前用預設：NT\$5,000 以下直接修設定/);
  assert.match(regional, /<a class="rules-edit" href="\/o\/repair-policy\/[^"]+">設定<\/a>/, "「設定」 is a text link");
  assert.doesNotMatch(regional, /owner-primary|>修改</);
  const unset = rules([line("unset", null)]);
  assert.match(text(unset), /景興路套房・還沒設定上限，請先設定，廠商才能送估價設定/);
  assert.match(unset, new RegExp(`<a class="owner-action owner-primary" href="${repairPolicyHref(P1).replace(/[/]/g, "\\/")}">設定</a>`));
  assert.equal((unset.match(/owner-primary/g) ?? []).length, 1);
  const pending = rules([line("pending", null)]);
  assert.match(text(pending), /景興路套房修改/);
  assert.doesNotMatch(text(pending), /NT\$|預設|請先設定|每一筆/);
  // Mixed page: one line per property, in order, with the matching data-limit.
  const all = rules([line("owner", "500000", { propertyId: P1, name: "信義路 2 樓" }), line("regional", "500000", { propertyId: P2 }), line("zero", "0", { propertyId: P3, name: "仁愛路 6F" })]);
  assert.deepEqual([...all.matchAll(/data-limit="([a-z]+)"/g)].map(m => m[1]), ["owner", "regional", "zero"]);
  assert.doesNotMatch(text(all), /任何維修都會先問你/);
});

test("OWN-34-AC6 amount: the regional default comes from the line's own amount, currency and minor unit, never a constant", () => {
  assert.match(text(rules([line("regional", "500000", { minorUnit: 2 })])), /目前用預設：NT\$5,000 以下直接修/);
  assert.match(text(rules([line("regional", "5000", { minorUnit: 0 })])), /目前用預設：NT\$5,000 以下直接修/);
  assert.match(text(rules([line("regional", "300000", { minorUnit: 2 })])), /目前用預設：NT\$3,000 以下直接修/);
  assert.match(text(rules([line("regional", "12345", { currency: "USD", minorUnit: 2 })])), /目前用預設：USD 123\.45 以下直接修/);
  assert.doesNotMatch(read("src/components/v3/o/rules/rules.tsx") + read("src/server/b094-owner-rules.ts"), /500000|5,000|5000/, "no hard-coded default");
});

test("OWN-34-AC6 loader: the view's effective source decides each line's state; one property each", async () => {
  const views: Record<string, ReturnType<typeof enabled>> = {
    [P1]: enabled("0", "owner_default"), [P2]: enabled("500000", "regional_default", "TWD", 2), [P3]: enabled(null, "configuration_required", "USD", 2),
  };
  const page = await ownerRulesPage(owner, { rule: async () => ready, names, firm, entries: async (_s, ids) => ids, policy: async (_s, id) => views[id] });
  assert.ok(page.state === "ready");
  assert.deepEqual(page.repairs.map(r => [r.propertyId, r.state, r.minor, r.currency, r.minorUnit]),
    [[P1, "zero", "0", "TWD", 0], [P2, "regional", "500000", "TWD", 2], [P3, "unset", null, "USD", 2]]);
});
