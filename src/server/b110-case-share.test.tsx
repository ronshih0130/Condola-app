import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createShareClient, placeOnClipboard } from "../components/v3/vendor/case-share-entry";
import { SharePage } from "../components/v3/share/share-page";
import { caseShareCopy } from "../i18n/lanes/brand-v3-case-share";
import { parseShareView } from "./b110-case-share";
import { readSmallBody } from "./b110-body";

const read = (path: string) => readFileSync(path, "utf8");
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

test("approved and P52 words are verbatim (ven-copy-link, share-expired, share-revoked, share page)", () => {
  const zh = caseShareCopy("zh-TW");
  const expected: Record<string, string> = {
    entry: "複製唯讀連結", title: "這一案的唯讀連結", noSend: "系統不會代你寄出連結。請複製後，自己傳給需要的人。", link: "連結",
    scope: "對方只會看到已准許的照片，以及已開立或已作廢的文件。內部備註不會出現。", copy: "複製連結", close: "關閉", copied: "已複製連結",
    sharedBy: "{company}分享的唯讀頁", status: "狀態", done: "已完成", vendor: "廠商", photos: "已准許的照片", noPhotos: "這一案沒有分享照片。", documents: "文件",
    markReceipt: "收據", markStatement: "完工明細（非稅務憑證）", markVoid: "已作廢",
    expiredTitle: "這個分享已過期", expiredBody: "這個連結已過期，文件內容不會再顯示。需要的話請聯絡{company}。",
    revokedTitle: "這個分享已撤銷", revokedBody: "管理方已停止這個連結，文件內容不會再顯示。",
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(zh[key as keyof typeof zh], value, key);
  assert.deepEqual(Object.keys(caseShareCopy("en")).sort(), Object.keys(zh).sort());
});

test("share view decode is all or nothing: any malformed item rejects the view", () => {
  const ok = { state: "ok", company: "安居物業", title: "浴室天花板滴水", status: "closed", vendor: "王師傅水電", currency: "TWD",
    photos: [{ id: id(1), name: "a.jpg" }, { id: "x", name: "bad.jpg" }],
    documents: [{ id: id(2), kind: "completion_statement", docNo: "CMP-1", status: "voided", totalMinor: "5200" }, { id: id(3), kind: "invoice", docNo: "X", status: "issued", totalMinor: "1" }] };
  assert.equal(parseShareView(ok), null, "one malformed photo rejects the whole view");
  assert.equal(parseShareView({ ...ok, photos: [ok.photos[0]] }), null, "one malformed document rejects the whole view");
  const parsed = parseShareView({ ...ok, photos: [ok.photos[0]], documents: [ok.documents[0]] });
  assert.equal(parsed?.state, "ok");
  if (parsed?.state !== "ok") return;
  assert.deepEqual(parsed.photos, [{ id: id(1), name: "a.jpg" }]);
  assert.deepEqual(parsed.documents.map(d => d.id), [id(2)]);
  assert.deepEqual(parseShareView({ state: "expired", company: "安居物業", title: "leak" }), { state: "expired", company: "安居物業" });
  for (const bad of [null, [], { state: "ok" }, { state: "weird", company: "x" }, { state: "ok", company: "x", title: 1, status: "closed", photos: [], documents: [] }]) {
    assert.equal(parseShareView(bad), null, JSON.stringify(bad));
  }
});

test("share page: nature marks and totals, voided last and struck with a hidden 已作廢, no PDF links, no buttons; gone states show only the text", () => {
  const html = renderToStaticMarkup(<SharePage locale="zh-TW" token={"t".repeat(43)} view={{ state: "ok", company: "安居物業", title: "浴室天花板滴水",
    status: "closed", vendor: "王師傅水電", currency: "TWD", photos: [{ id: id(1), name: "天花板_修好.jpg" }],
    documents: [{ id: id(2), kind: "receipt", docNo: "RCP-2026-019", status: "issued", totalMinor: "5200" },
      { id: id(3), kind: "receipt", docNo: "RCP-2026-018", status: "voided", totalMinor: "5200" }] }} />);
  for (const text of ["租多啦", "安居物業分享的唯讀頁", "<h1>浴室天花板滴水</h1>", ">狀態<", ">已完成<", ">廠商<", "王師傅水電", "已准許的照片", "天花板_修好.jpg",
    ">文件<", "收據 RCP-2026-019", "<b>NT$5,200</b>", "<s><span class=\"v-share-sr\">已作廢 </span>NT$5,200</s>"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /\/documents\/|\.pdf/, "no public PDF links");
  assert.ok(html.indexOf("RCP-2026-019") < html.indexOf("RCP-2026-018"));
  assert.doesNotMatch(html, /<button|<form|login/);
  for (const [state, title, body] of [["expired", "這個分享已過期", "這個連結已過期，文件內容不會再顯示。需要的話請聯絡安居物業。"], ["revoked", "這個分享已撤銷", "管理方已停止這個連結，文件內容不會再顯示。"]] as const) {
    const gone = renderToStaticMarkup(<SharePage locale="zh-TW" token={"t".repeat(43)} view={{ state, company: "安居物業" }} />);
    for (const text of [title, body, 'data-v3-illustration="26"', "安居物業分享的唯讀頁"]) assert.ok(gone.includes(text), `${state}: ${text}`);
    assert.doesNotMatch(gone, /<button|<a |<ul|<img/, state);
  }
});

test("share client: eligibility read, open and copy, a second press while pending is ignored", async () => {
  const calls: string[] = []; let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const fetch = async (_url: string, init: RequestInit) => {
    const mode = JSON.parse(String(init.body)).mode as string; calls.push(mode);
    if (mode === "copy") await gate;
    return new Response(JSON.stringify(mode === "check" ? { eligible: true } : { url: "http://x/s/abc", expiresAt: "z" }), { status: 200 });
  };
  const client = createShareClient({ fetch, token: "t" });
  assert.equal(await client.eligible(), true);
  assert.deepEqual(await client.link("open"), { ok: true, url: "http://x/s/abc" });
  const pending = client.link("copy");
  assert.equal(await client.link("copy"), "busy");
  release();
  assert.deepEqual(await pending, { ok: true, url: "http://x/s/abc" });
  assert.deepEqual(calls, ["check", "open", "copy"]);
  const failing = createShareClient({ fetch: async () => { throw new Error("offline"); }, token: "t" });
  assert.equal(await failing.eligible(), false, "an error never shows the entry");
  assert.deepEqual(await failing.link("open"), { ok: false });
});

test("capped body, 0 outbound and scoped styles", async () => {
  const make = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("http://x/", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  assert.equal(await readSmallBody(make("{}"), 8), "{}");
  assert.equal(await readSmallBody(make("x".repeat(9)), 8), null);
  assert.equal(await readSmallBody(make("{}", { "content-length": "9" }), 8), null);
  for (const file of ["src/server/b110-case-share.ts", "src/app/api/vendor-jobs/case-share/route.ts", "src/app/s/[token]/page.tsx", "src/app/s/[token]/photos/[id]/route.ts",
"src/components/v3/vendor/case-share-entry.tsx", "src/components/v3/share/share-page.tsx", "supabase/migrations/20261116210000_b110_case_share.sql"]) {
    assert.doesNotMatch(read(file), /line\/(?:push|messaging)|sendSms|sendEmail|twilio|outbox|pushMessage|mailto/, file);
  }
  const css = read("public/brand/v3/case-share.css");
  for (const line of css.split("\n").filter(l => l.includes("{"))) assert.match(line, /^\.v-token-v3\.v-share /, line);
  assert.match(css, /\.v-share-docs \.v-share-doc \{[^}]*min-height: 44px/);
  assert.match(read("public/brand/v3/vendor-case.css"), /\.v-case-share-entry \{[^}]*min-height: 44px/);
  assert.match(read("src/components/v3/vendor/vendor-case.tsx"), /props\.stage === "closed" \? <li><CaseShareEntry/);
});

test("clipboard missing or refused: still a success, no server retry, the 連結 field is focused and selected", async () => {
  let posts = 0;
  const client = createShareClient({ fetch: async () => { posts++; return new Response(JSON.stringify({ url: "http://x/s/abc", expiresAt: "z" })); }, token: "t" });
  const result = await client.link("copy");
  assert.deepEqual(result, { ok: true, url: "http://x/s/abc" });
  const calls: string[] = [];
  const field = { focus: () => calls.push("focus"), select: () => calls.push("select") };
  assert.equal(await placeOnClipboard("http://x/s/abc", { clipboard: undefined, field }), "manual");
  assert.equal(await placeOnClipboard("http://x/s/abc", { clipboard: { writeText: async () => { throw new Error("denied"); } }, field }), "manual");
  assert.deepEqual(calls, ["focus", "select", "focus", "select"]);
  const written: string[] = [];
  assert.equal(await placeOnClipboard("http://x/s/abc", { clipboard: { writeText: async (t: string) => { written.push(t); } }, field }), "copied");
  assert.deepEqual(written, ["http://x/s/abc"]); assert.equal(calls.length, 4, "no focus on success");
  assert.equal(posts, 1, "the server is called once; a failed clipboard never records another copy");
  const source = read("src/components/v3/vendor/case-share-entry.tsx");
  assert.match(source, /setState\(await placeOnClipboard\(/);
  assert.doesNotMatch(source, /setState\("copyError"\); \}\s*\n?\s*\} catch/);
  assert.match(source, /if \(sheet\.current && !sheet\.current\.open\) sheet\.current\.showModal\(\);/, "never showModal() an open dialog");
  assert.match(source, /<p className="v-case-toast" role="status" aria-live="polite">\{state === "copied" \? copy\.copied : ""\}<\/p>/, "one live region, always mounted");
});

test("share page with no approved photos keeps the heading and says so", () => {
  const html = renderToStaticMarkup(<SharePage locale="zh-TW" token={"t".repeat(43)} view={{ state: "ok", company: "安居物業", title: "浴室天花板滴水",
    status: "closed", vendor: "王師傅水電", currency: "TWD", photos: [], documents: [] }} />);
  assert.ok(html.includes(">已准許的照片<") && html.includes(">這一案沒有分享照片。<"));
  assert.doesNotMatch(html, /<img|v-share-tiles/);
});
