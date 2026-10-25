import { expect, test } from "@playwright/test";

test("signup explains who it is for and verification can be resent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/signup");
  await expect(page.getByTestId("signup-audience")).toHaveText("給管理出租物件的管理方與屋主。");
  await expect(page.getByTestId("signup-free-seat")).toHaveText("前 4 戶免費，含 1 個席次。");
  await expect(page.getByTestId("signup-software-only")).toHaveText("只提供管理軟體，不經手任何款項。");
  await expect(page.getByTestId("signup-invited-owner")).toContainText("已收到管理方邀請的屋主");
  await expect(page.getByTestId("signup-invited-login")).toHaveAttribute("href", "/login");
  await page.screenshot({ path: "test-results/signup-1280.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("signup-software-only")).toBeVisible();
  await expect(page.getByTestId("signup-invited-login")).toBeVisible();
  await page.screenshot({ path: "test-results/signup-390.png", fullPage: true });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/signup/verify?email=owner%40example.com");
  await expect(page.getByTestId("signup-resend")).toHaveText("重寄驗證信");
  await expect(page.getByTestId("signup-resend")).toBeEnabled();

  await page.goto("/signup/verify?email=owner%40example.com&resent=1&wait=2");
  await expect(page.getByTestId("resend-success")).toContainText("驗證信已重寄");
  await expect(page.getByTestId("signup-resend")).toBeDisabled();
  await expect(page.getByTestId("signup-resend")).toContainText("秒後可重寄驗證信");
  await expect(page.getByTestId("signup-resend")).toHaveText("重寄驗證信", { timeout: 10_000 });
  await expect(page.getByTestId("signup-resend")).toBeEnabled();

  await page.goto("/signup/verify?email=owner%40example.com&resent=error");
  await expect(page.getByTestId("resend-error")).toContainText("無法寄出");

  await page.goto("/signup/verify?email=owner%40example.com&resent=wait&wait=60");
  await expect(page.getByTestId("resend-wait")).toContainText("稍候");
  await expect(page.getByTestId("signup-resend")).toBeDisabled();
  await page.screenshot({ path: "test-results/verify-resend-1280.png", fullPage: true });

  await page.goto("/login?error=unconfirmed&email=owner%40example.com");
  await expect(page.getByTestId("login-unconfirmed")).toContainText("請先到信箱確認電子郵件");
  await expect(page.getByTestId("login-resend")).toHaveText("重寄驗證信");
  await page.screenshot({ path: "test-results/login-unconfirmed-1280.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login?error=unconfirmed&email=owner%40example.com&resent=1&wait=60");
  await expect(page.getByTestId("resend-success")).toBeVisible();
  await expect(page.getByTestId("login-resend")).toBeDisabled();
  await page.screenshot({ path: "test-results/login-unconfirmed-390.png", fullPage: true });
});
