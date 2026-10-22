import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const SECRET = "e2e-line-secret";
const LINE_USER = `U${"c".repeat(32)}`;
const MOCK = "http://127.0.0.1:4601";
const BANNED = ["入帳", "欠租", "代收", "本公司", "收租", "收款", "已收", "644odqoe", "NT$", "王小美", "1000", "1,000", "12,000"];

function sign(body: string) {
  return createHmac("sha256", SECRET).update(body).digest("base64");
}

async function pushes(page: Page) {
  const response = await page.request.get(`${MOCK}/pushes`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    pushes: { to: string; text: string; hasAuth: boolean }[];
    replies: { replyToken: string; text: string; hasAuth: boolean }[];
  };
}

async function recordStaffPayment(page: Page) {
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m");
  await page.goto(`/m/leases?q=${encodeURIComponent("王小美")}`);
  const lease = page.getByRole("link", { name: "王小美" }).first();
  await expect(lease).toBeVisible();
  await lease.click();
  await page.locator(".tabsx a[href*='tab=ledger']").click();
  await expect(page.getByTestId("record-payment")).toHaveText("登錄繳款");
  await page.getByTestId("record-payment").click();
  await page.getByTestId("pay-amount").fill("1000");
  await page.getByTestId("pay-last5").fill("12345");
  await page.getByTestId("submit-payment").click();
  await expect(page).not.toHaveURL(/error=/);
  await expect(page.getByTestId("record-payment")).toBeVisible();
}

test("a tenant links LINE and a recorded payment pushes only the notice", async ({ page }) => {
  const reset = await page.request.post(`${MOCK}/reset`);
  expect(reset.ok()).toBeTruthy();
  await resetDemo(page);

  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  const panel = page.getByTestId("line-link-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("用 LINE 接收繳款提醒");
  await expect(page.getByTestId("line-linked")).toBeVisible();
  await page.getByTestId("line-link-new").click();
  const code = page.getByTestId("line-link-code");
  await expect(code).toBeVisible();
  const linkCode = (await code.innerText()).trim();
  expect(linkCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  const qr = await page.getByTestId("line-link-qr").getAttribute("src");
  expect(qr?.startsWith("data:image/svg+xml")).toBeTruthy();
  expect(qr).not.toContain("644odqoe");
  await expect(page.locator("body")).not.toContainText("@644odqoe");
  await expect(page.locator("body")).not.toContainText("官方客服");

  const payload = JSON.stringify({
    events: [
      {
        type: "message",
        replyToken: "reply-qa",
        source: { userId: LINE_USER },
        message: { type: "text", text: `綁定 ${linkCode}` },
      },
    ],
  });
  const bad = await page.request.post("/api/line/webhook", {
    data: payload,
    headers: { "content-type": "application/json", "x-line-signature": "bm9wZQ==" },
  });
  expect(bad.status()).toBe(401);

  const linked = await page.request.post("/api/line/webhook", {
    data: payload,
    headers: { "content-type": "application/json", "x-line-signature": sign(payload) },
  });
  expect(linked.status()).toBe(200);
  const afterLink = await pushes(page);
  expect(afterLink.replies).toEqual([
    { replyToken: "reply-qa", text: "已連結。之後的繳款提醒會送到這裡。", hasAuth: true },
  ]);
  expect(afterLink.pushes).toEqual([]);

  await recordStaffPayment(page);
  await expect.poll(async () => (await pushes(page)).pushes.length).toBe(1);
  const sent = (await pushes(page)).pushes[0];
  expect(sent.to).toBe(LINE_USER);
  expect(sent.hasAuth).toBe(true);
  expect(sent.text).toMatch(/^款項到帳。請查看：https?:\/\/[^?\s]+\/t\/pay$/);
  for (const word of BANNED) expect(sent.text, word).not.toContain(word);

  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  await page.getByTestId("line-opt-out").click();
  await expect(page.getByTestId("line-opt-out-note")).toContainText("已關閉 LINE 提醒。未繳租金改以電子郵件通知。");

  await recordStaffPayment(page);
  expect((await pushes(page)).pushes).toHaveLength(1);

  await page.goto("/");
  await expect(page.getByTestId("line-link-panel")).toHaveCount(0);
  await page.goto("/pricing");
  await expect(page.getByTestId("line-link-panel")).toHaveCount(0);

  await signIn(page, ACCOUNTS.tenant2);
  for (const path of ["/t/pay", "/t/lease", "/t/messages"]) {
    await page.goto(`/api/demo/locale?set=zh-TW&next=${path}`);
    await expect(page.getByTestId("line-link-panel")).toHaveCount(0);
    const text = await page.locator("body").innerText();
    expect(text, path).not.toContain("LINE");
    expect(text, path).not.toContain("644odqoe");
  }
});
