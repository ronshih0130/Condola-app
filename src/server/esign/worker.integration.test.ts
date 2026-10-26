import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { unstable_dev } from "wrangler";
import { contractVersionDigest } from "./document";

test("Workers executes e-sign CJK generation, two signatures and hashing within bounds", { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "condola-esign-worker-"));
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
  try {
    worker = await unstable_dev("src/server/esign/worker-fixture.ts", {
      config: "src/server/esign/wrangler.test.jsonc", local: true, compatibilityDate: "2026-10-26",
      compatibilityFlags: ["nodejs_compat"], experimental: { disableExperimentalWarning: true },
      persistTo: join(dir, "state"),
    });
    const response = await worker.fetch("/", {
      method: "POST", body: readFileSync("public/fonts/DroidSansFallback-subset.ttf"),
    });
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length < 16 * 1024 * 1024, "PDF resource bound");
    assert.ok(Number(response.headers.get("X-Elapsed-Ms")) < 10000, "local Worker wall time bound");
    assert.equal(await contractVersionDigest(bytes), response.headers.get("X-Document-SHA256"));
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
    const pdf = join(dir, "signed.pdf");
    writeFileSync(pdf, bytes);
    const text = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
    assert.match(text, /住宅租約/);
    assert.match(text, /屋主/);
    assert.match(text, /租客/);
    assert.match(text, /本版取代 2026-10-26 簽署之前版/);
    // Count dark pixels where only the Chinese text is drawn, on all three
    // actual Worker-generated pages. A missing-glyph/blank render must fail.
    for (let page = 1; page <= 3; page++) {
      const image = execFileSync("pdftoppm", ["-f", String(page), "-singlefile", "-r", "72", pdf], { maxBuffer: 4 * 1024 * 1024 });
      const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(image.subarray(0, 100).toString("ascii"));
      assert.ok(header, "P6 image expected");
      const width = Number(header[1]);
      const start = header[0].length;
      let dark = 0;
      const top = page === 1 ? 40 : 104;
      for (let y = top; y < top + 40; y++) for (let x = 48; x < 200; x++) {
        const offset = start + (y * width + x) * 3;
        if (image[offset] < 128 && image[offset + 1] < 128 && image[offset + 2] < 128) dark++;
      }
      assert.ok(dark > 30, "Chinese glyph region must contain ink on page " + page);
    }
  } finally {
    try {
      await worker?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
