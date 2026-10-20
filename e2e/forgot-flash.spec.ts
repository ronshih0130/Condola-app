import { expect, test } from "@playwright/test";

test("a reset request shows the email without putting it in the URL", async ({ page }) => {
  const email = "meiling.zhou@songxin.demo";
  await page.goto("/forgot");
  await page.getByTestId("forgot-email").fill(email);
  await page.getByRole("button", { name: /寄出重設連結|Send reset link/ }).click();
  await expect(page.getByTestId("forgot-sent")).toContainText(email);
  expect(page.url()).not.toContain(email);
  expect(page.url()).not.toContain("email=");
  await expect
    .poll(async () => {
      const cookies = await page.context().cookies();
      return cookies.some((cookie) => cookie.name === "condola_reset_flash");
    })
    .toBe(false);
  await page.reload();
  await expect(page.getByTestId("forgot-email")).toBeVisible();
  await expect(page.getByTestId("forgot-sent")).toHaveCount(0);
  expect(page.url()).not.toContain(email);
});
