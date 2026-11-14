import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "./locale";
import { DashboardContent } from "./dashboard-content";
import { EmptyState } from "./empty-state";
import { OnboardingProgress } from "./onboarding-progress";
import { can, PERMS, ROLE_KEYS } from "@/server/perms";
import { setupChecklist } from "@/server/onboarding-progress-rules";
import { resolveEmptyCta, type EmptyPage } from "@/lib/empty-cta";
import type { SetupProgress } from "@/server/onboarding-progress";
import type { Session } from "@/server/types";

// Existing JSX modules use the Next compiler's automatic runtime in production.
Object.assign(globalThis, { React });
const session = { kind: "staff", role: "admin", locale: "zh-TW", environment: "live", name: "Test", calendar: "gregorian" } as Session;
const emptyData = { properties: [{ id: "property", name: "Property without units", received: "0", billed: "0" }],
  received: 0, outstanding: 0, owingCount: 0, pending: 0, tickets: 0, occupied: 0, rooms: 0, owing: [], expiring: [] };
function progress(step: 0 | 1 | 2 | 3 | 4, flag = false): SetupProgress {
  const done = [step > 0, step > 1, step > 2, step > 3] as const;
  return { step, checklistOn: flag, hasUnits: step >= 2, inviteMode: "lease", inviteHref: "/m/leases/one", unmappedEntryOk: true,
    tenantJoined: step === 4, permissions: PERMS.map(([key]) => key), checklist: flag ? setupChecklist(done, step === 4 ? "2026-11-13T12:00:00Z" : null, () => true) : null };
}
const render = (node: React.ReactNode) => renderToStaticMarkup(<LocaleProvider locale="zh-TW">{node}</LocaleProvider>);
function dashboard(setup: SetupProgress, actor = session) {
  const cta = resolveEmptyCta({ page: "DASH", setup, can: key => can(actor, key) });
  return render(<DashboardContent session={actor} setup={setup} cta={cta} data={emptyData} query={{}} v2={false} />);
}
function primaryCount(html: string) { return [...html.matchAll(/class="btn pri"/g)].length; }

test("MGT-54-AC1 MGT-55-AC1/AC6: actual dashboard body with properties but no units has no KPIs or empty cards", () => {
  for (const flag of [true, false]) for (const mode of ["m4", "lease", "no_lease"] as const) {
    const html = dashboard({ ...progress(1, flag), inviteMode: mode });
    assert.match(html, /先建立第一個單位/); assert.match(html, /href="\/m\/import"/);
    assert.match(html, /手動新增/); assert.match(html, /先看看範例公司/);
    assert.doesNotMatch(html, /class="card kpi"|empty-DASH_pay|empty-DASH_lease|NT\$0|目前沒有資料。/);
    assert.equal(primaryCount(html), 1);
  }
});
test("MGT-54-AC3 MGT-56-AC8: flag OFF dashboard/messages/leases/tickets/notifications contain no checklist wording", () => {
  for (const role of ROLE_KEYS) for (const step of [0, 1, 2, 3, 4] as const) {
    const actor = { ...session, role }, setup = progress(step);
    for (const page of ["MSG", "LEASE", "TIX", "NOTI"] as const satisfies readonly EmptyPage[]) {
      const html = render(<EmptyState id={page} locale="zh-TW" cta={resolveEmptyCta({ page, setup, can: key => can(actor, key) })} />);
      assert.doesNotMatch(html, /設定清單|[0-4]／[34]|下一步|live-onboarding/);
      assert.ok(primaryCount(html) <= 1);
    }
    const html = dashboard(setup, actor);
    assert.doesNotMatch(html, /設定清單|[0-4]／[34]|下一步|live-onboarding|NT\$0/);
    if (step >= 2) assert.equal(primaryCount(html), 0);
  }
});
test("MGT-55-AC3 MGT-56-AC7: denied dashboard leaves sample link and hint without a mobile primary", () => {
  const html = dashboard(progress(0), { ...session, role: "accountant" });
  assert.match(html, /請管理者完成設定。/); assert.match(html, /先看看範例公司/);
  assert.doesNotMatch(html, /手動新增|es-primary|匯入物件/); assert.equal(primaryCount(html), 0);
});
test("MGT-54-AC2/AC5: collapsed checklist is an expandable, read-only details element; manager n／3", () => {
  const setup = progress(4, true);
  setup.step = 3; setup.tenantJoined = false;
  const html = render(<OnboardingProgress progress={setup} locale="zh-TW" cta={{ primary: null, links: [], showAdminHint: false }} />);
  assert.match(html, /<details/); assert.doesNotMatch(html, /<details[^>]* open|<form|class="btn pri"/);
  assert.match(html, /設定完成/); assert.match(html, /查看/);
  const manager = progress(1, true);
  manager.checklist = setupChecklist([true, false, false, false], null, key => can("manager", key));
  const managerHtml = render(<OnboardingProgress progress={manager} locale="zh-TW" cta={{ primary: null, links: [], showAdminHint: false }} />);
  assert.match(managerHtml, /0／3/); assert.doesNotMatch(managerHtml, /填公司資料/);
});
test("MGT-56-AC5/AC11: decorative approved SVG sizes and both approved copy replacements", () => {
  const html = dashboard(progress(2));
  assert.match(html, /租約生效後就會開始記錄。/);
  assert.match(html, /width="56" height="56"[^>]*aria-hidden="true"/);
  const lease = render(<EmptyState id="LEASE" locale="zh-TW" />);
  assert.match(lease, /建租約時租客可以先略過，送簽前再加入並確認。/);
  assert.match(lease, /width="96" height="96"[^>]*aria-hidden="true"/);
});
