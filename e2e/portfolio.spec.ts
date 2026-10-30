import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("admin and manager keep buildings, spaces, and 屋主 inside the firm", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/owners");
  await expect(page.getByTestId("owner-list")).toBeVisible();
  await expect(page.locator(".main")).not.toContainText("房東");
  await page.getByTestId("new-owner").click();
  await page.getByTestId("owner-name").fill("範屋主丁");
  await page.getByTestId("owner-email").fill("owner4.demo@example.com");
  await page.getByTestId("save-owner").click();
  await expect(page.getByTestId("owner-row-owner4.demo@example.com")).toContainText("範屋主丁");

  await page.getByTestId("owner-row-owner4.demo@example.com").getByRole("link", { name: "編輯" }).click();
  await page.getByTestId("owner-name").fill("範屋主丁改");
  await page.locator("label", { hasText: "信義松仁" }).locator("input").check();
  await page.getByTestId("save-owner").click();
  const ownerRow = page.getByTestId("owner-row-owner4.demo@example.com");
  await expect(ownerRow).toContainText("範屋主丁改");
  await expect(ownerRow).toContainText("信義松仁");

  await page.goto("/m/units/new");
  await page.getByTestId("space-kind-room").check();
  await page.getByTestId("space-property").selectOption({ label: "信義松仁" });
  await page.getByTestId("space-owner").selectOption({ label: "範屋主丁改" });
  await page.getByTestId("space-floor").fill("6F");
  await page.getByTestId("space-room").fill("A");
  await page.getByTestId("space-type").selectOption("suite");
  await page.getByTestId("space-area").fill("8");
  await page.getByTestId("space-rent").fill("10500");
  await page.getByTestId("space-electricity").selectOption("submeter");
  await page.getByTestId("space-rate").fill("4");
  await page.getByTestId("space-notes").fill("範例資料");
  await page.getByTestId("save-space").click();
  const roomRow = page.getByTestId("space-row-6F-A");
  await expect(roomRow).toContainText("大樓中的房間");
  await expect(roomRow).toContainText("套房");
  await expect(roomRow).toContainText("範屋主丁改");
  await expect(roomRow).toContainText("10,500");
  const headers = (await page.getByTestId("space-list").locator("th").allTextContents()).join(" ");
  expect(headers).not.toContain("租客");
  expect(headers).not.toContain("房東");

  await roomRow.getByRole("link", { name: "編輯" }).click();
  await page.getByTestId("space-rent").fill("11000");
  await page.getByTestId("save-space").click();
  await expect(page.getByTestId("space-row-6F-A")).toContainText("11,000");

  await page.getByTestId("new-space").click();
  await page.getByTestId("space-kind-whole").check();
  await expect(page.getByTestId("space-room")).toHaveCount(0);
  await page.getByTestId("space-property").selectOption({ label: "大安和平" });
  await page.getByTestId("space-owner").selectOption({ label: "範屋主丁改" });
  await page.getByTestId("space-floor").fill("9F");
  await page.getByTestId("space-area").fill("25");
  await page.getByTestId("space-rent").fill("18900");
  await page.getByTestId("space-electricity").selectOption("tenant_direct");
  await page.getByTestId("save-space").click();
  const wholeRow = page.getByTestId("space-row-9F-unit");
  await expect(wholeRow).toContainText("整戶／整層");
  await expect(wholeRow).toContainText("18,900");
  await expect(wholeRow).toContainText("租客自繳");

  await page.goto("/m/properties");
  await page.getByRole("link", { name: "信義松仁" }).click();
  await page.getByTestId("edit-property").click();
  await expect(page.getByTestId("property-street")).not.toHaveValue("");
  await page.getByTestId("property-name").fill("信義松仁改");
  await page.getByTestId("save-property").click();
  await expect(page.getByRole("heading", { name: "信義松仁改" })).toBeVisible();
  await expect(page.locator(".main")).not.toContainText("房東");
  await page.screenshot({ path: "../e2e-artifacts/portfolio-property.png", fullPage: true });
  await page.goto("/m/units");
  await expect(page.getByTestId("space-row-6F-A")).toBeVisible();
  await page.screenshot({ path: "../e2e-artifacts/portfolio-spaces.png", fullPage: true });
  await page.goto("/m/owners");
  await expect(page.getByTestId("owner-row-owner4.demo@example.com")).toBeVisible();
  await page.screenshot({ path: "../e2e-artifacts/portfolio-owners.png", fullPage: true });

  await signIn(page, ACCOUNTS.manager);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/units/new");
  await expect(page.getByTestId("save-space")).toBeVisible();
  await page.goto("/m/owners/new");
  await expect(page.getByTestId("save-owner")).toBeVisible();

  await signIn(page, ACCOUNTS.accountant);
  await page.goto("/m/owners");
  await expect(page.getByTestId("owner-list")).toBeVisible();
  await expect(page.getByTestId("new-owner")).toHaveCount(0);
  await page.goto("/m/owners/new");
  await expect(page.getByTestId("forbidden")).toBeVisible();
  await page.goto("/m/units");
  await expect(page.getByTestId("space-list")).toContainText("6F");
  await expect(page.getByTestId("new-space")).toHaveCount(0);

  await signIn(page, ACCOUNTS.maintenance);
  await page.goto("/m/owners");
  await expect(page.getByTestId("forbidden")).toBeVisible();
  await page.goto("/m/units/new");
  await expect(page.getByTestId("forbidden")).toBeVisible();
});
