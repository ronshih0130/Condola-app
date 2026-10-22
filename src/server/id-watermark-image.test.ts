import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decode } from "jpeg-js";
import { SAMPLE_JPEG_BASE64 } from "../lib/idv";
import { idFixedWatermark } from "../lib/id-watermark";
import { burnFixedIdCopy, burnFixedIdWatermark } from "./id-watermark-image";

test("the burned sentence is only the firm name", () => {
  assert.equal(idFixedWatermark("松信住宅管理"), "僅供松信住宅管理核對租約身分使用");
  assert.equal(idFixedWatermark("松信住宅管理").includes("・"), false);
  assert.throws(() => idFixedWatermark("  "), /empty/);
});

test("workers receive watermark fonts from the entry's Data modules", () => {
  const source = readFileSync(new URL("./id-watermark-image.ts", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../../custom-worker.mjs", import.meta.url), "utf8");
  const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /__CONDOLA_FONTS/);
  assert.match(entry, /DroidSansFallback-subset\.ttf/);
  assert.match(entry, /DejaVuSans\.ttf/);
  assert.match(entry, /globalThis\.__CONDOLA_FONTS/);
  assert.doesNotMatch(entry, /export const DOQueueHandler/);
  assert.match(config, /"type": "Data"/);
  assert.match(config, /\*\*\/\*\.ttf/);
});

test("the second copy is a different jpeg with a red bar", () => {
  const plain = Buffer.from(SAMPLE_JPEG_BASE64, "base64");
  const started = performance.now();
  const burned = burnFixedIdCopy(plain, "松信住宅管理");
  assert.ok(performance.now() - started < 2000, "first burn");
  const again = performance.now();
  burnFixedIdCopy(plain, "松信住宅管理");
  assert.ok(performance.now() - again < 2000, "cached burn");
  assert.equal(burned.equals(plain), false);
  assert.equal(burned[0], 0xff);
  assert.equal(burned[1], 0xd8);
  assert.equal(burned.subarray(burned.length - 2).equals(Buffer.from([0xff, 0xd9])), true);
  assert.equal(burned.includes(Buffer.from("condola-id-wm")), false);
  const raw = decode(burned, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true });
  const index = ((raw.height - 1) * raw.width + Math.floor(raw.width / 2)) * 4;
  const red = raw.data[index] ?? 0;
  const green = raw.data[index + 1] ?? 0;
  const blue = raw.data[index + 2] ?? 0;
  assert.ok(red > 150 && red > green && red > blue);
  assert.throws(
    () => burnFixedIdWatermark(plain, "僅供松信住宅管理核對租約身分使用・黃志明・2026-10-22 14:05"),
    /sentence/,
  );
});
