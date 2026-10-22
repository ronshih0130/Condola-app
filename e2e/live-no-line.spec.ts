import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const SUPPORT = "LINE @644odqoe（租多啦官方客服帳號）";

async function expectNoProductLine(page: Page) {
  let text = await page.locator("body").innerText();
  for (const bit of await page.locator("[data-demo-line]").allInnerTexts()) {
    if (bit) text = text.split(bit).join("");
  }
  expect(text.split(SUPPORT).join("")).not.toContain("LINE");
}

async function expectLiveSurface(page: Page) {
  await expect(page.locator("[data-demo-line]")).toHaveCount(0);
  await expectNoProductLine(page);
}

test("live pages do not mention LINE except the support contact", async ({ page }) => {
  await page.goto("/api/demo/locale?set=zh-TW&next=/login");
  await expect(page.getByTestId("login-footer")).toBeVisible();
  await expectNoProductLine(page);

  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m");
  await expect(page.getByTestId("app-footer")).toBeVisible();
  await expectLiveSurface(page);

  await page.goto("/m/notify");
  const notify = page.getByTestId("line-notify");
  await expect(notify).toBeVisible();
  await expect(page.getByTestId("line-notify-banner")).toBeVisible();
  const notifyText = await notify.innerText();
  const aroundNotify = (await page.locator("body").innerText()).split(notifyText).join("");
  expect(aroundNotify).not.toContain("LINE");
  await expect(page.locator("body")).not.toContainText("@644odqoe");
  await expect(page.locator("body")).not.toContainText("官方客服");

  await page.goto("/m/account");
  await expectLiveSurface(page);

  await page.goto("/m/leases/new");
  const room = page.getByTestId("lease-room");
  await expect(room).toBeVisible();
  const roomValue = await room.evaluate((select) => {
    const options = [...(select as HTMLSelectElement).options];
    return (options.find((option) => option.value && option.text.includes("信義松仁")) ?? options.find((option) => option.value))?.value ?? "";
  });
  expect(roomValue).toBeTruthy();
  await room.selectOption(roomValue);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("tenant-name")).toBeVisible();
  await expect(page.getByTestId("tenant-line")).toHaveCount(0);
  await expectLiveSurface(page);

  await page.goto("/m/team");
  if (await page.getByTestId("invite-email").count()) {
    await page.getByTestId("invite-email").fill(`live-line-${Date.now()}@example.com`);
    await page.getByTestId("invite-name").fill("測試邀請");
    await page.locator("form").filter({ has: page.getByTestId("invite-email") }).locator("button[type=submit]").click();
    const link = page.getByTestId("invite-link");
    if (await link.isVisible().catch(() => false)) {
      const token = (await link.innerText()).match(/\/accept\/([^?\s]+)/)?.[1];
      if (token) await page.goto(`/accept/${decodeURIComponent(token)}`);
    }
  }
  if (!page.url().includes("/accept/")) await page.goto("/accept/not-a-real-token");
  await expect(page.locator("h1")).toBeVisible();
  await expectNoProductLine(page);

  await signIn(page, ACCOUNTS.tenant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  await expect(page.getByTestId("liff-frame")).toBeVisible();
  if (await page.getByTestId("lease-picker").count()) {
    await expect(page.getByTestId("line-link-panel")).toHaveCount(0);
    await expectLiveSurface(page);
    await page.getByRole("button", { name: /松信/ }).click();
    await expect(page.getByTestId("lease-picker")).toHaveCount(0);
  }
  await expect(page.getByTestId("line-link-panel")).toHaveCount(0);
  await expect(page.getByTestId("line-notify")).toHaveCount(0);
  await expectLiveSurface(page);
  await expect(page.locator("body")).not.toContainText("@644odqoe");
  await expect(page.locator("body")).not.toContainText("官方客服");

  await page.goto("/t/messages");
  await expect(page.getByRole("heading", { name: "聯絡管理員" })).toBeVisible();
  await expectLiveSurface(page);

  await page.goto("/t/lease");
  await expect(page.getByRole("heading", { name: "我的租約" })).toBeVisible();
  await expectLiveSurface(page);
});
