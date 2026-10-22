import { createHmac } from "node:crypto";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { resetDemo } from "./session";

const SECRET = "e2e-line-secret";
const LINE_USER = `U${"d".repeat(32)}`;
const MOCK = "http://127.0.0.1:4601";
const ORG = "10000000-0000-4000-8000-000000000001";
const ADMIN = "20000000-0000-4000-8000-000000000001";
const RENT = "有一筆租金快到期了，請登入查看。";
const OVERDUE = "有一筆租金還沒登記為已繳，請登入查看。";
const LEASE = "有租約快到期了，請登入安排續約或退租。";
const BANNED = ["王小美", "張雅文", "林雅婷", "NT$", "12,000", "28,000", "府後街", "入帳", "欠租", "收租", "收款", "已收", "代收", "驗證碼"];

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
  return (await response.json()) as { pushes: { to: string; text: string; hasAuth: boolean }[] };
}

test("LINE reminders go out 3 days before rent, on the due day, 3 days overdue, and 60 and 30 days before a lease ends", async ({ page }) => {
  expect((await page.request.post(`${MOCK}/reset`)).ok()).toBeTruthy();
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/notify");
  await page.getByTestId("line-link-open").click();
  const code = (await page.getByTestId("line-link-code").innerText()).trim();
  expect(code).toMatch(/^[0-9]{6}$/);
  const payload = JSON.stringify({
    events: [{ type: "message", replyToken: "reply-schedule", source: { userId: LINE_USER }, message: { type: "text", text: code } }],
  });
  const linked = await page.request.post("/api/line/webhook", {
    data: payload,
    headers: { "content-type": "application/json", "x-line-signature": sign(payload) },
  });
  expect(linked.status()).toBe(200);
  await expect(page.getByTestId("line-link-status")).toHaveText("LINE 已連結", { timeout: 15_000 });

  await withDb(async (client) => {
    await client.query(
      `UPDATE invoices
          SET due_date = (timezone('Asia/Taipei', now()))::date - 40
        WHERE status IN ('open', 'partially_paid')`,
    );
    await client.query(
      `UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date + 3 WHERE invoice_number = 'INV-SEED-001'`,
    );
    await client.query(
      `UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date WHERE invoice_number = 'INV-SEED-003'`,
    );
    await client.query(
      `UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date - 3 WHERE invoice_number = 'INV-SEED-004'`,
    );
    await client.query(`UPDATE leases SET end_date = (timezone('Asia/Taipei', now()))::date + 400 WHERE status = 'active'`);
    await client.query(
      `WITH picked AS (
         SELECT id, row_number() OVER (ORDER BY created_at) AS n
           FROM leases
          WHERE org_id = $1 AND status = 'active'
       )
       UPDATE leases l
          SET end_date = (timezone('Asia/Taipei', now()))::date + CASE
                WHEN p.n = 1 THEN 60
                WHEN p.n = 2 THEN 30
                WHEN p.n = 3 THEN 7
                ELSE 400
              END
         FROM picked p
        WHERE l.id = p.id`,
      [ORG],
    );
    const linkedRow = await client.query(`SELECT status FROM line_user_links WHERE org_id = $1 AND user_id = $2`, [ORG, ADMIN]);
    expect(linkedRow.rows[0]?.status).toBe("linked");
    const live = await client.query<{ line_live: string | null }>(
      `SELECT feature_flags->>'line_live' AS line_live FROM organizations WHERE id = $1`,
      [ORG],
    );
    expect(live.rows[0]?.line_live ?? null).not.toBe("true");
  });

  const held = await page.request.post("/api/cron/reminders", { headers: { "x-cron-secret": "e2e-cron-secret" } });
  expect(held.ok()).toBeTruthy();
  expect((await pushes(page)).pushes).toEqual([]);

  await withDb((client) =>
    client.query(`UPDATE organizations SET feature_flags = feature_flags || '{"line_live": true}'::jsonb WHERE id = $1`, [ORG]),
  );
  const cron = await page.request.post("/api/cron/reminders", { headers: { "x-cron-secret": "e2e-cron-secret" } });
  expect(cron.ok()).toBeTruthy();
  const sent = (await pushes(page)).pushes;
  const origin = "http://127.0.0.1:43123";
  const rent = sent.filter((item) => item.text === `${RENT} ${origin}/m/rent`);
  const overdue = sent.filter((item) => item.text === `${OVERDUE} ${origin}/m/rent`);
  const lease = sent.filter((item) => item.text === `${LEASE} ${origin}/m/leases`);
  expect(rent).toHaveLength(2);
  expect(overdue).toHaveLength(1);
  expect(lease).toHaveLength(2);
  expect(sent).toHaveLength(5);
  for (const item of sent) {
    expect(item.to).toBe(LINE_USER);
    expect(item.hasAuth).toBe(true);
    expect(item.text).not.toContain("?");
    expect(item.text).not.toContain("#");
    expect(item.text).not.toContain("LINE");
    const sentence = item.text.replace(/ https?:\/\/\S+$/, "");
    expect(item.text).toBe(`${sentence} ${origin}${item.text.endsWith("/m/leases") ? "/m/leases" : "/m/rent"}`);
    expect(sentence).not.toMatch(/\d/);
    for (const word of BANNED) expect(item.text, word).not.toContain(word);
  }
});
