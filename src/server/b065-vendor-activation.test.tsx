import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IssuerTypeForm, IssuerTypeRow, StampNotYet, createIssuerSaver } from "../components/v3/vendor/vendor-activation";
import { vendorActivationCopy } from "../i18n/lanes/brand-v3-vendor-activation";
import { VENDOR_ACCOUNT_PAGES } from "../lib/vendor-workbench-paths";
import { ISSUER_TYPES, isIssuerType, parseIssuerInput } from "./b065-vendor-activation";

const read = (path: string) => readFileSync(path, "utf8");

test("approved words are verbatim (issuer-types.md, ven-account, 開立類型, ven-stamp (a), GS-02)", () => {
  const zh = vendorActivationCopy("zh-TW");
  const flat: Record<string, string> = {
    fixed: "固定資料", row: "開立類型", rowNote: "更改類型不會改已開出的舊 PDF。", manageStamp: "管理印章", title: "開立類型",
    crumb: "我的帳號 › 開立類型", question: "你要開哪一種文件？", selfDeclared: "類型由你自己聲明，管理公司不會代你勾選。我們不收身分證。",
    save: "儲存", cancel: "取消", saveError: "沒有存成功，請再試一次。", retry: "再試一次",
    stampTitle: "印章", stampCard: "收據印章", noStamp: "還沒有印章，開第一張收據前會先請你預覽並同意。",
  };
  for (const [key, value] of Object.entries(flat)) assert.equal((zh as unknown as Record<string, unknown>)[key], value, key);
  assert.deepEqual(zh.types, {
    individual: { title: "個人（非營業人）師傅", desc: "你還沒辦稅籍、不是營業人，系統幫你開簽收單或完工明細，上面會標示「本文件非稅務憑證」。" },
    exempt_business: { title: "免用統一發票之營業人", desc: "你已辦稅籍、依規定免開統一發票，系統可以幫你開普通收據，也可以讓你上傳自己開的紙本收據。" },
    invoice_business: { title: "使用統一發票之營業人", desc: "你依法要自己開統一發票，系統不幫你開，只接受你上傳；需要時可另存完工明細給你對帳。" },
  });
  const en = vendorActivationCopy("en");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.deepEqual(Object.keys(en.types).sort(), [...ISSUER_TYPES].sort());
});

test("request shape: a uuid request id and one of the three types, no other keys", () => {
  const ok = { requestId: "00000000-0000-4000-8000-000000000001", issuerType: "exempt_business" };
  assert.deepEqual(parseIssuerInput(ok), ok);
  for (const type of ISSUER_TYPES) assert.ok(isIssuerType(type));
  for (const bad of [null, [], "x", {}, { ...ok, requestId: "x" }, { ...ok, requestId: 1 }, { ...ok, issuerType: "business" }, { ...ok, issuerType: "" },
    { ...ok, issuerType: null }, { ...ok, issuerType: "EXEMPT_BUSINESS" }, { ...ok, taxId: "04595257" }, { requestId: ok.requestId }]) {
    assert.equal(parseIssuerInput(bad), null, JSON.stringify(bad));
  }
});

test("saver: double-submit guard; the same choice keeps its request id, a new choice or a conflict gets a new one; done only on success", async () => {
  let n = 0, done = 0;
  const bodies: Array<{ requestId: string; issuerType: string }> = [];
  const responses: Array<Error | { status: number; body: unknown }> = [new Error("offline"), new Error("offline"),
    { status: 409, body: { status: "rejected_conflict" } }, { status: 500, body: null }, { status: 200, body: { status: "unchanged" } },
    { status: 200, body: { status: "recorded" } }];
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const fetch = async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/vendor-account/issuer-type"); assert.equal(init.method, "POST");
    await gate; bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift()!; if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  const saver = createIssuerSaver({ fetch, done: () => { done++; }, newId: () => `id-${++n}` });
  const first = saver.save("individual");
  assert.equal(saver.busy, true);
  assert.equal(await saver.save("individual"), "busy", "a second press while pending is ignored");
  release();
  assert.equal(await first, "failed");
  assert.equal(await saver.save("exempt_business"), "failed", "another choice");
  assert.equal(await saver.save("exempt_business"), "failed", "conflict");
  assert.equal(await saver.save("exempt_business"), "failed", "server error");
  assert.equal(await saver.save("exempt_business"), "saved", "unchanged is success");
  assert.equal(done, 1);
  assert.equal(await saver.save("invoice_business"), "saved");
  assert.equal(done, 2);
  assert.deepEqual(bodies.map(b => [b.requestId, b.issuerType]), [["id-1", "individual"], ["id-2", "exempt_business"], ["id-2", "exempt_business"],
    ["id-3", "exempt_business"], ["id-3", "exempt_business"], ["id-4", "invoice_business"]]);
});

test("account row: value + chevron to the type page, the PDF note, 管理印章 only for type 2", () => {
  const none = renderToStaticMarkup(<IssuerTypeRow locale="zh-TW" issuerType={null} />);
  assert.match(none, new RegExp(`href="${VENDOR_ACCOUNT_PAGES.issuerType}"`));
  assert.ok(none.includes(">開立類型<") && none.includes("更改類型不會改已開出的舊 PDF。"));
  assert.doesNotMatch(none, /<small>|管理印章/);
  for (const type of ISSUER_TYPES) {
    const html = renderToStaticMarkup(<IssuerTypeRow locale="zh-TW" issuerType={type} />);
    assert.ok(html.includes(`<small>${vendorActivationCopy("zh-TW").types[type].title}</small>`), type);
    assert.equal(html.includes(`href="${VENDOR_ACCOUNT_PAGES.stamp}"`), type === "exempt_business", type);
    assert.equal(html.includes(">管理印章<"), type === "exempt_business", type);
  }
});

test("type page: three cards, the current one checked, one solid 儲存, 取消 is text; no ID, tax id or name fields", () => {
  const html = renderToStaticMarkup(<IssuerTypeForm locale="zh-TW" current="invoice_business" />);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  assert.match(html, /checked="" value="invoice_business"/);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  for (const text of [">你要開哪一種文件？<", "類型由你自己聲明，管理公司不會代你勾選。我們不收身分證。", "更改類型不會改已開出的舊 PDF。", ">儲存<", ">取消<",
    ...ISSUER_TYPES.flatMap(type => [vendorActivationCopy("zh-TW").types[type].title, vendorActivationCopy("zh-TW").types[type].desc])]) {
    assert.ok(html.includes(text), text);
  }
  assert.equal((html.match(/class="v-act-primary"/g) ?? []).length, 1);
  assert.match(html, /<a class="v-act-text" href="\/vendor-account\/account">取消<\/a>/);
  assert.doesNotMatch(html, /type="text"|身分證字號|稅號|統一編號|沒有存成功/);
  const empty = renderToStaticMarkup(<IssuerTypeForm locale="zh-TW" current={null} />);
  assert.doesNotMatch(empty, /checked/);
  assert.match(empty, /<button type="button" class="v-act-primary" disabled=""/, "nothing chosen: 儲存 is disabled");
  const source = read("src/components/v3/vendor/vendor-activation.tsx");
  assert.match(source, /disabled=\{!choice \|\| state === "pending"\} aria-busy=\{state === "pending"\}/);
  assert.match(source, /if \(!choice \|\| state === "pending"\) return;/);
});

test("stamp page (a): the 'not yet' card only; 產生印章 and the preview/consent are not part of this slice", () => {
  const html = renderToStaticMarkup(<StampNotYet locale="zh-TW" />);
  assert.ok(html.includes(">收據印章<") && html.includes("還沒有印章，開第一張收據前會先請你預覽並同意。"));
  assert.doesNotMatch(html, /<button|產生印章|同意並使用|v-act-primary/);
});

test("styles are scoped and keep 44px targets; no outbound or token admission in B-065 files", () => {
  const css = read("public/brand/v3/vendor-activation.css");
  for (const rule of [/\.v-act-row \.v-act-link \{[^}]*min-height: 44px/, /\.v-act-card \.v-act-option \{[^}]*min-height: 44px/,
    /\.v-act-card \.v-act-primary \{[^}]*min-height: 44px/, /\.v-act-card \.v-act-text \{[^}]*min-height: 44px/, /\.v-act-secondary[^{]*\{[^}]*min-height: 44px/]) {
    assert.match(css, rule);
  }
  for (const line of css.split("\n").filter(line => line.includes("{"))) assert.match(line, /^\.v-act-/, line);
  for (const file of ["src/server/b065-vendor-activation.ts", "src/app/api/vendor-account/issuer-type/route.ts", "src/components/v3/vendor/vendor-activation.tsx",
    "src/app/vendor-account/account/issuer-type/page.tsx", "src/app/vendor-account/account/stamp/page.tsx", "supabase/migrations/20261116220000_b065_vendor_activation.sql"]) {
    assert.doesNotMatch(read(file), /line\/(?:push|messaging)|sendSms|sendEmail|twilio|outbox|pushMessage|vendorTokenAcceptable|open_vendor_job|net\.http/, file);
  }
  assert.doesNotMatch(read("supabase/migrations/20261116220000_b065_vendor_activation.sql").replace(/--[^\n]*/g, ""), /vendor_profiles|tax_id|b025_/,
    "phase A leaves vendor_profiles and B-025 untouched");
  assert.doesNotMatch(read("src/app/api/vendor-account/issuer-type/route.ts"), /request\.(?:text|json)\(\)/);
});
