import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
});

test("an accountant can open tickets and cannot change them", async ({ page }) => {
  await signIn(page, ACCOUNTS.accountant);
  await page.goto("/m/tickets");
  await expect(page).toHaveURL(/\/m\/tickets$/);
  await expect(page.locator('a[href="/m/tickets"]')).toBeVisible();
  await expect(page.getByTestId("ticket-update-disabled").first()).toBeDisabled();
  await expect(page.getByTestId("ticket-create-disabled")).toBeDisabled();
  await expect(page.getByText(/需要以下角色|Needs one of these roles/)).toBeVisible();
});

test("deactivating a member asks for confirmation and sign-in times use Taipei", async ({ page }) => {
  await signIn(page, ACCOUNTS.maintenance);
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=en&next=/m/team");
  const signedIn = page.getByTestId(`last-sign-in-${ACCOUNTS.maintenance}`);
  await expect(signedIn).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  await page.getByTestId(`deactivate-${ACCOUNTS.maintenance}`).click();
  await expect(page.getByTestId(`deactivate-confirm-${ACCOUNTS.maintenance}`)).toBeVisible();
  await page.getByTestId(`deactivate-confirm-${ACCOUNTS.maintenance}`).click();
  await expect(page.getByRole("button", { name: "Reactivate" })).toBeVisible();
  await expect(page.getByTestId(`deactivate-${ACCOUNTS.maintenance}`)).toHaveCount(0);
});
