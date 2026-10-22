import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const BANNED = ["收租", "收款", "欠租", "已收", "入帳", "房東", "代收", "轉付", "統一編號", "含稅", "本公司"];

test("manager records a partial payment, corrects it, and accountant reverses it", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.manager);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/rent/settlement?month=2099-01");
  await expect(page.getByTestId("nav-settlement")).toBeVisible();
  await expect(page.getByRole("heading", { name: "屋主結算" }).first()).toBeVisible();

  const surface = page.getByTestId("settlement-page");
  const text = await surface.innerText();
  for (const word of BANNED) expect(text, word).not.toContain(word);
  await expect(page.getByTestId("settlement-lead")).toContainText("租金由租客直接付給屋主");
  await expect(page.getByTestId("settlement-lead")).toContainText("款項到帳");
  await expect(page.getByTestId("settlement-direct")).toContainText("租客直接付給屋主");

  const bill = page.getByTestId("bill-row").filter({ hasText: "王小美" });
  await expect(bill.getByTestId("bill-unpaid")).toHaveText("NT$12,000");
  await bill.getByTestId("bill-paid-on").fill("2099-01-15");
  await bill.getByTestId("bill-amount").fill("4000");
  await bill.getByTestId("bill-method").selectOption("bank_transfer");
  await bill.getByTestId("bill-submit").click();
  await expect(bill.getByTestId("bill-unpaid")).toHaveText("NT$8,000");

  const owner = page.getByTestId("settlement-row").filter({ hasText: "陳建宏" });
  await expect(owner.getByTestId("settlement-rent")).toHaveText("NT$4,000");
  await expect(owner.getByTestId("settlement-fee")).toHaveText("NT$320");
  await expect(owner.getByTestId("settlement-net")).toHaveText("NT$3,680");
  await expect(page.getByTestId("payment-row").filter({ hasText: "已繳" })).toBeVisible();
  await expect(page.getByTestId("reverse-bill-disabled")).toBeVisible();

  const payment = page.locator("[data-testid=payment-row][data-status=confirmed]");
  await payment.getByTestId("correct-amount").fill("5000");
  await payment.getByTestId("correct-paid-on").fill("2099-01-20");
  await payment.getByTestId("correct-reason").fill("更正金額");
  await payment.getByTestId("correct-submit").click();
  await expect(bill.getByTestId("bill-unpaid")).toHaveText("NT$7,000");
  await expect(owner.getByTestId("settlement-rent")).toHaveText("NT$5,000");
  await expect(owner.getByTestId("settlement-fee")).toHaveText("NT$400");
  await expect(owner.getByTestId("settlement-net")).toHaveText("NT$4,600");

  const csv = await page.request.get("/m/rent/settlement/export?month=2099-01");
  expect(csv.ok()).toBeTruthy();
  const csvText = await csv.text();
  expect(csvText).toContain("已繳租金");
  expect(csvText).toContain("陳建宏");
  expect(csvText).toContain("5000");
  expect(csvText).toContain("400");
  expect(csvText).toContain("4600");
  for (const word of BANNED) expect(csvText, word).not.toContain(word);

  const ownerId = await owner.getAttribute("data-owner");
  const pdf = await page.request.get(`/api/pdf/settlements?owner=${ownerId}&month=2099-01&currency=TWD`);
  expect(pdf.ok()).toBeTruthy();
  const doc = (await pdf.json()) as { title: string; blocks: unknown };
  expect(doc.title).toBe("屋主月結報表");
  const rendered = JSON.stringify(doc);
  expect(rendered).toContain("NT$5,000");
  expect(rendered).toContain("NT$400");
  expect(rendered).toContain("陳建宏");

  await signIn(page, ACCOUNTS.accountant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/rent/settlement?month=2099-01");
  const confirmed = page.locator("[data-testid=payment-row][data-status=confirmed]");
  await confirmed.getByTestId("reverse-bill-reason").fill("登錄錯誤");
  await confirmed.getByTestId("reverse-bill-submit").click();
  await expect(page.getByTestId("bill-row").filter({ hasText: "王小美" }).getByTestId("bill-unpaid")).toHaveText("NT$12,000");
  await expect(owner.getByTestId("settlement-rent")).toHaveText("NT$0");
  await expect(owner.getByTestId("settlement-fee")).toHaveText("NT$0");
  await expect(owner.getByTestId("settlement-net")).toHaveText("NT$0");
  const reversed = page.locator("[data-testid=payment-row][data-status=reversed]");
  await expect(reversed).toHaveCount(2);
  await expect(reversed.filter({ hasText: "2099-01-20" })).toContainText("已沖銷");
});
