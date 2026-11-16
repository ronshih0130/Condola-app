import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VendorAddressCard, createAddressSaver } from "../components/v3/vendor/vendor-address";
import { vendorAddressCopy } from "../i18n/lanes/brand-v3-vendor-address";
import { TW_CITIES, joinTwAddress, parseTwAddress, validateAddressParts } from "../lib/tw-address";
import { parseSaveInput } from "./b112-vendor-address";

const read = (path: string) => readFileSync(path, "utf8");

test("P52 and approved words are verbatim (ven-addr-confirm, ven-account, R2-ADDR, GS-02)", () => {
  const zh = vendorAddressCopy("zh-TW");
  const expected: Record<string, string> = {
    card: "固定資料", field: "地址", help: "一行輸入，系統解析後再請你確認。", save: "儲存", title: "確認地址",
    lead: "系統這樣拆你的地址，對嗎？不對可以直接改。", city: "縣市", district: "鄉鎮市區", street: "街道", number: "門牌", cancel: "取消",
    unreadable: "系統讀不出這個地址，請分開填。", fix: "還有欄位要修正。", needCity: "請選擇縣市。", needStreet: "街道與門牌請至少填一項。",
    saveError: "沒有存成功，請再試一次。", retry: "再試一次",
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(zh[key as keyof typeof zh], value, key);
  assert.deepEqual(Object.keys(vendorAddressCopy("en")).sort(), Object.keys(zh).sort());
  assert.equal(TW_CITIES.length, 22);
});

test("parser: city, district, street with 段巷弄, number; postal code dropped; 臺 read as 台; anything unsure fails", () => {
  const cases: [string, ReturnType<typeof parseTwAddress>][] = [
    ["台北市信義區信義路二段 1 號", { ok: true, parts: { city: "台北市", district: "信義區", street: "信義路二段", number: "1 號" } }],
    ["110 臺北市信義區信義路二段1號3樓", { ok: true, parts: { city: "台北市", district: "信義區", street: "信義路二段", number: "1號3樓" } }],
    ["新竹縣竹北市光明六路 10 號", { ok: true, parts: { city: "新竹縣", district: "竹北市", street: "光明六路", number: "10 號" } }],
    ["台中市西屯區市政路 386 巷 2 號", { ok: true, parts: { city: "台中市", district: "西屯區", street: "市政路", number: "386 巷 2 號" } }],
    ["高雄市前鎮區中華五路789巷10弄5號", { ok: true, parts: { city: "高雄市", district: "前鎮區", street: "中華五路789巷10弄", number: "5號" } }],
    ["台北市中山北路二段 5 號", { ok: true, parts: { city: "台北市", district: "", street: "中山北路二段", number: "5 號" } }],
    ["桃園市中壢區中大路", { ok: true, parts: { city: "桃園市", district: "中壢區", street: "中大路", number: "" } }],
  ];
  for (const [line, expected] of cases) assert.deepEqual(parseTwAddress(line), expected, line);
  for (const line of ["", "東京都新宿区", "台北市", "台北市信義區", "Somewhere 1", "台北市信義區某某里"]) {
    assert.deepEqual(parseTwAddress(line), { ok: false, parts: { city: "", district: "", street: "", number: "" } }, line);
  }
});

test("R2-ADDR checks and the joined line", () => {
  assert.deepEqual(validateAddressParts({ city: "台北市", district: "", street: "信義路", number: "" }), []);
  assert.deepEqual(validateAddressParts({ city: "", district: "", street: "", number: "" }), ["city", "streetOrNumber"]);
  assert.deepEqual(validateAddressParts({ city: "火星市", district: "", street: "", number: "1 號" }), ["city"]);
  assert.deepEqual(validateAddressParts({ city: "台北市", district: "", street: "x".repeat(600), number: "" }), ["length"]);
  assert.deepEqual(validateAddressParts({ city: "台北市", district: "", street: "a\u0007", number: "" }), ["length"]);
  assert.equal(joinTwAddress({ city: "台北市", district: "信義區", street: "信義路二段", number: "1 號" }), "台北市信義區信義路二段 1 號");
  assert.equal(joinTwAddress({ city: "台北市", district: "", street: "", number: "1 號" }), "台北市1 號");
  assert.equal(joinTwAddress({ city: "台北市", district: " 信義區 ", street: "信義路", number: "" }), "台北市信義區信義路");
});

test("request shape: uuid request id, positive version, valid parts only", () => {
  const ok = { requestId: "00000000-0000-4000-8000-000000000001", expectedVersion: 2, parts: { city: "台北市", district: "信義區", street: "信義路", number: " 1 號 " } };
  assert.deepEqual(parseSaveInput(ok), { ...ok, parts: { ...ok.parts, number: "1 號" } });
  assert.deepEqual(parseSaveInput({ ...ok, parts: { city: "台北市", number: "1 號" } })?.parts, { city: "台北市", district: "", street: "", number: "1 號" });
  for (const bad of [null, [], { ...ok, requestId: "x" }, { ...ok, expectedVersion: 0 }, { ...ok, expectedVersion: 1.5 }, { ...ok, parts: null },
    { ...ok, parts: { ...ok.parts, city: "火星市" } }, { ...ok, parts: { ...ok.parts, street: "", number: "" } }, { ...ok, parts: { ...ok.parts, street: 5 } },
    { ...ok, parts: { ...ok.parts, street: "x".repeat(201) } }]) assert.equal(parseSaveInput(bad), null, JSON.stringify(bad));
});

test("saver: double-submit guard, one request id across retries, new id per sheet, reload on saved or stale", async () => {
  let n = 0, reloads = 0;
  const bodies: Array<{ requestId: string }> = [];
  const responses = [new Error("offline"), { status: 409, body: { status: "rejected_stale" } }, { status: 200, body: { status: "recorded" } }];
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const fetch = async (_url: string, init: RequestInit) => {
    await gate; bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift()!; if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  const saver = createAddressSaver({ fetch, reload: () => { reloads++; }, newId: () => `id-${++n}` });
  const parts = { city: "台北市", district: "", street: "信義路", number: "1 號" };
  const first = saver.save(3, parts);
  assert.equal(await saver.save(3, parts), "busy");
  release();
  assert.equal(await first, "failed");
  assert.equal(reloads, 0);
  assert.equal(await saver.save(3, parts), "conflict"); assert.equal(reloads, 1, "the version moved: reload to show it");
  saver.reset();
  assert.equal(await saver.save(4, parts), "saved"); assert.equal(reloads, 2);
  assert.deepEqual(bodies.map(b => b.requestId), ["id-1", "id-1", "id-2"]);
});

test("card and sheet: one solid per screen, R2-ADDR fields, 取消 is text; styles keep 44px targets", () => {
  const html = renderToStaticMarkup(<VendorAddressCard locale="zh-TW" version={2} address="台北市信義區信義路二段 1 號" />);
  for (const text of [">固定資料<", ">地址<", "台北市信義區信義路二段 1 號", "一行輸入，系統解析後再請你確認。", ">確認地址<",
    "系統這樣拆你的地址，對嗎？不對可以直接改。", ">縣市<", ">鄉鎮市區<", ">街道<", ">門牌<", ">取消<"]) assert.ok(html.includes(text), text);
  const outside = html.replace(/<dialog[\s\S]*<\/dialog>/, ""), sheet = html.match(/<dialog[\s\S]*<\/dialog>/)?.[0] ?? "";
  assert.equal((outside.match(/class="v-addr-primary"/g) ?? []).length, 1);
  assert.equal((sheet.match(/class="v-addr-primary"/g) ?? []).length, 1);
  assert.match(sheet, /class="v-addr-text"[^>]*>取消</);
  assert.equal((sheet.match(/<option value="/g) ?? []).length, 23);
  assert.doesNotMatch(html, /開立類型|稅號|印章|名稱|電話/, "B-065 fields are not part of this slice");
  const css = read("public/brand/v3/vendor-address.css");
  for (const rule of [/\.v-addr-input \{[^}]*min-height: 44px/, /\.v-addr-primary \{[^}]*min-height: 44px/, /\.v-addr-text \{[^}]*min-height: 44px/]) assert.match(css, rule);
  for (const line of css.split("\n").filter(line => line.includes("{"))) assert.match(line, /^\.v-addr-card/, line);
  for (const file of ["src/server/b112-vendor-address.ts", "src/app/api/vendor-account/address/route.ts", "src/components/v3/vendor/vendor-address.tsx"]) {
    assert.doesNotMatch(read(file), /line\/(?:push|messaging)|sendSms|sendEmail|twilio|outbox|pushMessage|vendorTokenAcceptable|open_vendor_job/, file);
  }
});
