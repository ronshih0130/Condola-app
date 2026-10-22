import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { resetDemo } from "./session";

const MOCK = "http://127.0.0.1:4601";
const ORG = "10000000-0000-4000-8000-000000000001";
const ADMIN = "20000000-0000-4000-8000-000000000001";
const LINE_USER = `U${"e".repeat(32)}`;

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
  return (await response.json()) as { pushes: { text: string }[] };
}

async function cron(page: Page) {
  const response = await page.request.post("/api/cron/reminders", { headers: { "x-cron-secret": "e2e-cron-secret" } });
  expect(response.ok()).toBeTruthy();
}

async function armLive(client: Client) {
  await client.query(
    `INSERT INTO line_user_links (org_id, user_id, line_user_id, status, linked_at)
     VALUES ($1, $2, $3, 'linked', now())`,
    [ORG, ADMIN, LINE_USER],
  );
  await client.query(
    `UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date - 40 WHERE status IN ('open', 'partially_paid')`,
  );
  await client.query(`UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date + 3 WHERE invoice_number = 'INV-SEED-001'`);
  await client.query(`UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date WHERE invoice_number = 'INV-SEED-003'`);
  await client.query(`UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date - 3 WHERE invoice_number = 'INV-SEED-004'`);
  await client.query(`UPDATE leases SET end_date = (timezone('Asia/Taipei', now()))::date + 400 WHERE org_id = $1 AND status = 'active'`, [ORG]);
  await client.query(
    `WITH picked AS (
       SELECT id, row_number() OVER (ORDER BY created_at) AS n
         FROM leases
        WHERE org_id = $1 AND status = 'active'
     )
     UPDATE leases l
        SET end_date = (timezone('Asia/Taipei', now()))::date + CASE WHEN p.n = 1 THEN 60 ELSE 30 END
       FROM picked p
      WHERE l.id = p.id AND p.n <= 2`,
    [ORG],
  );
}

test("LINE sends wait for line_live, and only a beta firm or the sample company can open the feature", async ({ page }) => {
  expect((await page.request.post(`${MOCK}/reset`)).ok()).toBeTruthy();
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/notify");
  await expect(page.getByTestId("line-notify")).toBeVisible();
  await expect(page.getByTestId("line-notify-banner")).toBeVisible();

  await withDb(armLive);
  await cron(page);
  expect((await pushes(page)).pushes).toEqual([]);

  await withDb((client) =>
    client.query(
      `UPDATE organizations
          SET plan_tier = 'pro',
              feature_flags = feature_flags || '{"line_alerts": true, "line_live": true}'::jsonb
        WHERE id = $1`,
      [ORG],
    ),
  );
  await page.goto("/m/notify");
  await expect(page.getByTestId("notify-empty")).toHaveText("目前沒有通知");
  await expect(page.getByTestId("line-notify")).toHaveCount(0);
  await cron(page);
  expect((await pushes(page)).pushes).toEqual([]);

  await withDb((client) =>
    client.query(
      `UPDATE organizations
          SET plan_tier = 'beta',
              feature_flags = '{"line_alerts": false, "line_live": true}'::jsonb
        WHERE id = $1`,
      [ORG],
    ),
  );
  await page.goto("/m/notify");
  await expect(page.getByTestId("notify-empty")).toBeVisible();
  await expect(page.getByTestId("line-notify")).toHaveCount(0);
  await cron(page);
  expect((await pushes(page)).pushes).toEqual([]);

  await withDb((client) =>
    client.query(`UPDATE organizations SET feature_flags = '{"line_alerts": true}'::jsonb WHERE id = $1`, [ORG]),
  );
  await page.goto("/api/env?set=sandbox&next=" + encodeURIComponent("/m/notify"));
  await expect(page.getByTestId("org-switch")).toContainText("範例公司");
  await expect(page.getByTestId("line-notify")).toBeVisible();
  await expect(page.getByTestId("line-notify-banner")).toBeVisible();

  const sandboxId = await withDb(async (client) => {
    const sandbox = await client.query<{ id: string }>(
      `SELECT id::text FROM organizations WHERE live_org_id = $1 AND environment = 'sandbox'`,
      [ORG],
    );
    const id = sandbox.rows[0]?.id;
    expect(id).toBeTruthy();
    await client.query(
      `UPDATE organizations SET feature_flags = feature_flags || '{"line_live": true}'::jsonb WHERE id = $1`,
      [id],
    );
    await client.query(
      `INSERT INTO line_user_links (org_id, user_id, line_user_id, status, linked_at)
       VALUES ($1, $2, $3, 'linked', now())`,
      [id, ADMIN, LINE_USER],
    );
    const leases = await client.query(
      `WITH picked AS (
         SELECT id, row_number() OVER (ORDER BY created_at) AS n
           FROM leases
          WHERE org_id = $1 AND status = 'active'
       )
       UPDATE leases l
          SET end_date = (timezone('Asia/Taipei', now()))::date + CASE WHEN p.n = 1 THEN 60 ELSE 30 END
         FROM picked p
        WHERE l.id = p.id AND p.n <= 2`,
      [id],
    );
    expect(leases.rowCount).toBeGreaterThan(0);
    await client.query(
      `UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date + 3
        WHERE org_id = $1 AND status IN ('open', 'partially_paid')`,
      [id],
    );
    await client.query(`UPDATE invoices SET due_date = (timezone('Asia/Taipei', now()))::date + 90 WHERE org_id = $1`, [ORG]);
    await client.query(`UPDATE leases SET end_date = (timezone('Asia/Taipei', now()))::date + 400 WHERE org_id = $1`, [ORG]);
    return id;
  });
  expect(sandboxId).toBeTruthy();
  await cron(page);
  expect((await pushes(page)).pushes).toEqual([]);
});
