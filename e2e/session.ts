import { expect, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "Demo1234";

export const ACCOUNTS = {
  admin: "yating.lin@songxin.demo",
  manager: "zhiming.huang@songxin.demo",
  accountant: "meiling.zhou@songxin.demo",
  maintenance: "dawei.wu@songxin.demo",
  tenant: "yawen.zhang@tenant.demo",
  tenant2: "xiaomei.wang@tenant.demo",
  owner: "jianhong.chen@owner.demo",
} as const;

export async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(DEMO_PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/api/env?set=live&next=/m");
}

export async function resetDemo(page: Page) {
  await signIn(page, ACCOUNTS.admin);
  const response = await page.request.post("/api/demo/reset");
  expect(response.ok()).toBeTruthy();
  await signIn(page, ACCOUNTS.admin);
}
