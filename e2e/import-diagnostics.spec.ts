import { disposableDbUrl } from "../src/server/test-disposable-db";
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { Client } from "pg";
import { ORG_ID } from "../src/server/ids";
import { parseCsv } from "../src/lib/spreadsheet";
import { resetDemo } from "./session";

const csv = [
  "物件名稱,地址,屋主姓名,出租型態,戶別／樓層,月租,租客姓名,租客電話,起租日,到期日,押金,繳租日",
  "",
  "診斷有效物件,台北市大安區診斷路1號,測試屋主,整層,1F,10000,,,,,,",
  "", "",
  "診斷錯誤物件,台北市大安區診斷路2號,測試屋主,整層,2F,10000,測試租客,0912345678,bad,bad,20000,5",
].join("\n");

for (const width of [390, 1280]) {
  for (const enabled of [false, true]) {
    test(`import diagnostics ${enabled ? "ON" : "OFF"} at ${width}px`, async ({ page }) => {
      disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
      expect(process.env.DEMO_MODE).toBe("true");
      expect(process.env.IMPORT_ERROR_DETAILS_ENABLED).toBe("true");
      await page.setViewportSize({ width, height: 844 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()}`); });
      await resetDemo(page);
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query("UPDATE organizations SET feature_flags = feature_flags || jsonb_build_object('import_error_details', $2::boolean) WHERE id = $1", [ORG_ID, enabled]);
      } finally { await client.end(); }
      await page.route("**/api/import", async (route) => {
        const body = route.request().postDataJSON();
        if (body.mode === "preview") {
          await route.fulfill({ json: { issues: [] } });
        } else {
          const line = body.rows[0].line;
          expect(line).toBe(enabled ? 3 : 2);
          const result = { dryRun: false, fileName: body.fileName,
            created: { properties: 0, units: 0, rooms: 0, owners: 0, tenants: 0, leases: 0, vacant: 0 },
            reused: { units: 0, tenants: 0, leases: 0 }, duplicateRows: 0, openingMinor: 0,
            errors: [{ line, severity: "error", key: "im_e_exists", vars: { v: body.rows[0].propertyName }, fields: ["propertyName", "address"] }], warnings: [] };
          await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ type: "result", result }) + "\n" });
        }
      });
      await page.goto("/api/demo/locale?set=zh-TW&next=/m/import");
      await page.getByTestId("import-to-upload").click();
      await page.getByTestId("import-file").setInputFiles({ name: "diagnostics.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
      await expect(page.getByTestId("import-ok-count")).toHaveText("1");
      await expect(page.getByTestId("import-err-count")).toHaveText("1");
      const headers = page.getByTestId("import-preview-table").locator("thead");
      if (enabled) {
        await expect(headers).toContainText("原始列號");
        const invalid = page.locator('[data-testid="import-issue-row"][data-line="6"]');
        await expect(invalid).toContainText("起租日");
        await expect(invalid).toContainText("到期日");
        await expect(invalid).toContainText("YYYY-MM-DD");
        await page.getByTestId("import-run").click();
        await expect(page.getByTestId("import-err-count")).toHaveText("2");
        await expect(page.getByTestId("import-ok-count")).toHaveText("0");
        await expect(page.locator('[data-testid="import-issue-row"][data-line="3"]').locator(".import-ok")).toHaveCount(0);
        await expect(page.getByTestId("import-run")).toBeDisabled();
      } else { await expect(headers).not.toContainText("原始列號"); }
      const pending = page.waitForEvent("download");
      await page.getByTestId("import-errors-csv").click();
      const download = await pending;
      mkdirSync("../work/B006", { recursive: true });
      const target = `../work/B006/problems-${enabled}-${width}.csv`;
      await download.saveAs(target);
      const rows = parseCsv(readFileSync(target, "utf8"));
      if (enabled) {
        const col = rows[0].indexOf("原始列號");
        expect(col).toBeGreaterThanOrEqual(0);
        expect(rows.slice(1).map((r) => r[col])).toEqual(["3", "6"]);
        expect(rows[1][0]).toBe("診斷有效物件");
        expect(rows[2].at(-1)).toContain("起租日");
        expect(rows[2].at(-1)).toContain("到期日");
      } else { expect(rows[0]).not.toContain("原始列號"); }
      await page.screenshot({ path: `../work/B006/diagnostics-${enabled}-${width}.png`, fullPage: true });
      expect(errors).toEqual([]);
    });
  }
}
