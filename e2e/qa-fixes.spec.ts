import { expect, test } from "@playwright/test";
import { resetDemo } from "./session";

test("renewal stays available, and the preview generate button opens the statement", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");

  await expect(page.getByTestId("deposit-months")).toHaveValue("2");
  await expect(page.getByTestId("due-day")).toHaveValue("5");
  await expect(page.getByTestId("bill-total")).toHaveCount(0);
  await expect(page.getByTestId("usage")).toHaveCount(0);

  const room = page.getByTestId("lease-room");
  const occupied = room.locator("option", { hasText: "3F A" });
  await expect(occupied).toHaveCount(1);
  await room.selectOption((await occupied.getAttribute("value")) ?? "");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("續約租客");
  await page.getByTestId("tenant-phone").fill("+886912300077");
  await page.getByTestId("wizard-next").click();

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  await page.getByTestId("start-date").fill(today);
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("10000");
  const overlap = page.getByTestId("room-lease-overlap");
  await expect(overlap).toBeVisible();
  await expect(overlap).toContainText(/此房間在 \d{4}-\d{2}-\d{2}–\d{4}-\d{2}-\d{2} 已有租約/);
  await expect(page.getByTestId("wizard-next")).toBeDisabled();

  await page.getByTestId("start-date").fill("2030-01-01");
  await expect(overlap).toHaveCount(0);
  await expect(page.getByTestId("wizard-next")).toBeEnabled();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("deposit-months")).toHaveValue("2");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("due-day")).toHaveValue("5");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  const submit = page.getByTestId("submit-lease");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1/);
  await expect(page.getByTestId("lease-created")).toHaveText("租約已建立，請將簽署連結傳給租客");

  await page.goto("/m/statements?month=2027-11");
  await page.locator('a[href*="/m/statements/preview"]').first().click();
  await expect(page).toHaveURL(/\/m\/statements\/preview/);
  await page.getByTestId("preview-generate").click();
  await expect(page).toHaveURL(/\/m\/statements\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("preview-generate")).toHaveCount(0);
});
