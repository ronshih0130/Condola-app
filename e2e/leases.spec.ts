import { expect, test } from "@playwright/test";
import { resetDemo, signIn } from "./session";

test("deposit reason and a private signed PDF", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");
  await expect(page.locator("body")).not.toContainText("房東");

  const room = page.getByTestId("lease-room");
  const roomValue = await room.locator("option", { hasText: "信義松仁" }).first().getAttribute("value");
  expect(roomValue).toBeTruthy();
  await room.selectOption(roomValue ?? "");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("紙本房客");
  await page.getByTestId("tenant-phone").fill("+886912300088");
  await page.getByTestId("tenant-line").fill("U-pilot-line");
  await page.getByTestId("wizard-next").click();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  await page.getByTestId("start-date").fill(today);
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("10000");
  await page.getByTestId("wizard-next").click();

  await page.getByTestId("deposit-months").fill("3");
  const alert = page.getByTestId("deposit-alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("請填寫原因");
  await expect(alert).not.toContainText("房東");
  await expect(page.getByTestId("wizard-next")).toBeDisabled();
  await page.getByTestId("deposit-reason").fill("   ");
  await expect(page.getByTestId("wizard-next")).toBeDisabled();
  await page.getByTestId("deposit-reason").fill("屋主同意兩個月以上押金");
  await expect(page.getByTestId("wizard-next")).toBeEnabled();
  await page.getByTestId("wizard-next").click();

  await page.getByTestId("due-day").fill("5");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("split-method").selectOption("even");
  await page.getByTestId("bill-total").fill("2000");
  await page.getByTestId("usage").fill("400");
  await page.getByTestId("rate").fill("4");
  await expect(page.getByTestId("cap-alert")).toHaveCount(0);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("submit-lease").click();

  const error = page.getByTestId("error-banner");
  if (await error.isVisible().catch(() => false)) {
    throw new Error(await error.innerText());
  }
  await expect(page.getByTestId("paper-sign")).toBeVisible();
  await page.getByTestId("signed-pdf").setInputFiles({
    name: "signed-lease.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
  });
  await page.getByTestId("upload-signed-pdf").click();
  if (await error.isVisible().catch(() => false)) {
    throw new Error(await error.innerText());
  }
  await expect(page.getByTestId("paper-signed")).toContainText("已上傳紙本租約");
  await expect(page.getByTestId("paper-signed")).toContainText("signed-lease.pdf");

  await page.getByRole("link", { name: "摘要" }).click();
  await expect(page.getByTestId("tenant-line-id")).toHaveText("U-pilot-line");
  await expect(page.getByText("生效中")).toBeVisible();

  const leaseId = page.url().match(/leases\/([^/?]+)/)?.[1];
  expect(leaseId).toBeTruthy();
  const pdf = await page.request.get(`/m/leases/${leaseId}/signed`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");

  await signIn(page, "admin@coast.demo");
  const leaked = await page.request.get(`/m/leases/${leaseId}/signed`);
  expect(leaked.status()).toBe(404);
});
