import { expect, test } from "@playwright/test";
import { ACCOUNTS, signIn } from "./session";

const STUB = "LINE 登入與推播是範例，不會連到 LINE 伺服器。";
const NOTE = "LINE 推播是範例，不會送到 LINE。";
const DEMO = "範例：登入已連結 LINE 的成員。不會連到 LINE 伺服器。";

test("live mode hides demo LINE copy and sandbox shows it", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("line-demo-note")).toHaveText(DEMO);
  await expect(page.getByText("租客用 LINE 就能查帳單、回報轉帳。")).toBeVisible();
  await expect(page.getByTestId("line-login")).toBeVisible();
  await expect(page.getByText("LINE 登入尚未開放")).toHaveCount(0);

  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/notify");
  await expect(page.getByTestId("notify-empty")).toHaveText("目前沒有通知");
  await expect(page.getByTestId("line-stub")).toHaveCount(0);
  await expect(page.getByTestId("notify-note")).toHaveCount(0);
  await expect(page.locator(".main")).not.toContainText("LINE");

  await page.goto("/m/account");
  await expect(page.getByTestId("line-demo-note")).toHaveCount(0);
  await expect(page.getByTestId("line-link")).toHaveCount(0);
  await expect(page.locator(".main")).not.toContainText("LINE");

  await page.goto("/m/leases/new");
  await expect(page.getByTestId("tenant-line")).toHaveCount(0);
  await page.goto("/walk");
  await expect(page.locator("body")).not.toContainText("LINE");
  await page.goto("/m/audit");
  await expect(page.locator(".main")).not.toContainText("LINE");

  await page.goto("/api/env?set=sandbox&next=/m/notify");
  await expect(page.getByTestId("line-stub")).toHaveText(STUB);
  await expect(page.getByTestId("notify-note")).toHaveText(NOTE);
  await expect(page.getByTestId("notify-empty")).toHaveCount(0);

  await page.goto("/m/account");
  await expect(page.getByTestId("line-demo-note")).toHaveText(DEMO);
  await expect(page.getByTestId("line-link")).toBeVisible();
  await page.goto("/m/leases/new");
  await expect(page.getByTestId("tenant-line")).toHaveCount(1);

  await signIn(page, ACCOUNTS.tenant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  await expect(page.getByTestId("liff-frame")).toBeVisible();
  await expect(page.getByTestId("line-stub")).toHaveCount(0);
  await expect(page.getByTestId("liff-frame")).not.toContainText("不會連到 LINE 伺服器");
  await expect(page.getByTestId("liff-frame")).not.toContainText("不會送到 LINE");
});
