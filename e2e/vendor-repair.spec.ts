import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("a manager dispatches a repair, the vendor reports, and the cost is charged to the owner", async ({ page }) => {
  await resetDemo(page);
  const title = `師傅到府${Date.now()}`;
  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/t/repair");
  await page.getByTestId("repair-title").fill(title);
  await page.getByTestId("submit-repair").click();
  await expect(page.getByTestId("tenant-repairs")).toContainText(title);

  await signIn(page, ACCOUNTS.admin);
  await page.goto("/m/tickets");
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page.getByTestId("vendor-dispatch")).toBeVisible();
  await page.getByTestId("vendor-add").click();
  await page.getByTestId("vendor-name").fill("陳水電");
  await page.getByTestId("vendor-trade").fill("水電");
  await page.getByTestId("vendor-phone").fill("0912000111");
  await page.getByTestId("vendor-window").fill("週三 14:00-17:00");
  await page.getByTestId("vendor-dispatch-send").click();
  const link = await page.getByTestId("vendor-link").inputValue();
  expect(link).toContain("/v/");
  const ticketUrl = page.url();
  const property = (await page.getByTestId("repair-property").textContent())?.trim() || "";
  expect(property.length).toBeGreaterThan(0);

  await page.context().clearCookies();
  await page.goto("/v/not-a-token");
  await expect(page.getByTestId("vendor-closed")).toHaveText("這個連結已失效");
  await expect(page.getByTestId("vendor-issue")).toHaveCount(0);

  await page.goto(link);
  await expect(page.getByTestId("vendor-issue")).toHaveText(title);
  await expect(page.getByTestId("vendor-window-view")).toHaveText("週三 14:00-17:00");
  await expect(page.getByTestId("vendor-address")).not.toBeEmpty();
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUQEhIVFhUVFRUVFRUVFRUVFRUWFxUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGhAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAMBAAMBIgACEQEDEQH/xAAbAAACAgMBAAAAAAAAAAAAAAADBAECBQYAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJr0X/9k=",
    "base64",
  );
  await page.getByTestId("vendor-photo").setInputFiles({ name: "done.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.getByTestId("vendor-done-photo")).toBeVisible();
  await page.getByTestId("vendor-done").check();
  await page.getByTestId("vendor-cost").fill("2400");
  await page.getByTestId("vendor-submit").click();
  await expect(page.getByTestId("vendor-sent")).toBeVisible();

  await signIn(page, ACCOUNTS.admin);
  await page.goto(ticketUrl);
  await expect(page.getByTestId("vendor-reported")).toContainText("2,400");
  await page.getByTestId("vendor-confirm").click();
  await expect(page.getByTestId("vendor-confirmed")).toBeVisible();

  await page.goto("/m/expenses");
  const expense = page.getByTestId("expense-row").filter({ hasText: title });
  await expect(expense).toHaveAttribute("data-status", "posted");
  await expect(expense).toHaveAttribute("data-included", "true");
  await expect(expense).toContainText("NT$2,400");
  await expect(expense).toContainText("已記帳");
  await expect(expense).toContainText("計入屋主報表");

  await page.goto("/m/reports");
  await expect(page.getByTestId("report-list")).toContainText(property);
});
