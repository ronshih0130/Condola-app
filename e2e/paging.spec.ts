import { expect, test } from "@playwright/test";
import { PAGING_COUNT, clearPagingRows, seedPagingRows } from "./paging-seed";
import { signIn } from "./session";

const lists = [
  { path: "/m/leases", testId: "lease-list" },
  { path: "/m/tenants", testId: "tenant-list" },
  { path: "/m/properties", testId: "property-list" },
  { path: "/m/units", testId: "space-list" },
] as const;

test("list pages page past 40 rows and keep one row per tenant", async ({ page }) => {
  const prefix = `頁次${Date.now().toString(36)}`;
  await clearPagingRows(prefix);
  await seedPagingRows(prefix);
  try {
    await signIn(page, "yating.lin@songxin.demo");
    await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent("/m/leases")}`);

    for (const list of lists) {
      await page.goto(`${list.path}?q=${encodeURIComponent(prefix)}`);
      const summary = page.getByTestId("list-summary");
      await expect(summary).toContainText("共");
      await expect(summary).toContainText("筆");
      const total = Number(await summary.getAttribute("data-total"));
      expect(total).toBeGreaterThan(40);
      expect(total).toBeGreaterThanOrEqual(PAGING_COUNT);
      await expect(summary).toHaveAttribute("data-from", "1");
      await expect(page.getByTestId("list-next")).toBeVisible();
      const rowText = await page.getByTestId(list.testId).locator("tbody tr").first().innerText();
      const first = rowText.match(/-p-\d{3}/)?.[0] ?? rowText.split("\n")[0];
      await page.getByTestId("list-next").click();
      await expect(page).toHaveURL(new RegExp(`${list.path}\\?.*q=`));
      await expect(page).toHaveURL(/page=2/);
      await expect(summary).toHaveAttribute("data-from", "51");
      await expect(page.getByTestId(list.testId)).not.toContainText("目前沒有資料");
      await expect(page.getByTestId(list.testId)).not.toContainText(first);
      await page.getByTestId("list-prev").click();
      await expect(page).toHaveURL(new RegExp(`${list.path}\\?q=`));
      await expect(page).not.toHaveURL(/page=/);
      await expect(page.getByTestId(list.testId)).toContainText(first);
    }

    await page.goto(`/m/leases?page=2`);
    await expect(page.getByTestId("lease-list")).not.toContainText("目前沒有資料");
    await expect(page.getByTestId("list-prev")).toBeVisible();
    const unfiltered = Number(await page.getByTestId("list-summary").getAttribute("data-total"));
    expect(unfiltered).toBeGreaterThan(40);

    await page.goto(`/m/tenants?q=${encodeURIComponent(`${prefix}-t-000`)}`);
    await expect(page.getByTestId("tenant-list").locator("tbody tr")).toHaveCount(1);
    await expect(page.getByTestId("tenant-lease-more")).toHaveText("+1");

    await page.goto(`/m/leases?q=${encodeURIComponent(prefix)}`);
    await page.getByTestId("list-search-clear").click();
    await expect(page).toHaveURL(/\/m\/leases$/);
    await expect(page.getByTestId("list-search")).toHaveValue("");
  } finally {
    await clearPagingRows(prefix);
  }
});
