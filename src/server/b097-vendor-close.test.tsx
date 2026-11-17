import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CallTenant, VendorDoneForm, createCompleteSaver } from "../components/v3/vendor/vendor-done";
import { VendorCaseView } from "../components/v3/vendor/vendor-case";
import { vendorCloseCopy } from "../i18n/lanes/brand-v3-vendor-close";
import { parseCompleteInput, parseReopenInput, parseVendorDone } from "./b097-vendor-close";
import { vendorCaseReportReady, type VendorCase } from "./b105-vendor-case";

const read = (path: string) => readFileSync(path, "utf8");
const UUID = "00000000-0000-4000-8000-000000000001";
const TOKEN = "a".repeat(43);
const messages = { size: "s", type: "t", heic: "h", limit: "l" };

test("approved words are verbatim (RV-DONE 「回報完工・附照片就結案」, RV-TIME 「打電話給租客」, RV-JOB 回報完工)", () => {
  const zh = vendorCloseCopy("zh-TW");
  assert.deepEqual({ ...zh }, {
    report: "回報完工", doneTitle: "回報完工", afterPhotos: "處理後照片", atLeastOne: "至少一張", note: "說明（選填）",
    closeLine: "送出就結案，租客會看到「已完成」。{company} 7 天內可以重開。", submit: "送出完工", cancel: "取消",
    timeTitle: "約時間", callTenant: "打電話給租客",
  });
  assert.deepEqual(Object.keys(vendorCloseCopy("en")).sort(), Object.keys(zh).sort());
});

test("request shapes: complete takes a uuid and an optional note (≤500, newlines only); reopen needs a reason", () => {
  assert.deepEqual(parseCompleteInput({ token: TOKEN, requestId: UUID }), { requestId: UUID, note: null });
  assert.deepEqual(parseCompleteInput({ requestId: UUID, note: "  a\r\nb  " }), { requestId: UUID, note: "a\nb" });
  assert.deepEqual(parseCompleteInput({ requestId: UUID, note: "   " }), { requestId: UUID, note: null });
  for (const bad of [null, [], {}, { requestId: "x" }, { requestId: UUID, note: 5 }, { requestId: UUID, note: "x".repeat(501) },
    { requestId: UUID, note: "a\u0007" }, { requestId: UUID, note: "a b" }, { requestId: UUID, note: "a\tb" }, { requestId: UUID, extra: 1 }]) {
    assert.equal(parseCompleteInput(bad), null, JSON.stringify(bad));
  }
  const ok = { ticketId: UUID, requestId: UUID, reason: " 還在滴水 " };
  assert.deepEqual(parseReopenInput(ok), { ...ok, reason: "還在滴水" });
  for (const bad of [{ ...ok, reason: "" }, { ...ok, reason: "  " }, { ...ok, reason: "x".repeat(501) }, { ...ok, ticketId: "x" },
    { ...ok, requestId: 1 }, { ...ok, reason: null }, { ...ok, extra: true }, { ...ok, reason: "\u0085" }]) {
    assert.equal(parseReopenInput(bad), null, JSON.stringify(bad));
  }
});

test("strict view decode: anything unexpected is a read failure", () => {
  const ok = { company: "安居物業", closed: false, accepted: true, afterPhotos: [{ id: UUID, name: "a.jpg" }], closedAt: null, reopenUntil: null, closedByThisJob: false };
  assert.deepEqual(parseVendorDone(ok), ok);
  assert.equal(parseVendorDone({ ...ok, closedAt: "2026-11-16T10:00:00.123+00:00" }).closedAt, "2026-11-16T10:00:00.123+00:00");
  for (const bad of [null, [], { ...ok, closed: "no" }, { ...ok, afterPhotos: [{ id: "x", name: "a" }] }, { ...ok, closedAt: "yesterday" }, { ...ok, company: 1 }]) {
    assert.throws(() => parseVendorDone(bad), JSON.stringify(bad));
  }
});

test("saver: double-submit guard; same note keeps its request id, an edited note or a conflict gets a new one; closed counts as done", async () => {
  let n = 0, done = 0;
  const bodies: Array<{ requestId: string; note: string | null; token: string }> = [];
  const responses: Array<Error | { status: number; body: unknown }> = [new Error("offline"), { status: 422, body: { status: "rejected_no_photo" } },
    { status: 409, body: { status: "rejected_conflict" } }, { status: 503, body: { status: "busy" } }, { status: 200, body: { status: "recorded" } },
    { status: 409, body: { status: "rejected_closed" } }];
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const saver = createCompleteSaver({ fetch: async (url, init) => {
    assert.equal(url, "/api/vendor-jobs/case-complete");
    await gate; bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift()!; if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }, done: () => { done++; }, newId: () => `id-${++n}` });
  const first = saver.submit(TOKEN, " 好了 ");
  assert.equal(await saver.submit(TOKEN, "好了"), "busy");
  release();
  assert.equal(await first, "failed");
  assert.equal(await saver.submit(TOKEN, "好了"), "no_photo");
  assert.equal(await saver.submit(TOKEN, "改了"), "failed", "conflict");
  assert.equal(await saver.submit(TOKEN, "改了"), "failed", "busy server");
  assert.equal(await saver.submit(TOKEN, "改了"), "saved");
  assert.equal(await saver.submit(TOKEN, "改了"), "closed");
  assert.equal(done, 2);
  assert.deepEqual(bodies.map(b => [b.requestId, b.note]), [["id-1", "好了"], ["id-1", "好了"], ["id-2", "改了"], ["id-3", "改了"], ["id-3", "改了"], ["id-3", "改了"]]);
  assert.ok(bodies.every(b => b.token === TOKEN));
});

test("RV-DONE: 處理後照片 with 至少一張, outline upload, 說明（選填）, the close sentence, one solid 送出完工 (disabled with no photo), text 取消", () => {
  const empty = renderToStaticMarkup(<VendorDoneForm locale="zh-TW" token={TOKEN} company="安居物業" photos={[]} messages={messages} />);
  for (const text of [">回報完工<", "處理後照片", ">至少一張<", ">說明（選填）<", "送出就結案，租客會看到「已完成」。安居物業 7 天內可以重開。", ">送出完工<", ">取消<", "上傳處理後照片"]) {
    assert.ok(empty.includes(text), text);
  }
  assert.equal((empty.match(/class="v-token-primary/g) ?? []).length, 1);
  assert.match(empty, /<label class="v-token-secondary v-case-block"[^>]*>上傳處理後照片<\/label>/);
  assert.match(empty, /<button type="submit" class="v-token-primary v-case-block" disabled=""/);
  assert.match(empty, new RegExp(`<a class="v-case-text v-case-block v-done-cancel" href="/v/${TOKEN}">取消</a>`));
  assert.match(empty, /<textarea[^>]*maxLength="500"/);
  assert.doesNotMatch(empty, /role="alert"|已回報，待公司核對|✓|v-case-tick/, "no error before a send; no 待公司核對; no completion tick (VEN-29-AC3)");
  const html = renderToStaticMarkup(<VendorDoneForm locale="zh-TW" token={TOKEN} company="安居物業" photos={[{ id: UUID, name: "天花板_修好.jpg" }]} messages={messages} />);
  assert.ok(html.includes("天花板_修好.jpg") && html.includes(`/api/vendor-jobs/${TOKEN}/photos/${UUID}`));
  assert.doesNotMatch(html, /<button type="submit" class="v-token-primary v-case-block" disabled=""/);
  const source = read("src/components/v3/vendor/vendor-done.tsx");
  assert.match(source, /if \(!ready \|\| state === "pending"\) return;/);
  assert.match(source, /state === "failed" \? <div className="v-case-error" role="alert">/, "GS-02: the failure keeps photos and note, with 再試一次");
});

test("RV-JOB: 回報完工 is the solid primary only on an open accepted case with a 處理前 photo; RV-TIME: 打電話給租客 is a tel: outline", () => {
  const base: VendorCase = { company: "x", closed: false, decision: "accepted", agreedCompletionOn: null, scheduledOn: null, ownerWaitVersion: null, estimates: false, photos: [] };
  const before = { id: UUID, name: "a", phase: "before" as const, viewable: true }, after = { ...before, phase: "after" as const };
  assert.equal(vendorCaseReportReady(base), false);
  assert.equal(vendorCaseReportReady({ ...base, photos: [after] }), false, "an after photo alone is not the 拍處理前照片 step");
  assert.equal(vendorCaseReportReady({ ...base, photos: [before] }), true);
  for (const off of [{ closed: true }, { decision: null }, { decision: "declined" as const }, { ownerWaitVersion: 2 }]) {
    assert.equal(vendorCaseReportReady({ ...base, ...off, photos: [before] }), false, JSON.stringify(off));
  }
  const props = { locale: "zh-TW" as const, token: TOKEN, heading: "h", company: "x", stage: "open" as const, presetDate: null, scheduledOn: null, ownerWaitVersion: null, estimates: false };
  assert.doesNotMatch(renderToStaticMarkup(<VendorCaseView {...props} />), /回報完工/);
  assert.match(renderToStaticMarkup(<VendorCaseView {...props} report />), new RegExp(`<a class="v-token-primary v-case-block" href="/v/${TOKEN}/done" data-testid="vendor-case-report">回報完工</a>`));
  assert.doesNotMatch(renderToStaticMarkup(<VendorCaseView {...props} stage="closed" report />), /回報完工/);
  assert.equal(renderToStaticMarkup(<CallTenant locale="zh-TW" phone="+886912345678" />),
    '<a class="v-token-secondary v-case-block" href="tel:+886912345678" data-testid="vendor-call-tenant">打電話給租客</a>');
});

test("styles scoped with 44px targets; no outbound and no LINE in B-097/B-098 files", () => {
  const css = read("public/brand/v3/vendor-close.css");
  for (const line of css.split("\n").filter(line => line.includes("{"))) assert.match(line, /^\.v-token-v3 \.v-done /, line);
  assert.match(css, /\.v-done-cancel \{[^}]*min-height: 44px/);
  assert.doesNotMatch(css, /var\(--fs-/);
  for (const file of ["src/server/b097-vendor-close.ts", "src/server/b098-vendor-phone.ts", "src/app/api/vendor-jobs/case-complete/route.ts",
    "src/app/api/repairs/reopen/route.ts", "src/components/v3/vendor/vendor-done.tsx", "src/app/v/[token]/done/page.tsx", "src/app/v/[token]/time/page.tsx",
    "supabase/migrations/20261116250000_b097_vendor_close.sql"]) {
    assert.doesNotMatch(read(file), /line\/(?:push|messaging)|pushMessage|sendSms|sendEmail|twilio|outbox|notification_events|net\.http|fetch\("https?:/, file);
  }
  const sql = read("supabase/migrations/20261116250000_b097_vendor_close.sql");
  assert.match(sql, /a\.phase='after' AND NOT a\.is_internal/, "LPQ-25 item 3: explicit 處理後 only");
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /phase IS NULL/, "a NULL-phase upload never counts");
  assert.match(sql, /interval '168 hours'/);
  assert.doesNotMatch(read("src/app/api/vendor-jobs/case-complete/route.ts"), /request\.(?:text|json)\(\)/);
});
