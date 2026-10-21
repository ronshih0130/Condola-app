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
  const bytes = await renderPdf({ ...doc, subtitle: `${doc.subtitle} 😀` }, font);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  assert.equal(pdfContainsAscii(bytes, HASH), true);
  const decoded = (await import("@/lib/pdf-text")).pdfDecoded(bytes).toString("latin1");
  assert.match(decoded, /5C4B/);
  assert.match(decoded, /4E3B/);
  assert.match(decoded, /338F/);
  // □/■ are rectangles (move + line), not missing-glyph question marks.
  assert.ok((decoded.match(/ m\n/g) ?? []).length > 100);
});
