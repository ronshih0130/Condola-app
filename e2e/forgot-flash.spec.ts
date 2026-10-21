import { expect, test } from "@playwright/test";

test("a reset request shows the same sentence without putting the email in the URL", async ({ page }) => {
  const email = "meiling.zhou@songxin.demo";
  await page.goto("/forgot");
  await page.getByTestId("forgot-email").fill(email);
  await page.getByRole("button", { name: /寄送重設連結|Send reset link/ }).click();
  const sent = page.getByTestId("forgot-sent");
  await expect(sent).toContainText("如果這個 Email 有租多啦帳號，重設連結已寄出，請於 60 分鐘內使用。沒收到請檢查垃圾郵件。");
  await expect(sent).not.toContainText(email);
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
