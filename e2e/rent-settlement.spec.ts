import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const BANNED = ["收租", "收款", "欠租", "已收", "入帳", "房東", "代收", "轉付", "統一編號", "含稅", "本公司", "撥款", "平台轉付"];

test("manager records a payment, a duplicate warns, and an accountant reverses it", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.manager);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/payments");
  await expect(page.getByRole("heading", { name: "繳租紀錄" })).toBeVisible();
  await expect(page.getByText("Condola 只提供管理軟體，不經手任何款項。").first()).toBeVisible();
  const pageText = await page.locator("main, .main").innerText();
  for (const word of BANNED) expect(pageText, word).not.toContain(word);

  async function chooseWang() {
    const value = await page.locator("[data-testid=rent-lease] option", { hasText: "王小美" }).first().getAttribute("value");
    await page.getByTestId("rent-lease").selectOption(value ?? "");
  }

  await page.getByTestId("register-rent").click();
  await chooseWang();
  await page.getByTestId("rent-kind").selectOption("rent");
  await page.getByTestId("rent-period").fill("2026-10");
  await page.getByTestId("rent-amount").fill("4000");
  await page.getByTestId("rent-date").fill("2026-10-22");
  await page.getByTestId("rent-payee").selectOption("owner");
  await page.getByTestId("rent-save").click();
  const list = page.getByTestId("payment-list");
  await expect(list.getByText("已登記").first()).toBeVisible();
  await expect(list.getByText("尚未繳").first()).toBeVisible();
  await expect(list.getByText("NT$8,000").first()).toBeVisible();
  await expect(page.getByTestId("reverse-payment").first()).toBeDisabled();

  await page.getByTestId("register-rent").click();
  await chooseWang();
  await page.getByTestId("rent-kind").selectOption("rent");
  await page.getByTestId("rent-period").fill("2026-10");
  await page.getByTestId("rent-amount").fill("4000");
  await page.getByTestId("rent-date").fill("2026-10-22");
  await page.getByTestId("rent-payee").selectOption("owner");
  await page.getByTestId("rent-save").click();
  await expect(page.getByTestId("duplicate-hint")).toContainText("如果是分次匯款，可以繼續儲存");

  await signIn(page, ACCOUNTS.accountant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/payments?month=2026-10");
  const row = page.locator("tr", { hasText: "王小美" }).filter({ hasText: "NT$4,000" }).first();
  await row.getByTestId("reverse-reason").fill("重複登記");
  await row.getByRole("button", { name: "確定撤銷" }).click();
  await expect(page.getByTestId("payment-list").getByText("已撤銷").first()).toBeVisible();
  await expect(page.getByTestId("payment-list").getByText("撤銷原因：重複登記").first()).toBeVisible();

  await page.goto("/m/statements");
  await expect(page.getByRole("heading", { name: "屋主結算" })).toBeVisible();
  await page.getByTestId("owner-owes").first().locator("xpath=ancestor::tr").locator("a.btn").first().click();
  await expect(page.getByTestId("statement-document")).toContainText("期初餘額");
  await expect(page.getByTestId("statement-document")).toContainText("期末餘額");
  await expect(page.getByTestId("statement-document")).toContainText("管理公司匯給屋主");
  await expect(page.getByTestId("statement-footer")).toContainText("押金不計入淨額。此表僅供紀錄與對帳。Condola 只提供管理軟體，不經手任何款項。");
  await expect(page.getByTestId("owner-owes")).toContainText("本期淨額為負");
  await expect(page.getByTestId("owner-owes")).toContainText("−NT$2,800");
  await expect(page.getByTestId("statement-closing")).toBeVisible();
  await expect(page.getByTestId("statement-closing")).toHaveText("−NT$2,800");
  await expect(page.getByTestId("owner-owes-reason")).toHaveText(
    "⚠ 本月費用高於已登記租金，屋主淨額為 −NT$2,800。費用怎麼處理，請和屋主確認。",
  );
  const statementText = await page.getByTestId("statement-document").innerText();
  expect(statementText).not.toContain("差額請屋主補繳");
  expect(statementText).not.toContain("屋主應補繳");
  expect(statementText).not.toContain("-NT$");
  expect(statementText).not.toContain("電費（空房");
  expect(statementText).not.toContain("電子發票");
});
