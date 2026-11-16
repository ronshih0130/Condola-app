import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LeasesView, LeasesLoading, leasesHref, leaseStatusLabels } from "./leases";
import { LeaseView, LeaseLoading, NoPermission, leaseHref, leaseLead, leaseV3Tab, leaseV3View } from "./lease";
import type { LeaseReady, LeasesResult } from "../../../../server/b3-leases";

const id = "00000000-0000-4000-8000-000000000071";
const list: Extract<LeasesResult, { state: "ready" }> = { state: "ready", q: "", page: 1, total: 3, filteredCount: 3, hasNext: false, rows: [
  { id, tenant: "Synthetic A", place: "Unit 3F Room A", status: "active", endDate: "2027-04-30", endingSoon: false },
  { id: "00000000-0000-4000-8000-000000000072", tenant: "Synthetic B", place: "Unit 2", status: "active", endDate: "2026-12-31", endingSoon: true },
  { id: "00000000-0000-4000-8000-000000000073", tenant: "Synthetic C", place: "Unit 9", status: "ended", endDate: "2026-01-31", endingSoon: false },
] };
const renderList = (data: Parameters<typeof LeasesView>[0]["data"], params = {}, canCreate = true) =>
  renderToStaticMarkup(<LeasesView data={data} locale="zh-TW" params={params} canCreate={canCreate} />);
const lease: LeaseReady = { state: "ready", id, tenant: "Synthetic A", place: "Unit 2", status: "active", startDate: "2026-05-01",
  endDate: "2027-04-30", currency: "TWD", rentMinor: "1800000", depositMinor: "2400000", dueDay: 5 };
const renderLease = (props: Partial<Parameters<typeof LeaseView>[0]> = {}) =>
  renderToStaticMarkup(<LeaseView data={lease} locale="zh-TW" id={id} handover home="/m" {...props} />);
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
  assert.ok(anchors(failed).some(([href, label]) => href === "/m/leases?q=a%26b" && label === "再試一次"));
  const loading = renderToStaticMarkup(<LeasesLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/); assert.doesNotMatch(loading.replace(/<[^>]+>/g, ""), /\d|NT\$|件/);
});
test("pager and hrefs keep the search", () => {
  const html = renderList({ ...list, q: "x", page: 2, hasNext: true }, { q: "x", page: "2" });
  assert.ok(anchors(html).some(([href]) => href === "/m/leases?q=x"));
  assert.ok(anchors(html).some(([href]) => href === "/m/leases?q=x&page=3"));
  assert.equal(leasesHref({ q: "a b", page: "1" }), "/m/leases?q=a+b");
});
test("lease page shell: lead, five tabs in order, 點交 is the existing handover page, current tab marked", () => {
  const html = renderLease();
  assert.ok(html.includes("Synthetic A住Unit 2，租約到 2027-04-30。"));
  const tabs = [...html.matchAll(/data-testid="lease-tab-([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ["overview", "fees", "deposit", "handover", "moveout"]);
  const labels = anchors(html).slice(0, 5).map(([, label]) => label);
  assert.deepEqual(labels, ["概要", "費用", "押金", "點交", "退租結算"]);
  assert.ok(anchors(html).some(([href, label]) => href === `/m/handover/${id}` && label === "點交"));
  assert.match(html, /aria-current="page"[^>]*>概要|data-testid="lease-tab-overview" aria-current="page"/);
  const noHandover = renderLease({ handover: false });
  assert.ok(!noHandover.includes("/m/handover/")); assert.ok(!noHandover.includes(">點交<"));
  assert.equal(leaseLead({ ...lease, endDate: null }, "zh-TW"), "Synthetic A");
});
test("概要 is read only: existing fields, links to the existing page's controls, no forms or solid primary", () => {
  const html = renderLease();
  for (const text of ["NT$18,000", "NT$24,000", "2026-05-01", "進行中"]) assert.ok(html.includes(text), text);
  const legacy = anchors(html).filter(([href]) => href.includes("?tab=")).map(([href]) => href);
  assert.deepEqual(legacy, ["/m/leases/" + id + "?tab=fees", "/m/leases/" + id + "?tab=deposit", "/m/leases/" + id + "?tab=moveout",
    ...["summary", "ledger", "sign", "msg"].map(tab => `/m/leases/${id}?tab=${tab}`)]);
  assert.doesNotMatch(html, /<form|<button|<input|btn pri/);
});
test("費用 is read only: no add or correct control, only the existing billing link", () => {
  const html = renderLease({ tab: "fees" });
  assert.match(html, /data-testid="lease-tab-fees" aria-current="page"/);
  for (const text of ["新增一次性費用", "更正", "已更正", "固定月費", "一次性費用"]) assert.ok(!html.includes(text), text);
  assert.ok(anchors(html).some(([href, label]) => href === `/m/leases/${id}?tab=ledger` && label === "帳務"));
  assert.doesNotMatch(html, /<form|<button|<input|btn pri/);
});
test("押金 is read only: agreed deposit only, never 已收 or a write", () => {
  const html = renderLease({ tab: "deposit" });
  assert.ok(html.includes("約定押金")); assert.match(html, /data-testid="lease-agreed-deposit">NT\$24,000</);
  for (const text of ["記錄收到押金", "更正", "已收", "還差", "多收", "保管方", "入帳"]) assert.ok(!html.includes(text), text);
  assert.doesNotMatch(html, /<form|<button|<input|btn pri/);
});
test("退租結算 shows only the existing page link", () => {
  const html = renderLease({ tab: "moveout" });
  const legacy = anchors(html).filter(([href]) => /tab=(summary|ledger|sign|msg)/.test(href));
  assert.deepEqual(legacy, [[`/m/leases/${id}?tab=summary`, "摘要"]]);
  for (const text of ["送出給租客和屋主", "先存草稿", "新增扣款", "NT$"]) assert.ok(!html.includes(text), text);
});
test("B1-NOPERM for denied roles; read error in place; loading skeleton has no numbers", () => {
  const denied = renderLease({ data: { state: "forbidden" }, home: "/m/tickets" });
  assert.match(denied, /data-v3-illustration="26"/);
  assert.ok(denied.includes("你目前的角色看不到這一頁，需要的話請公司管理員幫你開。"));
  assert.deepEqual(anchors(denied), [["/m/tickets", "回到首頁"]]); assert.equal((denied.match(/btn pri/g) ?? []).length, 1);
  for (const text of ["Synthetic", "NT$", "概要"]) assert.ok(!denied.includes(text), text);
  assert.equal(renderToStaticMarkup(<NoPermission locale="zh-TW" home="/m" />).includes("回到首頁"), true);
  const failed = renderLease({ data: { state: "unavailable" }, tab: "deposit" });
  assert.ok(failed.includes("這裡暫時讀不到，請再試一次。"));
  assert.deepEqual(anchors(failed), [[`/m/leases/${id}?tab=deposit`, "再試一次"]]);
  assert.doesNotMatch(failed, /NT\$|約定押金/);
  const loading = renderToStaticMarkup(<LeaseLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/); assert.doesNotMatch(loading.replace(/<[^>]+>/g, ""), /\d|NT\$/);
});
test("only the v3 tab URLs open the new page; every legacy query keeps the existing page", () => {
  assert.equal(leaseV3View({}), true);
  for (const tab of ["fees", "deposit", "moveout"]) assert.equal(leaseV3View({ tab }), true, tab);
  for (const query of [{ tab: "summary" }, { tab: "ledger" }, { tab: "sign" }, { tab: "msg" }, { tab: "" }, { created: "1" },
    { error: "x" }, { audit: "c" }, { saved: "rent" }, { tab: "fees", error: "x" }, { idv: "ok" }]) assert.equal(leaseV3View(query), false, JSON.stringify(query));
  assert.equal(leaseV3Tab("bogus"), "overview"); assert.equal(leaseV3Tab("deposit"), "deposit");
  assert.equal(leaseHref(id), `/m/leases/${id}`); assert.equal(leaseHref(id, "fees"), `/m/leases/${id}?tab=fees`);
});
test("English copy renders for every state", () => {
  assert.ok(renderToStaticMarkup(<LeasesView data={{ ...list, rows: [], total: 0 }} locale="en" params={{}} canCreate />).includes("No leases yet"));
  assert.ok(renderToStaticMarkup(<LeaseView data={lease} locale="en" id={id} tab="deposit" />).includes("Agreed deposit"));
  assert.ok(renderToStaticMarkup(<LeaseView data={{ state: "forbidden" }} locale="en" id={id} />).includes("Back to home"));
});
