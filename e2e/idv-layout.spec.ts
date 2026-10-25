import { expect, test, type Locator, type Page } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

async function zh(page: Page, next: string) {
  await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(next)}`);
}

async function fullyInViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  const viewport = page.viewportSize();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  const hit = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const x = Math.min(rect.right - 1, Math.max(rect.left + 1, rect.left + rect.width / 2));
    const y = Math.min(rect.bottom - 1, Math.max(rect.top + 1, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    return Boolean(top && (node === top || node.contains(top)));
  });
  expect(hit).toBe(true);
}

test("task pages pin consent actions and rename the bills tab", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.tenant2);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await zh(page, "/t");
    await expect(page.getByTestId("tenant-nav")).toBeVisible();
    await expect(page.getByTestId("tenant-tile-pay")).toHaveText("我的帳單");
    await expect(page.getByTestId("env-banner")).toHaveCount(0);
    await expect(page.getByTestId("line-stub")).toHaveCount(0);
    await expect(page.getByTestId("task-back")).toHaveCount(0);
    const home = await page.locator("body").innerText();
    expect(home).not.toContain("LINE");
    expect(home).not.toContain("示範");
    expect(home).not.toContain("測試模式");
    expect(home).not.toContain("繳租");

    await page.goto("/t/pay");
    await expect(page.getByRole("heading", { name: "我的帳單" })).toBeVisible();
    await expect(page.getByTestId("tenant-tile-pay")).toHaveText("我的帳單");

    await page.goto("/t/id");
    await expect(page.getByTestId("tenant-nav")).toHaveCount(0);
    await expect(page.getByTestId("task-back")).toHaveText("← 返回");
    await expect(page.getByTestId("task-back")).toHaveAttribute("href", "/t");
    await expect(page.locator("#idvNotice")).toBeVisible();
    const scroll = page.locator(".idv-task-scroll");
    const scrolls = await scroll.evaluate((node) => node.scrollHeight > node.clientHeight + 8);
    expect(scrolls).toBe(true);
    await fullyInViewport(page, page.locator("#idvAgree"));
    await fullyInViewport(page, page.getByTestId("idv-start"));
    await scroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await fullyInViewport(page, page.locator("#idvAgree"));
    await fullyInViewport(page, page.getByTestId("idv-start"));
    const noticeBottom = await page.locator("#idvNotice").evaluate((node) => node.getBoundingClientRect().bottom);
    const barTop = await page.getByTestId("idv-consent-bar").evaluate((node) => node.getBoundingClientRect().top);
    expect(noticeBottom).toBeLessThanOrEqual(barTop + 1);
    const upload = await page.locator("body").innerText();
    expect(upload).not.toContain("LINE");
    expect(upload).not.toContain("示範");
    expect(upload).not.toContain("測試模式");

    await page.locator("#idvAgree").check();
    await page.getByTestId("idv-start").click();
    await expect(page.locator("#idvDoc")).toBeVisible();
    await expect(page.getByTestId("tenant-nav")).toHaveCount(0);
    await expect(page.getByTestId("idv-consent-bar")).toHaveCount(0);
    await expect(page.getByTestId("task-back")).toBeVisible();

    await page.goto("/t/id/notice");
    await expect(page.getByTestId("tenant-nav")).toHaveCount(0);
    await expect(page.getByTestId("task-back")).toHaveText("← 返回");
    await expect(page.getByTestId("task-back")).toHaveAttribute("href", "/t/id");
    await expect(page.getByTestId("idv-back-upload")).toHaveText("回到上傳");
    const noticeScroll = page.locator(".idv-task-scroll");
    expect(await noticeScroll.evaluate((node) => node.scrollHeight > node.clientHeight + 8)).toBe(true);
    await fullyInViewport(page, page.getByTestId("idv-back-upload"));
    await noticeScroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await fullyInViewport(page, page.getByTestId("idv-back-upload"));
    const fullBottom = await page.getByTestId("idv-notice-full").evaluate((node) => node.getBoundingClientRect().bottom);
    const uploadTop = await page.getByTestId("idv-back-upload").evaluate((node) => node.getBoundingClientRect().top);
    expect(fullBottom).toBeLessThanOrEqual(uploadTop + 1);
    const notice = await page.locator("body").innerText();
    expect(notice).not.toContain("LINE");
    expect(notice).not.toContain("示範");
    expect(notice).not.toContain("測試模式");
  }
});
