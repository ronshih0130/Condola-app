import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeT } from "@/i18n";
import { pdfContainsAscii } from "@/lib/pdf-text";
import { PdfFontError, renderPdf } from "@/lib/pdf-render";
import { buildLeasePdf, buildStatementPdf, type LeasePdfSource, type StatementPdfSource } from "@/server/pdf-docs";

const HASH = "cd".repeat(32);

test("the client PDF embeds the hash and Traditional Chinese without a server render", async () => {
  const font = readFileSync(new URL("../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url));
  const source: LeasePdfSource = {
    id: "10000000-0000-4000-8000-000000000099",
    orgId: "10000000-0000-4000-8000-000000000001",
    documentSha256: HASH,
    currency: "TWD",
    rentMinor: 1_200_000,
    depositMinor: 2_400_000,
    depositMonths: "2",
    depositOverrideReason: null,
    dueDay: 5,
    rentFrequency: "monthly",
    startDate: "2026-03-01",
    endDate: "2027-02-28",
    place: "信義松仁 3F A",
    tenant: "張雅文",
    ownerName: "陳建宏",
    address: { city: "台北市", district: "信義區", street: "松仁路88號" },
    addressDisplay: "台北市信義區松仁路88號",
    floor: "3",
    roomLabel: "A",
    scope: "partial",
    electricityMethod: null,
    ratePerKwh: null,
    bankName: null,
  };
  const doc = buildLeasePdf(source, makeT("zh-TW"));
  const bytes = await renderPdf(doc, font);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  assert.equal(pdfContainsAscii(bytes, HASH), true);
  const decoded = (await import("@/lib/pdf-text")).pdfDecoded(bytes).toString("latin1");
  assert.match(decoded, /5C4B/);
  assert.match(decoded, /4E3B/);
  assert.match(decoded, /338F/);
  // □/■ are rectangles (move + line), not missing-glyph question marks.
  assert.ok((decoded.match(/ m\n/g) ?? []).length > 100);
});

test("a statement PDF paints Traditional Chinese instead of blank glyphs", async () => {
  const font = readFileSync(new URL("../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url));
  const source: StatementPdfSource = {
    id: "10000000-0000-4000-8000-000000000088",
    orgId: "10000000-0000-4000-8000-000000000001",
    ownerName: "陳建宏",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    currency: "TWD",
    opening: 0,
    rent: 0,
    other: 0,
    fee: 0,
    expenses: 277700,
    payouts: 0,
    closing: -277700,
    lines: [{ lineType: "expense", description: "冷氣維修", amount: 277700 }],
    addresses: ["台北市信義區松仁路88號"],
    audience: "owner",
  };
  const bytes = await renderPdf(buildStatementPdf(source, "zh-TW", "gregorian", makeT("zh-TW")), font);
  const dir = mkdtempSync(join(tmpdir(), "stmt-pdf-"));
  const pdf = join(dir, "stmt.pdf");
  writeFileSync(pdf, bytes);
  execFileSync("pdftoppm", ["-r", "72", "-f", "1", "-l", "1", pdf, join(dir, "page")]);
  const dark = darkPixels(readFileSync(join(dir, "page-1.ppm")), 40, 130, 40, 420);
  // A fontkit subset of this face leaves the title band nearly blank (~260 px).
  assert.ok(dark > 800, `title band has ${dark} dark pixels`);
});

function darkPixels(ppm: Buffer, y0: number, y1: number, x0: number, x1: number) {
  assert.equal(ppm.subarray(0, 3).toString("ascii"), "P6\n");
  let offset = 3;
  const token = () => {
    const start = offset;
    while (ppm[offset] !== 0x20 && ppm[offset] !== 0x0a && ppm[offset] !== 0x0d) offset += 1;
    const value = ppm.subarray(start, offset).toString("ascii");
    while (ppm[offset] === 0x20 || ppm[offset] === 0x0a || ppm[offset] === 0x0d) offset += 1;
    return value;
  };
  const width = Number(token());
  const height = Number(token());
  assert.equal(Number(token()), 255);
  const pixels = ppm.subarray(offset);
  let dark = 0;
  const yStop = Math.min(height, y1);
  const xStop = Math.min(width, x1);
  for (let y = y0; y < yStop; y += 1) {
    for (let x = x0; x < xStop; x += 1) {
      const i = (y * width + x) * 3;
      if (pixels[i]! < 180 && pixels[i + 1]! < 180 && pixels[i + 2]! < 180) dark += 1;
    }
  }
  return dark;
}

test("a negative refund line in the owner-statement PDF renders as -NT$", async () => {
  const font = readFileSync(new URL("../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url));
  const refund = -123_400;
  const source: StatementPdfSource = {
    id: "10000000-0000-4000-8000-000000000077",
    orgId: "10000000-0000-4000-8000-000000000001",
    ownerName: "陳建宏",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    currency: "TWD",
    opening: 0,
    rent: 200_000,
    other: 0,
    fee: 0,
    expenses: 0,
    payouts: 0,
    closing: 200_000,
    lines: [{ lineType: "adjustment", description: "退租退款", amount: refund }],
    addresses: [],
    audience: "owner",
  };
  const doc = buildStatementPdf(source, "zh-TW", "gregorian", makeT("zh-TW"));
  const linesBlock = doc.blocks.find((block) => block.kind === "rows" && block.heading !== "");
  if (!linesBlock || linesBlock.kind !== "rows") throw new Error("missing refund line");
  assert.equal(linesBlock.rows[0]?.value, "-NT$1,234");
  const bytes = await renderPdf(doc, font);
  const dir = mkdtempSync(join(tmpdir(), "stmt-refund-"));
  const pdf = join(dir, "stmt.pdf");
  writeFileSync(pdf, bytes);
  const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
  assert.match(text, /-NT\$1,234/);
  assert.equal(text.split("-NT$1,234").join("").includes("NT$1,234"), false);
});

test("a glyph missing from the font rejects the PDF", async () => {
  const font = readFileSync(new URL("../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url));
  const doc = buildLeasePdf(
    {
      id: "10000000-0000-4000-8000-000000000099",
      orgId: "10000000-0000-4000-8000-000000000001",
      documentSha256: HASH,
      currency: "TWD",
      rentMinor: 0,
      depositMinor: 0,
      depositMonths: null,
      depositOverrideReason: null,
      dueDay: 1,
      rentFrequency: "monthly",
      startDate: "2026-03-01",
      endDate: null,
      place: "信義松仁",
      tenant: "",
      ownerName: null,
      address: null,
      addressDisplay: "",
      floor: null,
      roomLabel: null,
      scope: "whole",
      electricityMethod: null,
      ratePerKwh: null,
      bankName: null,
    },
    makeT("zh-TW"),
  );
  await assert.rejects(renderPdf({ ...doc, subtitle: "😀" }, font), (err: unknown) => {
    assert.ok(err instanceof PdfFontError);
    assert.equal(err.name, "PdfFontError");
    assert.equal(err.missing.includes("😀"), true);
    return true;
  });
});
