import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LeasesView, LeasesLoading, leasesHref, leaseStatusLabels } from "./leases";
import type { LeasesResult } from "../../../../server/b3-leases";
import { brandV3NavigationCopy } from "../../../../i18n/lanes/brand-v3";

const id = "00000000-0000-4000-8000-000000000071";
const list: Extract<LeasesResult, { state: "ready" }> = { state: "ready", q: "", page: 1, total: 3, filteredCount: 3, lastPage: 1, hasNext: false, rows: [
  { id, tenant: "Synthetic A", place: "Unit 3F Room A", status: "active", endDate: "2027-04-30", endingSoon: false },
  { id: "00000000-0000-4000-8000-000000000072", tenant: "Synthetic B", place: "Unit 2", status: "active", endDate: "2026-12-31", endingSoon: true },
  { id: "00000000-0000-4000-8000-000000000073", tenant: "Synthetic C", place: "Unit 9", status: "ended", endDate: "2026-01-31", endingSoon: false },
] };
const renderList = (data: Parameters<typeof LeasesView>[0]["data"], params = {}, canCreate = true) =>
  renderToStaticMarkup(<LeasesView data={data} locale="zh-TW" params={params} canCreate={canCreate} />);
const navLabels = (html: string) => [...html.matchAll(/<nav [^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
const anchors = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(m => [m[1].replace(/&amp;/g, "&"), m[2]]);

test("R3-LIST rows: tenant + address, 1–2 statuses, one outline 查看, no money and no solid primary", () => {
  const html = renderList(list);
  for (const text of ["Synthetic A", "Unit 3F Room A", "進行中", "即將到期", "已結束", "查看", "租約", "狀態"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /btn pri/);
  assert.doesNotMatch(html, /NT\$|\$\d/);
  assert.ok(anchors(html).some(([href, label]) => href === `/m/leases/${id}` && label === "查看"));
  assert.deepEqual(leaseStatusLabels(list.rows[1], "zh-TW"), ["即將到期", "進行中"]);
  assert.deepEqual(leaseStatusLabels(list.rows[0], "zh-TW"), ["進行中"]);
  for (const text of ["待補資料", "補資料", "還要補資料", "有 3 份租約"]) assert.ok(!html.includes(text), text);
});
test("empty list: approved daily-ops wording and the existing create flow as the one primary", () => {
  const empty = { ...list, rows: [], total: 0, filteredCount: 0 };
  const html = renderList(empty);
  for (const text of ["還沒有租約", "建立第一筆租約就會出現在這裡。", "建立租約"]) assert.ok(html.includes(text), text);
  assert.ok(anchors(html).some(([href, label]) => href === "/m/leases/new" && label === "建立租約"));
  assert.equal((html.match(/btn pri/g) ?? []).length, 1);
  const without = renderList(empty, {}, false);
  assert.ok(without.includes("還沒有租約")); assert.ok(!without.includes("/m/leases/new")); assert.doesNotMatch(without, /btn pri/);
});
test("search with no result: MGT-112-AC6 copy and 清除搜尋 back to the full list", () => {
  const html = renderList({ ...list, q: "nobody", rows: [], filteredCount: 0 });
  for (const text of ["找不到符合的結果", "換個關鍵字，或清除搜尋看全部。", "清除搜尋"]) assert.ok(html.includes(text), text);
  assert.ok(anchors(html).some(([href, label]) => href === "/m/leases" && label === "清除搜尋"));
  assert.ok(!html.includes("還沒有租約")); assert.match(html, /value="nobody"/);
});
test("list 403 (P-ACC): the row's own copy, no buttons; error keeps the typed search; loading has no numbers", () => {
  const denied = renderList({ state: "forbidden" });
  assert.ok(denied.includes("你沒有權限看這頁")); assert.ok(denied.includes("這裡只有管理員和經理能看。"));
  assert.doesNotMatch(denied, /<a |<button|<input/);
  const failed = renderList({ state: "unavailable" }, { q: "a&b" });
  assert.ok(failed.includes("資料載入失敗")); assert.match(failed, /value="a&amp;b"/);
  // O-STATES (GS-02): 再試一次 is the page's one action, so it is the solid primary (the only one).
  assert.ok(anchors(failed).some(([href, label]) => href === "/m/leases?q=a%26b" && label === "再試一次"));
  assert.match(failed, /<a class="btn pri" href="\/m\/leases\?q=a%26b">再試一次<\/a>/); assert.equal((failed.match(/btn pri/g) ?? []).length, 1);
  const loading = renderToStaticMarkup(<LeasesLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/); assert.doesNotMatch(loading.replace(/<[^>]+>/g, ""), /\d|NT\$|件/);
});
test("pager and hrefs keep the search; the pager landmark has its own label", () => {
  const html = renderList({ ...list, q: "x", page: 2, lastPage: 3, filteredCount: 120, hasNext: true }, { q: "x", page: "2" });
  assert.ok(anchors(html).some(([href, label]) => href === "/m/leases?q=x" && label === "上一頁"));
  assert.ok(anchors(html).some(([href, label]) => href === "/m/leases?q=x&page=3" && label === "下一頁"));
  assert.equal(leasesHref({ q: "a b", page: "1" }), "/m/leases?q=a+b");
  // Distinct from the shell's own navigation landmarks and from the page heading 租約.
  assert.deepEqual(navLabels(html), ["第 2 / 3 頁"]);
  for (const label of navLabels(html)) assert.ok(![brandV3NavigationCopy("zh-TW").navigation, "租約"].includes(label), label);
  assert.equal(navLabels(renderList(list)).length, 0);
});
test("past the last page: 上一頁 opens the actual last page, never page 1 or an empty pager", () => {
  const html = renderList({ ...list, page: 7, lastPage: 3, filteredCount: 120, total: 120, rows: [] }, { page: "7" });
  assert.deepEqual(anchors(html), [["/m/leases?page=3", "上一頁"]]);
  assert.equal(navLabels(html).length, 0);
  for (const text of ["還沒有租約", "找不到符合的結果"]) assert.ok(!html.includes(text), text);
  const searched = renderList({ ...list, q: "x", page: 4, lastPage: 1, filteredCount: 2, total: 120, rows: [] }, { q: "x", page: "4" });
  assert.deepEqual(anchors(searched).filter(([, label]) => label === "上一頁"), [["/m/leases?q=x", "上一頁"]]);
  assert.ok(!searched.includes("找不到符合的結果"));
});
test("English copy renders for every state", () => {
  const en = (data: Parameters<typeof LeasesView>[0]["data"]) => renderToStaticMarkup(<LeasesView data={data} locale="en" params={{}} canCreate />);
  assert.ok(en({ ...list, rows: [], total: 0, filteredCount: 0 }).includes("No leases yet"));
  assert.ok(en({ ...list, q: "x", rows: [], filteredCount: 0 }).includes("No matching results"));
  assert.ok(en({ state: "unavailable" }).includes("Try again"));
  assert.ok(en({ state: "forbidden" }).includes("Only admins and managers can see this page."));
  assert.ok(en(list).includes("In progress"));
});
