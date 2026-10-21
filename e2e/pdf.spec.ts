import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { pdfContainsAscii } from "../src/lib/pdf-text";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("lease and statement PDFs download, and another firm is denied", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.manager);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases");
  await page.getByTestId("lease-list").locator("a").first().click();
  await expect(page.getByTestId("download-lease-pdf")).toBeVisible();
  const leaseId = page.url().match(/leases\/([^/?]+)/)?.[1];
  expect(leaseId).toBeTruthy();

  const metaPromise = page.waitForResponse(
    (response) => response.url().includes(`/api/pdf/leases/${leaseId}`) && response.request().method() === "GET",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-lease-pdf").click();
  const meta = await metaPromise;
  expect(meta.ok()).toBeTruthy();
  const body = (await meta.json()) as { footerHash: string; blocks: unknown };
  expect(body.footerHash).toMatch(/^[a-f0-9]{64}$/);
  const copy = JSON.stringify(body);
  const sublessor = "二" + "房東";
  expect(copy).toContain("承租人");
  expect(copy).toContain("出租人");
  expect(copy).toContain("紙本簽署");
  expect(copy).toContain(sublessor);
  expect(copy.split(sublessor).join("")).not.toContain("房東");
  expect(copy).not.toContain("88921");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("lease.pdf");
  const bytes = readFileSync((await download.path()) ?? "");
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdfContainsAscii(bytes, body.footerHash)).toBe(true);

  await signIn(page, ACCOUNTS.maintenance);
  expect((await page.request.get(`/api/pdf/leases/${leaseId}`)).status()).toBe(404);

  await signIn(page, "admin@coast.demo");
  expect((await page.request.get(`/api/pdf/leases/${leaseId}`)).status()).toBe(404);
  expect((await page.request.get("/api/pdf/leases/not-a-uuid")).status()).toBe(404);

  await signIn(page, ACCOUNTS.tenant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  await page.getByRole("button", { name: "松信住宅管理" }).click();
  await expect(page.getByTestId("lease-picker")).toHaveCount(0);
  await page.getByTestId("tenant-tile-lease").click();
  await expect(page.getByTestId("download-lease-pdf")).toBeVisible();
  const tenantMetaPromise = page.waitForResponse(
    (response) => response.url().includes("/api/pdf/leases/") && response.request().method() === "GET",
  );
  const tenantDownload = page.waitForEvent("download");
  await page.getByTestId("download-lease-pdf").click();
  const tenantMeta = await tenantMetaPromise;
  const tenantLeaseId = new URL(tenantMeta.url()).pathname.split("/").pop();
  expect(tenantLeaseId).toBeTruthy();
  const tenantFile = await tenantDownload;
  const tenantBytes = readFileSync((await tenantFile.path()) ?? "");
  expect(tenantBytes.subarray(0, 5).toString()).toBe("%PDF-");

  await signIn(page, ACCOUNTS.tenant2);
  expect((await page.request.get(`/api/pdf/leases/${tenantLeaseId}`)).status()).toBe(404);

  await signIn(page, ACCOUNTS.owner);
  await page.goto("/api/demo/locale?set=zh-TW&next=/o/statements");
  await page.locator('a[href*="/o/statements/"]').first().click();
  await expect(page.getByTestId("download-statement-pdf")).toBeVisible();
  const statementId = page.url().match(/statements\/([^/?]+)/)?.[1];
  expect(statementId).toBeTruthy();
  const statementDownload = page.waitForEvent("download");
  await page.getByTestId("download-statement-pdf").click();
  const statementFile = await statementDownload;
  expect(statementFile.suggestedFilename()).toBe("owner-statement.pdf");
  const statementBytes = readFileSync((await statementFile.path()) ?? "");
  expect(statementBytes.subarray(0, 5).toString()).toBe("%PDF-");

  await signIn(page, ACCOUNTS.manager);
  await page.goto(`/api/demo/locale?set=zh-TW&next=/m/statements/${statementId}`);
  await expect(page.getByTestId("download-statement-pdf")).toBeVisible();
  const managerStatement = page.waitForEvent("download");
  await page.getByTestId("download-statement-pdf").click();
  const managerFile = await managerStatement;
  expect(readFileSync((await managerFile.path()) ?? "").subarray(0, 5).toString()).toBe("%PDF-");

  await signIn(page, "admin@coast.demo");
  expect((await page.request.get(`/api/pdf/statements/${statementId}`)).status()).toBe(404);
  await signIn(page, ACCOUNTS.tenant);
  await page.goto("/t");
  expect((await page.request.get(`/api/pdf/statements/${statementId}`)).status()).toBe(404);
  await signIn(page, "xiuying.lin@owner.demo");
  expect((await page.request.get(`/api/pdf/statements/${statementId}`)).status()).toBe(404);
});
