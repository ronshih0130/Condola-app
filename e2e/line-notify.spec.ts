import { createHmac } from "node:crypto";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const SECRET = "e2e-line-secret";
const LINE_USER = `U${"c".repeat(32)}`;
const TENANT_LINE = `U${"a".repeat(32)}`;
const MOCK = "http://127.0.0.1:4601";
const ORG = "10000000-0000-4000-8000-000000000001";
const ADMIN = "20000000-0000-4000-8000-000000000001";
const BANNED = ["入帳", "欠租", "代收", "本公司", "收租", "收款", "已收", "644odqoe", "NT$", "王小美", "1000", "1,000", "12,000"];

function sign(body: string) {
  return createHmac("sha256", SECRET).update(body).digest("base64");
}

async function withDb<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
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

test("staff can link LINE, save prefs, and a payment notice stays free of personal data", async ({ page }) => {
  const reset = await page.request.post(`${MOCK}/reset`);
  expect(reset.ok()).toBeTruthy();
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/notify");

  await expect(page.getByTestId("line-notify-banner")).toHaveText(
    "LINE 通知還沒上線。你可以先完成設定，上線後才會開始發送；在那之前，通知只會透過 Email 和站內通知送出。",
  );
  await expect(page.getByTestId("line-link-status")).toHaveText("尚未連結");
  await expect(page.getByTestId("line-notify-toggles")).toContainText("連結 LINE 後就能選擇");
  await expect(page.getByRole("checkbox", { name: /修繕進度更新/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /繳租提醒/ })).toBeChecked();

  await page.getByTestId("line-link-open").click();
  await expect(page.getByTestId("line-link-dialog")).toContainText("LINE 綁定碼 10 分鐘內有效");
  await expect(page.getByTestId("line-link-dialog")).toContainText("2 傳送LINE 綁定碼");
  const code = page.getByTestId("line-link-code");
  await expect(code).toBeVisible();
  const linkCode = (await code.innerText()).trim();
  expect(linkCode).toMatch(/^[0-9]{6}$/);
  const qr = await page.getByTestId("line-link-qr").getAttribute("src");
  expect(qr?.startsWith("data:image/svg+xml")).toBeTruthy();
  expect(qr).not.toContain("644odqoe");

  await withDb((client) =>
    client.query(`UPDATE line_link_codes SET expires_at = now() - interval '1 minute' WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL`, [
      ORG,
      ADMIN,
    ]),
  );
  await page.goto("/m/notify?link=1");
  await expect(page.getByTestId("line-link-error")).toHaveText("LINE 綁定碼已過期或不正確，請重新取得LINE 綁定碼。");

  await page.getByTestId("line-link-retry").click();
  const fresh = (await page.getByTestId("line-link-code").innerText()).trim();
  expect(fresh).toMatch(/^[0-9]{6}$/);
  const payload = JSON.stringify({
    events: [{ type: "message", replyToken: "reply-qa", source: { userId: LINE_USER }, message: { type: "text", text: `綁定 ${fresh}` } }],
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
  await expect(page.getByTestId("line-link-status")).toHaveText("LINE 已連結", { timeout: 15_000 });
  await expect(page.getByText(/連結於 \d{4}-\d{2}-\d{2}/)).toBeVisible();
  const afterLink = await pushes(page);
  expect(afterLink.replies[0]?.text).toBe("已連結。之後的提醒會送到這裡。");
  expect(afterLink.pushes).toEqual([]);

  await page.getByRole("checkbox", { name: /修繕進度更新/ }).check();
  await page.getByTestId("line-notify-save").click();
  await expect(page.getByTestId("line-notify-saved")).toHaveText("已儲存通知設定。");
  await page.getByTestId("line-preview-open").click();
  const preview = page.getByTestId("line-preview-dialog");
  await expect(preview).toContainText("有一筆租金快到期了，請登入查看。");
  await expect(preview).toContainText("有一筆租金還沒登記為已繳，請登入查看。");
  await expect(preview).toContainText("有租約快到期了，請登入安排續約或退租。");
  await expect(preview).toContainText("預覽僅供參考；LINE 通知上線後才會發送。");
  await expect(preview).not.toContainText("王小美");
  await expect(preview).not.toContainText("NT$");
  await page.getByRole("button", { name: "取消" }).click();

  const unfollow = JSON.stringify({ events: [{ type: "unfollow", source: { userId: LINE_USER } }] });
  const blocked = await page.request.post("/api/line/webhook", {
    data: unfollow,
    headers: { "content-type": "application/json", "x-line-signature": sign(unfollow) },
  });
  expect(blocked.status()).toBe(200);
  await page.goto("/m/notify");
  await expect(page.getByTestId("line-link-blocked")).toHaveText("LINE 連結已失效（官方帳號被封鎖）。請解除封鎖後重新連結。");
  const follow = JSON.stringify({ events: [{ type: "follow", source: { userId: LINE_USER } }] });
  await page.request.post("/api/line/webhook", {
    data: follow,
    headers: { "content-type": "application/json", "x-line-signature": sign(follow) },
  });
  await page.goto("/m/notify");
  await expect(page.getByTestId("line-link-blocked")).toBeVisible();

  await withDb((client) =>
    client.query(
      `INSERT INTO line_link_codes (org_id, user_id, code, expires_at, used_at)
       SELECT $1, $2, lpad(g::text, 6, '0'), now() + interval '10 minutes', now()
         FROM generate_series(1, 5) g`,
      [ORG, ADMIN],
    ),
  );
  await page.getByTestId("line-link-open").click();
  await expect(page.getByTestId("line-code-limit")).toHaveText("LINE 綁定碼重新取得次數已達上限，請稍後再試。");

  await withDb((client) =>
    client.query(`UPDATE organizations SET feature_flags = feature_flags || '{"line_live": true}'::jsonb WHERE id = $1`, [ORG]),
  );
  await page.goto("/m/notify");
  await expect(page.getByTestId("line-notify-banner")).toHaveCount(0);

  await recordStaffPayment(page);
  await expect.poll(async () => (await pushes(page)).pushes.length).toBe(1);
  const sent = (await pushes(page)).pushes[0];
  expect(sent.to).toBe(TENANT_LINE);
  expect(sent.hasAuth).toBe(true);
  expect(sent.text).toMatch(/^款項到帳。請查看：https?:\/\/[^?\s]+\/t\/pay$/);
  for (const word of BANNED) expect(sent.text, word).not.toContain(word);

  await withDb((client) =>
    client.query(`UPDATE contacts SET line_notify_opt_out = true WHERE org_id = $1 AND display_name = '王小美'`, [ORG]),
  );
  await recordStaffPayment(page);
  expect((await pushes(page)).pushes).toHaveLength(1);

  await page.goto("/");
  await expect(page.getByTestId("line-notify")).toHaveCount(0);
  await page.goto("/pricing");
  await expect(page.getByTestId("line-notify")).toHaveCount(0);
  await signIn(page, ACCOUNTS.tenant2);
  for (const path of ["/t", "/t/pay", "/t/lease", "/t/messages"]) {
    await page.goto(`/api/demo/locale?set=zh-TW&next=${path}`);
    await expect(page.getByTestId("line-link-panel")).toHaveCount(0);
    await expect(page.getByTestId("line-notify")).toHaveCount(0);
    const text = await page.locator("body").innerText();
    expect(text, path).not.toContain("LINE");
    expect(text, path).not.toContain("644odqoe");
  }
});
