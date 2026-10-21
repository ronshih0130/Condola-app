import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeT } from "@/i18n";
import { pdfContainsAscii } from "@/lib/pdf-text";
import { renderPdf } from "@/lib/pdf-render";
import { buildLeasePdf, type LeasePdfSource } from "@/server/pdf-docs";

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
    startDate: "2026-03-01",
    endDate: "2027-02-28",
    notes: null,
    templateBody: null,
    place: "信義松仁 3F A",
    firm: "松信住宅管理",
    tenant: "張雅文",
    ownerName: "陳建宏",
  };
  const doc = buildLeasePdf(source, "zh-TW", "gregorian", makeT("zh-TW"));
  const bytes = await renderPdf({ ...doc, subtitle: `${doc.subtitle} 😀` }, font);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  assert.equal(pdfContainsAscii(bytes, HASH), true);
  assert.equal(pdfContainsAscii(bytes, "房東"), false);
  const decoded = (await import("@/lib/pdf-text")).pdfDecoded(bytes).toString("latin1");
  assert.match(decoded, /5C4B/);
  assert.match(decoded, /4E3B/);
});
