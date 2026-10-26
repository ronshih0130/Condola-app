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

/** Seeded demo users have table consent; fresh invitees may still need the gate. */
export async function finishConsentGate(page: Page) {
  if (!new URL(page.url()).pathname.startsWith("/consent")) return;
  await page.getByTestId("consent-check").check();
  await page.getByTestId("consent-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/consent"));
}

/**
 * Portal invites pass through /t or /o before the layout redirects to the
 * consent gate. Wait until the checkbox or the destination landmark is
 * actually on screen, then tick the gate if it is the one that showed up.
 */
export async function waitPastConsent(page: Page, readyTestId: string) {
  const gate = page.getByTestId("consent-check");
  const ready = page.getByTestId(readyTestId);
  const gateShown = gate.waitFor({ state: "visible" }).then(() => "gate" as const);
  const readyShown = ready.waitFor({ state: "visible" }).then(() => "ready" as const);
  gateShown.catch(() => undefined);
  readyShown.catch(() => undefined);
  const which = await Promise.race([gateShown, readyShown]);
  if (which === "gate") {
    await gate.check();
    await page.getByTestId("consent-submit").click();
    await ready.waitFor({ state: "visible" });
  }
}

export async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(DEMO_PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login") && url.pathname !== "/auth/enter" && !url.pathname.startsWith("/api/auth/enter"));
  await finishConsentGate(page);
  await page.goto("/api/env?set=live&next=/m");
  await finishConsentGate(page);
}

export async function resetDemo(page: Page) {
  await signIn(page, ACCOUNTS.admin);
  const response = await page.request.post("/api/demo/reset");
  expect(response.ok()).toBeTruthy();
  await signIn(page, ACCOUNTS.admin);
}
