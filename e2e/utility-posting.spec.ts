import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("a manager confirms 電費 and the tenant sees it on the bill", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/units");

  for (const room of ["A", "B"]) {
    await page.getByTestId(`space-row-3F-${room}`).getByRole("link", { name: "編輯" }).click();
    await page.getByTestId("space-electricity").selectOption("submeter");
    await page.getByTestId("space-rate").fill("4");
    await page.getByTestId("save-space").click();
    await expect(page.getByTestId(`space-row-3F-${room}`)).toContainText("分表");
  }

  await page.goto("/m/rent");
  await page.getByTestId("utility-entry").click();
  await expect(page.getByTestId("utility-month")).toBeVisible();
  await expect(page.getByTestId("utility-form")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("房東");
  await page.getByTestId("utility-rate").fill("4");
  await page.getByTestId("kwh-prev-A").fill("0");
  await page.getByTestId("kwh-curr-A").fill("100");
  await page.getByTestId("kwh-prev-B").fill("0");
  await page.getByTestId("kwh-curr-B").fill("50");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-review")).toBeVisible();
  await expect(page.getByTestId("utility-share-desc").nth(0)).toContainText("電費 100 度 × 4 元");
  await expect(page.getByTestId("utility-share-desc").nth(1)).toContainText("電費 50 度 × 4 元");
  await page.getByTestId("utility-confirm").click();
  await expect(page.getByTestId("utility-saved")).toContainText("電費已記入租客本期帳單");
  await expect(page.getByTestId("utility-posted-lock")).toContainText("這期已確認入帳，新租約不會改動金額");
  await expect(page.getByTestId("utility-confirm")).toHaveCount(0);
  await page.getByTestId("kwh-curr-A").fill("90");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-status")).toContainText("待重新入帳");
  await page.getByTestId("kwh-prev-A").fill("0");
  await page.getByTestId("kwh-curr-A").fill("100");
  await page.getByTestId("kwh-prev-B").fill("0");
  await page.getByTestId("kwh-curr-B").fill("50");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-status")).toContainText("待重新入帳");
  await page.getByTestId("utility-confirm").click();
  await expect(page.getByTestId("utility-status")).toContainText("已入帳");

  await page.goto("/m/leases");
  await page.getByRole("link", { name: "王小美" }).click();
  await page.getByRole("link", { name: "帳務" }).click();
  await expect(page.getByTestId("invoice-utility-line")).toContainText("電費 100 度 × 4 元");
  await expect(page.getByTestId("invoice-utility")).toHaveAttribute("data-minor", "40000");
  await expect(page.locator("body")).not.toContainText("房東");

  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t/pay");
  await expect(page.getByTestId("tenant-utility-line")).toContainText("電費 100 度 × 4 元");
  await expect(page.locator("body")).not.toContainText("房東");
});

test("平均分攤 saves from the property wizard and splits the bill with no room readings", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/properties/new");
  await page.getByTestId("property-name").fill("松德電費");
  await page.getByTestId("property-city").fill("台北市");
  await page.getByTestId("property-district").fill("松山區");
  await page.getByTestId("property-street").fill("松德路");
  await page.getByText("新屋主", { exact: true }).click();
  await page.getByTestId("owner-name").fill("電費屋主");
  await page.getByTestId("owner-phone").fill("0912000888");
  await page.getByTestId("wizard-next").click();
  await page.getByText("分房出租", { exact: true }).click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("unit-label").fill("3F");
  await page.locator("input[name=floor]").fill("3");
  await page.getByTestId("add-room").click();
  await page.getByTestId("add-room").click();
  for (const [index, label] of ["A", "B", "C"].entries()) {
    await page.getByTestId(`room-${index}-label`).fill(label);
    await page.getByTestId(`room-${index}-rent`).fill("12000");
  }
  await page.getByTestId("wizard-next").click();
  await expect(page.locator('input[name="bill"]')).toHaveCount(0);
  await expect(page.locator('input[name="usage"]')).toHaveCount(0);
  await page.getByTestId("property-split").selectOption("owner");
  await expect(page.getByTestId("property-rate")).toHaveCount(0);
  await expect(page.getByTestId("property-electricity-preview")).toHaveCount(0);
  await page.getByTestId("property-split").selectOption("even");
  await page.getByTestId("property-rate").fill("5");
  await expect(page.getByTestId("property-electricity-preview")).toContainText("NT$");
  await page.getByTestId("submit-property").click();
  await expect(page.getByRole("heading", { name: "松德電費" })).toBeVisible();

  await page.goto("/m/rent/utilities");
  await page.getByTestId("utility-unit").selectOption({ label: "松德電費 · 3F" });
  await page.getByTestId("utility-month-form").getByRole("button", { name: "查看這個月" }).click();
  await expect(page.getByTestId("utility-method")).toContainText("平均分攤");
  await expect(page.getByTestId("utility-method")).toContainText("修改物件電費設定");
  await expect(page.getByTestId("kwh-prev-A")).toHaveCount(0);
  await expect(page.getByTestId("utility-bill")).toBeVisible();
  await expect(page.getByTestId("utility-total-kwh")).toBeVisible();
  await page.getByTestId("utility-rate").fill("5");
  await page.getByTestId("utility-bill").fill("3000");
  await page.getByTestId("utility-total-kwh").fill("100");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-review")).toBeVisible();
  await expect(page.getByTestId("utility-gap-warn")).toContainText("請檢查每度電價");
  await expect(page.getByTestId("utility-gap")).toHaveCount(0);
  await expect(page.getByTestId("utility-share")).toHaveCount(3);
  const ownerShares = page.getByTestId("utility-share").filter({ hasText: "屋主（空房）" });
  await expect(ownerShares).toHaveCount(3);
  await expect(ownerShares.nth(0)).toContainText("NT$1,000");
  await expect(ownerShares.nth(1)).toContainText("NT$1,000");
  await expect(ownerShares.nth(2)).toContainText("NT$1,000");
  await expect(page.getByTestId("utility-share-desc").first()).toContainText("電費（平均分攤）");
});

test("公共用電 and 帳單差額 show as separate owner lines with a rate warning", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/units");
  for (const room of ["A", "B", "C"]) {
    await page.getByTestId(`space-row-3F-${room}`).getByRole("link", { name: "編輯" }).click();
    await page.getByTestId("space-electricity").selectOption("submeter");
    await page.getByTestId("space-rate").fill("5");
    await page.getByTestId("save-space").click();
    await expect(page.getByTestId(`space-row-3F-${room}`)).toContainText("分表");
  }

  await page.goto("/m/rent/utilities");
  await page.getByTestId("utility-unit").selectOption({ label: "信義松仁 · 3F" });
  await page.getByTestId("utility-month-form").getByRole("button", { name: "查看這個月" }).click();
  await page.getByTestId("utility-rate").fill("5");
  await page.getByTestId("utility-bill").fill("500");
  await page.getByTestId("utility-total-kwh").fill("160");
  await page.getByTestId("kwh-prev-A").fill("0");
  await page.getByTestId("kwh-curr-A").fill("100");
  await page.getByTestId("kwh-prev-B").fill("0");
  await page.getByTestId("kwh-curr-B").fill("50");
  await page.getByTestId("kwh-prev-C").fill("0");
  await page.getByTestId("kwh-curr-C").fill("20");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-public-warn")).toContainText("分表加總超過台電總度數");
  await expect(page.getByTestId("utility-gap-warn")).toContainText("請檢查每度電價");
  await expect(page.getByTestId("utility-public")).toContainText("公共用電");
  await expect(page.getByTestId("utility-public")).toContainText("-NT$50");
  await expect(page.getByTestId("utility-gap")).toContainText("電費（帳單差額）");
  await expect(page.getByTestId("utility-gap")).toContainText("-NT$300");
  await expect(page.getByTestId("utility-share").filter({ hasText: "屋主（空房）" })).toContainText("NT$100");
});
