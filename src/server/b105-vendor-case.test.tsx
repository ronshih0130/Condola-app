import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VendorCaseView, type VendorCaseViewProps } from "../components/v3/vendor/vendor-case";
import { VendorCasePhotos } from "../components/v3/vendor/vendor-case-photos";
import { vendorCaseCopy } from "../i18n/lanes/brand-v3-vendor-case";
import { calendarDate, loadVendorCase, parseDecisionInput, parseVendorCase, vendorCaseStage, type VendorCase } from "./b105-vendor-case";
import { createDecisionController, createPhotoUploadController } from "../components/v3/vendor/vendor-case-controller";

const read = (path: string) => readFileSync(path, "utf8");
const token = Buffer.alloc(32, 7).toString("base64url");
const base: VendorCase = { company: "安居物業", closed: false, decision: null, agreedCompletionOn: null, scheduledOn: null,
  ownerWaitVersion: null, estimates: true, photos: [] };
const view = (overrides: Partial<VendorCaseViewProps> = {}) => renderToStaticMarkup(<VendorCaseView locale="zh-TW" token={token}
  heading="信義路 2 樓・浴室天花板滴水" company="安居物業" stage="accept" presetDate={null} scheduledOn={null}
  ownerWaitVersion={null} estimates {...overrides} />);
const outsideSheet = (html: string) => html.replace(/<dialog[\s\S]*<\/dialog>/, "");
const solids = (html: string) => (html.match(/class="v-token-primary/g) ?? []).length;

test("P52 new words are verbatim from screens.md § Round 7 batch 3 (vendor) and the approved frames", () => {
  const zh = vendorCaseCopy("zh-TW");
  assert.equal(zh.leadAccept, "{company}派了這一件給你，下一步：決定要不要接。");
  assert.equal(zh.badgeAccept, "待接單");
  assert.equal(zh.dueHelp, "過了這天還沒完工，管理方會看到逾期。沒填也可以接單。");
  assert.equal(zh.declineTitle, "不接這一件？");
  assert.equal(zh.declineReason, "原因（選填）");
  assert.equal(zh.declineConfirm, "確定不接");
  assert.equal(zh.declined, "你沒有接這一件，{company}會另外安排。");
  assert.equal(zh.closedInfo, "這一案已結案，照片不能再改。要補照片，請{company}重開這一案。");
  // Already-approved words reused by the frames.
  assert.equal(zh.leadWait, "在等屋主核准估價，核准後就可以約時間。");
  assert.equal(zh.badgeWait, "待屋主核准");
  assert.equal(zh.viewEstimate, "看估價（第 {n} 版，待屋主核准）");
  assert.equal(zh.duePreset, "管理員已填寫約定完工日，接單時看得到、不會被清掉。");
  for (const [key, value] of Object.entries({ accept: "接受工單", decline: "不接受", cancel: "取消", dueLabel: "約定完工日", photos: "處理前／後照片",
    before: "處理前", after: "處理後", uploadBefore: "上傳處理前照片", uploadAfter: "上傳處理後照片", readError: "這裡暫時讀不到，請再試一次。",
    saveError: "沒有存成功，請再試一次。", retry: "再試一次" })) assert.equal(zh[key as keyof typeof zh], value, key);
  assert.deepEqual(Object.keys(vendorCaseCopy("en")).sort(), Object.keys(zh).sort());
});

test("stage order: decline ends it, close is read only, then 接單, owner wait, open", () => {
  assert.equal(vendorCaseStage(base), "accept");
  assert.equal(vendorCaseStage({ ...base, decision: "accepted" }), "open");
  assert.equal(vendorCaseStage({ ...base, decision: "accepted", ownerWaitVersion: 2 }), "owner_wait");
  assert.equal(vendorCaseStage({ ...base, decision: "accepted", closed: true, ownerWaitVersion: 2 }), "closed");
  assert.equal(vendorCaseStage({ ...base, closed: true }), "closed");
  assert.equal(vendorCaseStage({ ...base, decision: "declined", closed: true }), "declined");
});

test("gateway decode is strict; malformed rows are read errors, never a guessed stage", () => {
  const photo = { id: "00000000-0000-4000-8000-000000000001", name: "a.jpg", phase: "after", viewable: true };
  assert.deepEqual(parseVendorCase({ ...base, photos: [photo], agreedCompletionOn: "2026-11-21" }).photos, [photo]);
  for (const bad of [null, [], { ...base, decision: "maybe" }, { ...base, ownerWaitVersion: 0 }, { ...base, closed: "no" },
    { ...base, scheduledOn: "11/21" }, { ...base, photos: [{ ...photo, phase: "during" }] }, { ...base, photos: [{ ...photo, id: "x" }] }]) {
    assert.throws(() => parseVendorCase(bad));
  }
});

test("decision input: optional reason and date, never both, bounded", () => {
  const requestId = "00000000-0000-4000-8000-000000000002";
  assert.deepEqual(parseDecisionInput({ requestId, decision: "accepted", agreedOn: "2026-11-21" }), { requestId, decision: "accepted", agreedOn: "2026-11-21", reason: null });
  assert.deepEqual(parseDecisionInput({ requestId, decision: "accepted", agreedOn: "" }), { requestId, decision: "accepted", agreedOn: null, reason: null });
  assert.deepEqual(parseDecisionInput({ requestId, decision: "declined", reason: "  這週排不出時間 " }), { requestId, decision: "declined", agreedOn: null, reason: "這週排不出時間" });
  assert.deepEqual(parseDecisionInput({ requestId, decision: "declined", reason: "   " }), { requestId, decision: "declined", agreedOn: null, reason: null });
  for (const bad of [{ requestId: "x", decision: "accepted" }, { requestId, decision: "propose" }, { requestId, decision: "accepted", agreedOn: "2026/11/21" },
    { requestId, decision: "accepted", reason: "why" }, { requestId, decision: "declined", agreedOn: "2026-11-21" },
    { requestId, decision: "declined", reason: "長".repeat(501) }, { requestId, decision: "declined", reason: 5 }]) assert.equal(parseDecisionInput(bad), null);
});

test("RV-JOB-ACCEPT: lead, 待接單, empty date with vendor help, one solid 接受工單, outline 不接受, no 其他 yet", () => {
  const html = view({ scheduledOn: "2026-11-18" });
  for (const text of ["安居物業派了這一件給你，下一步：決定要不要接。", "信義路 2 樓・浴室天花板滴水", "狀態", "待接單", "約定完工日",
    "過了這天還沒完工，管理方會看到逾期。沒填也可以接單。", ">接受工單<", ">不接受<"]) assert.ok(html.includes(text), text);
  assert.match(html, /type="date"[^>]*min="2026-11-18"/);
  assert.doesNotMatch(html, /type="date"[^>]*required/);
  assert.doesNotMatch(html, /管理員已填寫約定完工日|開通與類型|其他|複製唯讀連結|回報施工|<a /);
  assert.equal(solids(outsideSheet(html)), 1);
  assert.match(outsideSheet(html), /class="v-token-secondary v-case-block"[^>]*aria-haspopup="dialog"[^>]*>不接受</);
});

test("RV-JOB-ACCEPT with a dispatch date: prefilled, the approved note shown, and it cannot be cleared", () => {
  const html = view({ presetDate: "2026-11-21" });
  assert.ok(html.includes("管理員已填寫約定完工日，接單時看得到、不會被清掉。"));
  assert.match(html, /type="date" required=""[^>]*value="2026-11-21"/);
});

test("RV-DECLINE: sheet 不接這一件？, optional reason, solid 確定不接 and text 取消", () => {
  const sheet = view().match(/<dialog[\s\S]*<\/dialog>/)?.[0] ?? "";
  for (const text of ["不接這一件？", "原因（選填）", ">確定不接<", ">取消<"]) assert.ok(sheet.includes(text), text);
  assert.equal(solids(sheet), 1);
  assert.match(sheet, /name="reason" maxLength="500"|maxLength="500"[^>]*name="reason"|name="reason"[^>]*maxLength="500"/i);
  assert.doesNotMatch(sheet, /required/);
  assert.match(sheet, /class="v-case-text v-case-block"[^>]*>取消</);
});

test("declined: the approved sentence only; nothing to act on", () => {
  const html = view({ stage: "declined" });
  assert.ok(html.includes("你沒有接這一件，安居物業會另外安排。"));
  assert.equal(solids(html), 0);
  assert.doesNotMatch(html, /<form|<button|href="\/v/);
});

test("RV-JOB-WAIT: lead, 待屋主核准, 其他 with 看估價（第 2 版…） and photos, no solid button", () => {
  const html = view({ stage: "owner_wait", ownerWaitVersion: 2 });
  for (const text of ["在等屋主核准估價，核准後就可以約時間。", "待屋主核准", "其他", "看估價（第 2 版，待屋主核准）", "處理前／後照片"]) assert.ok(html.includes(text), text);
  assert.ok(html.includes(`href="/v/${token}/estimate"`));
  assert.ok(html.includes(`href="/v/${token}/photos"`));
  assert.equal(solids(html), 0);
  assert.doesNotMatch(html, /<form|<dialog|複製唯讀連結|回報施工|接受工單/);
  const noEstimates = view({ stage: "owner_wait", ownerWaitVersion: 2, estimates: false });
  assert.doesNotMatch(noEstimates, /看估價/);
});

test("undrawn stages (GS-01, GS-44): open and closed show the card and photos only; no lead, badge or solid", () => {
  for (const stage of ["open", "closed"] as const) {
    const html = view({ stage });
    assert.doesNotMatch(html, /<h1|v-case-badge|<form|看估價/);
    assert.ok(html.includes("處理前／後照片"));
    assert.equal(solids(html), 0);
  }
  const failed = view({ stage: "unavailable" });
  assert.ok(failed.includes("這裡暫時讀不到，請再試一次。") && failed.includes(">再試一次<"));
});

test("RV-PHOTOS: crumb, segmented 處理前／處理後, this set's tiles, one solid upload for that set", () => {
  const photos = [
    { id: "00000000-0000-4000-8000-0000000000a1", name: "天花板_修好.jpg", phase: "after" as const, viewable: true },
    { id: "00000000-0000-4000-8000-0000000000b1", name: "滴水處.jpg", phase: "before" as const, viewable: true },
  ];
  const messages = { size: "s", type: "t", heic: "h", limit: "l" };
  const after = renderToStaticMarkup(<VendorCasePhotos locale="zh-TW" token={token} heading="信義路 2 樓・浴室天花板滴水" phase="after"
    value={{ ...base, decision: "accepted", photos }} messages={messages} />);
  for (const text of ["處理前／後照片", "信義路 2 樓・浴室天花板滴水 › 照片", ">處理前<", ">處理後<", "天花板_修好.jpg", ">上傳處理後照片<"]) assert.ok(after.includes(text), text);
  assert.doesNotMatch(after, /滴水處\.jpg|去開文件|去處理後|這一案已結案/);
  assert.match(after, /aria-current="page"[^>]*>處理後</);
  assert.ok(after.includes(`src="/api/vendor-jobs/${token}/photos/${photos[0].id}"`));
  assert.equal(solids(after), 1);
  const before = renderToStaticMarkup(<VendorCasePhotos locale="zh-TW" token={token} heading="h" phase="before"
    value={{ ...base, decision: "accepted", photos }} messages={messages} />);
  assert.ok(before.includes("滴水處.jpg") && before.includes(">上傳處理前照片<"));
  assert.doesNotMatch(before, /天花板_修好\.jpg|上傳處理後照片/);
  assert.equal(solids(before), 1);
});

test("RV-PHOTOS-CLOSED: tiles and the GS-51 line, no upload and no button; unshared photos are plain tiles", () => {
  const photos = [
    { id: "00000000-0000-4000-8000-0000000000a1", name: "天花板_修好.jpg", phase: "after" as const, viewable: false },
    { id: "00000000-0000-4000-8000-0000000000a2", name: "防水層.jpg", phase: "after" as const, viewable: true },
  ];
  const html = renderToStaticMarkup(<VendorCasePhotos locale="zh-TW" token={token} heading="h" phase="after"
    value={{ ...base, decision: "accepted", closed: true, photos }} messages={{ size: "", type: "", heic: "", limit: "" }} />);
  for (const text of ["天花板_修好.jpg", "防水層.jpg", "這一案已結案，照片不能再改。要補照片，請安居物業重開這一案。"]) assert.ok(html.includes(text), text);
  assert.equal(solids(html), 0);
  assert.doesNotMatch(html, /type="file"|<button|上傳|› 照片/);
  assert.equal((html.match(/<img /g) ?? []).length, 1, "only the staff-shared photo is fetched after close");
});

test("44px targets and 0 outbound: shell-scoped CSS and no messaging imports in any B-105 file", () => {
  const css = read("public/brand/v3/vendor-case.css");
  for (const rule of [/\.v-case-input \{[^}]*min-height: 44px/, /\.v-case-text \{[^}]*min-height: 44px/, /\.v-case-list a \{[^}]*min-height: 44px/, /\.v-case-seg a \{[^}]*min-height: 44px/]) assert.match(css, rule);
  for (const line of css.split("\n").filter(line => line.includes("{"))) assert.match(line, /^\.v-token-v3 /, line);
  for (const file of ["src/server/b105-vendor-case.ts", "src/app/api/vendor-jobs/case-decision/route.ts", "src/app/api/vendor-jobs/case-photos/confirm/route.ts",
    "src/app/v/[token]/photos/page.tsx", "src/components/v3/vendor/vendor-case.tsx", "src/components/v3/vendor/vendor-case-photos.tsx",
    "src/components/v3/vendor/vendor-case-photo-upload.tsx", "supabase/migrations/20261116160000_b105_vendor_case.sql"]) {
    assert.doesNotMatch(read(file), /line\/(?:push|messaging)|sendSms|sendEmail|resend|twilio|outbox|b039|b028_notification|pushMessage/i, file);
  }
});

// ---- Round 2: admission-gated read errors (Codex 2), strict dates (Codex 3), client controllers (UI 14-17) ----

test("a failed case read shows v3 state only after a positive vendor_job_v3 admission; otherwise legacy", async () => {
  const calls: string[] = [];
  const run = (answers: Record<string, unknown>) => async (sql: string) => {
    const key = sql.includes("_admitted") ? "probe" : "case"; calls.push(key);
    const answer = answers[key]; if (answer instanceof Error) throw answer; return answer;
  };
  assert.equal(await loadVendorCase(token, run({ case: null })), null, "OFF / not admitted");
  assert.deepEqual(calls, ["case"]);
  assert.equal(await loadVendorCase(token, run({ case: new Error("db"), probe: false })), null, "not proven ON -> legacy");
  assert.equal(await loadVendorCase(token, run({ case: new Error("db"), probe: new Error("db") })), null, "probe failed -> legacy");
  assert.equal(await loadVendorCase(token, run({ case: new Error("db"), probe: "true" })), null, "only boolean true admits");
  assert.deepEqual(await loadVendorCase(token, run({ case: new Error("db"), probe: true })), { state: "unavailable" });
  assert.deepEqual(await loadVendorCase(token, run({ case: { malformed: true } })), { state: "unavailable" }, "non-NULL answer is admission");
  assert.equal((await loadVendorCase(token, run({ case: base })))?.state, "ready");
  assert.equal(await loadVendorCase("short", run({ case: base })), null);
});

test("calendar dates are strict: impossible days never reach the date cast", () => {
  for (const ok of ["2026-02-28", "2028-02-29", "2026-12-31", "0001-01-01"]) assert.equal(calendarDate(ok), true, ok);
  for (const bad of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "0000-01-01", "2026-1-01", " 2026-01-01", 20260101]) {
    assert.equal(calendarDate(bad), false, String(bad));
  }
  const requestId = "00000000-0000-4000-8000-000000000003";
  assert.equal(parseDecisionInput({ requestId, decision: "accepted", agreedOn: "2026-02-30" }), null);
  assert.ok(read("src/server/b105-vendor-case.ts").includes('["22007", "22008", "22P02"]'), "a date cast error maps to rejected_invalid");
});

type Call = { url: string; body: unknown };
function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const next = responses.shift(); if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

test("decision controller: double-submit guard, one request id across retries, conflict reloads, invalid keeps state", async () => {
  let reloads = 0; let n = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { calls, fetch } = fakeFetch([new Error("offline"), { status: 503, body: { status: "busy" } }, { status: 200, body: { status: "recorded" } }]);
  const slow = async (url: string, init: RequestInit) => { await gate; return fetch(url, init); };
  const c = createDecisionController({ fetch: slow, reload: () => { reloads++; }, newId: () => `id-${++n}` });
  const first = c.submit(token, "accepted", { agreedOn: "2026-11-21" });
  assert.equal(await c.submit(token, "accepted", { agreedOn: "2026-11-21" }), "busy", "second click while pending");
  release();
  assert.equal(await first, "failed");
  assert.equal(await c.submit(token, "accepted", { agreedOn: "2026-11-21" }), "failed");
  assert.equal(await c.submit(token, "accepted", { agreedOn: "2026-11-21" }), "recorded");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => (call.body as { requestId: string }).requestId), ["id-1", "id-1", "id-1"]);
  assert.equal(reloads, 1);

  const conflict = fakeFetch([{ status: 409, body: { status: "rejected_conflict" } }]);
  const d = createDecisionController({ fetch: conflict.fetch, reload: () => { reloads++; }, newId: () => `id-${++n}` });
  assert.equal(await d.submit(token, "declined", { reason: " 這週排不出時間 " }), "conflict");
  assert.equal(reloads, 2, "another tab decided: reload so the stored decision shows");
  assert.deepEqual(conflict.calls[0].body, { token, requestId: "id-4", decision: "declined", reason: "這週排不出時間" });

  const invalid = fakeFetch([{ status: 400, body: { status: "rejected_invalid" } }]);
  const e = createDecisionController({ fetch: invalid.fetch, reload: () => { reloads++; }, newId: () => `id-${++n}` });
  assert.equal(await e.submit(token, "accepted", { agreedOn: "" }), "invalid");
  assert.equal(reloads, 2, "invalid keeps the page and its inputs");
  assert.deepEqual(invalid.calls[0].body, { token, requestId: "id-5", decision: "accepted", agreedOn: null });
});

test("upload controller: busy during prepare, file kept on retry, retry after upload only repeats confirm", async () => {
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "修好.jpg", { type: "image/jpeg" });
  let reloads = 0;
  let finishPrepare!: () => void;
  const preparing = new Promise<void>(resolve => { finishPrepare = resolve; });
  const { calls, fetch } = fakeFetch([
    { status: 200, body: { ok: true, uploadUrl: "https://storage.test/up", path: "org/o/tickets/t/f.jpg", uploadToken: "grant" } },
    { status: 200, body: {} },
    { status: 400, body: { ok: false, error: "errors.generic" } },
    new Error("offline"),
    { status: 200, body: { ok: true, id: "attachment" } },
  ]);
  let prepared = 0;
  const c = createPhotoUploadController({ fetch, reload: () => { reloads++; }, token, phase: "before",
    prepare: async f => { prepared++; await preparing; return { file: f, mime: "image/jpeg" }; } });
  const first = c.pick(file);
  assert.equal(c.busy, true, "busy while HEIC/size checks run");
  assert.equal(await c.pick(file), "busy", "a second pick during preparation is refused");
  finishPrepare();
  assert.equal(await first, "failed");
  assert.equal(prepared, 1);
  assert.equal(c.kept?.file, file, "the chosen file is kept");
  assert.deepEqual(c.kept?.signed, { path: "org/o/tickets/t/f.jpg", uploadToken: "grant" });
  assert.equal(await c.retry(), "failed");
  assert.equal(await c.retry(), "saved");
  assert.deepEqual(calls.map(call => call.url), ["/api/vendor-jobs/photos/sign", "https://storage.test/up",
    "/api/vendor-jobs/case-photos/confirm", "/api/vendor-jobs/case-photos/confirm", "/api/vendor-jobs/case-photos/confirm"]);
  for (const call of calls.slice(2)) assert.deepEqual(call.body, { token, phase: "before", path: "org/o/tickets/t/f.jpg", fileName: "修好.jpg", mime: "image/jpeg", size: 4, uploadToken: "grant" });
  assert.equal(c.kept, null); assert.equal(reloads, 1);

  const refused = createPhotoUploadController({ fetch: fakeFetch([]).fetch, reload: () => { reloads++; }, token, phase: "after", prepare: async () => "too big" });
  assert.deepEqual(await refused.pick(file), { invalid: "too big" });
  assert.equal(refused.kept, null);
});
