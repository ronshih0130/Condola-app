import { disposableDbUrl } from "../src/server/test-disposable-db";
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { Client } from "pg";
import { markTryout } from "../src/server/domain";
import { ORG_ID } from "../src/server/ids";
import { ACCOUNTS, resetDemo, signIn } from "./session";

function requireDisposableDatabase() {
  disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
  if (process.env.DEMO_MODE !== "true") throw new Error("Local demo mode required");
}

for (const width of [390, 1280]) {
  test(`sandbox trial progress resumes after sign-out at ${width}px`, async ({ page }) => {
    requireDisposableDatabase();
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("response", (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });

    await resetDemo(page);
    await page.goto("/api/env?set=sandbox&next=/m");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    let sandboxId: string;
    try {
      const result = await client.query<{ id: string }>(
        `UPDATE organizations SET settings = settings - 'tryout'
          WHERE environment = 'sandbox' AND live_org_id = $1 RETURNING id::text`, [ORG_ID],
      );
      expect(result.rowCount).toBe(1);
      sandboxId = result.rows[0].id;
    } finally {
      await client.end();
    }
    await page.reload();
    await expect(page.getByTestId("tryout-task-property")).toHaveAttribute("data-complete", "false");
    await markTryout(sandboxId, "property");
    await page.reload();
    await expect(page.getByTestId("tryout-task-property")).toHaveAttribute("data-complete", "true");
    await expect(page.getByTestId("tryout-task-lease")).toHaveAttribute("data-complete", "false");

    if (width === 390) await page.getByTestId("nav-toggle").click();
    await page.getByTestId(width === 390 ? "sign-out-drawer" : "sign-out").click();
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, ACCOUNTS.admin);
    await page.goto("/api/env?set=sandbox&next=/m");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    await expect(page.getByTestId("tryout-task-property")).toHaveAttribute("data-complete", "true");
    await expect(page.getByTestId("tryout-task-lease")).toHaveAttribute("data-complete", "false");
    mkdirSync("../work/B005", { recursive: true });
    await page.screenshot({ path: `../work/B005/resume-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
