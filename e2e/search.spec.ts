import { expect, test } from "@playwright/test";
import { resetDemo, signIn } from "./session";

test("list pages search inside the firm and keep the query in the URL", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/properties");
  await expect(page.getByTestId("list-search")).toBeVisible();
  await expect(page.getByTestId("list-search")).toHaveAttribute("placeholder", "搜尋物件名稱、地址或屋主");
  await expect(page.locator("header.top")).not.toContainText("搜尋");
  await expect(page.locator("aside.side").getByTestId("list-search")).toHaveCount(0);
  await expect(page.locator(".main")).not.toContainText("房東");
  await expect(page.locator(".main")).not.toContainText("房客");

  await page.getByTestId("list-search").fill("松仁");
  await page.getByTestId("list-search").press("Enter");
  await expect(page).toHaveURL(/\/m\/properties\?q=/);
  await expect(page.getByTestId("property-list")).toContainText("信義松仁");
  await expect(page.getByTestId("property-list")).not.toContainText("延平");
  await expect(page.getByTestId("property-list")).not.toContainText("大安和平");

  await page.goto("/m/properties?page=2");
  await expect(page.getByTestId("property-list")).not.toContainText("信義松仁");
  await expect(page.getByTestId("list-prev")).toBeVisible();

  await page.goto("/m/tenants?q=" + encodeURIComponent("王小美"));
  await expect(page.getByTestId("tenant-list")).toContainText("王小美");
  await expect(page.getByTestId("tenant-list")).not.toContainText("李愛玲");

  await page.goto("/m/leases?q=912111003");
  await expect(page.getByTestId("lease-list")).toContainText("李愛玲");
  await expect(page.getByTestId("lease-list")).not.toContainText("王小美");

  await page.goto("/m/units?q=" + encodeURIComponent("Apt 2B"));
  await expect(page.getByTestId("space-list")).toContainText("Oakland 12th");
  await expect(page.getByTestId("space-list")).not.toContainText("信義松仁");
  await expect(page.locator(".main")).not.toContainText("房東");
  await expect(page.locator(".main")).not.toContainText("房客");

  await signIn(page, "admin@coast.demo");
  await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent("/m/properties?q=" + encodeURIComponent("信義"))}`);
  await expect(page.getByTestId("property-list")).not.toContainText("信義松仁");
  await expect(page.getByTestId("property-list")).toContainText("沒有符合的資料");
  await page.goto("/m/properties?q=" + encodeURIComponent("延平"));
  await expect(page.getByTestId("property-list")).toContainText("延平北路");
  await page.goto("/m/tenants?q=" + encodeURIComponent("張雅文"));
  await expect(page.getByTestId("tenant-list")).toContainText("張雅文");
  await expect(page.getByTestId("tenant-list")).toContainText("延平");
  await expect(page.getByTestId("tenant-list")).not.toContainText("信義");
  await page.goto("/m/units?q=5F");
  await expect(page.getByTestId("space-list")).toContainText("延平北路");
  await page.goto("/m/units?q=" + encodeURIComponent("Apt 2B"));
  await expect(page.getByTestId("space-list")).not.toContainText("Oakland");
});
