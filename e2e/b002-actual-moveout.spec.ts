import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true") throw new Error("B002 UI requires disposable demo mode");
const enabled = process.env.MOVE_OUT_NOTICE_ENABLED === "true";
async function db<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

for (const width of [390,1280]) test(`actual move-out ${enabled ? "ON" : "OFF"} at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 850 });
  const errors: string[] = [];
  let expectingCrossOrg404 = false;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !(expectingCrossOrg404 && message.text().includes("404 (Not Found)"))) errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  await resetDemo(page);
  const leaseId = await db(async (client) => {
    const contact = (await client.query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 LIMIT 1`, [ORG_ID, USERS.tenant])).rows[0].id;
    const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES ($1,'B002 UI','TW','TWD','Asia/Taipei','whole_unit') RETURNING id::text`, [ORG_ID])).rows[0].id;
    const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'B002','whole_unit') RETURNING id::text`, [ORG_ID, property])).rows[0].id;
    const lease = (await client.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active','2020-01-01','TWD',0) RETURNING id::text`, [ORG_ID, property, unit])).rows[0].id;
    await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'primary')`, [ORG_ID, lease, contact]);
    return lease;
  });
  const path = `/m/leases/${leaseId}`;
  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(path)}`);
  const card = page.getByTestId("actual-moveout");
  if (!enabled) {
    await expect(card).toHaveCount(0);
    const row = await db(async (client) => (await client.query<{ date: string | null }>(`SELECT moved_out_on::text AS date FROM leases WHERE id=$1`, [leaseId])).rows[0]);
    expect(row.date).toBeNull();
    await page.screenshot({ path: testInfo.outputPath(`moveout-off-${width}.png`), fullPage: true });
  } else {
    await expect(card).toBeVisible();
    await expect(card).toContainText("contract end date");
    await expect(page.getByTestId("actual-moveout-current")).toContainText("No actual move-out date recorded");
    await page.getByTestId("actual-moveout-date").fill("2026-04-10");
    await page.getByTestId("actual-moveout-reason").fill("Initial verified date");
    await page.screenshot({ path: testInfo.outputPath(`moveout-before-${width}.png`), fullPage: true });
    await page.getByTestId("actual-moveout-submit").click();
    await expect(page.getByTestId("actual-moveout-message")).toContainText("saved");
    await expect(page.getByTestId("actual-moveout-current")).toContainText("2026-04-10");
    await signIn(page, ACCOUNTS.manager);
    await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(path)}`);
    await expect(card).toBeVisible();
    await expect(page.getByTestId("actual-moveout-current")).toContainText("2026-04-10");
    await page.getByTestId("actual-moveout-date").fill("2026-04-20");
    await page.getByTestId("actual-moveout-reason").fill("Corrected recorded date");
    await page.getByTestId("actual-moveout-submit").click();
    await expect(page.getByTestId("actual-moveout-current")).toContainText("2026-04-20");
    const state = await db(async (client) => {
      const lease = (await client.query<{ date: string; end_date: string | null; due: string }>(`SELECT moved_out_on::text AS date,end_date::text,id_document_delete_after(id,org_id,now())::text AS due FROM leases WHERE id=$1`, [leaseId])).rows[0];
      const audit = (await client.query<{ actor: string; reason: string; old_date: string | null; new_date: string }>(`SELECT actor_user_id::text AS actor,reason,old_row->>'moved_out_on' AS old_date,new_row->>'moved_out_on' AS new_date FROM audit_log WHERE org_id=$1 AND table_name='leases' AND row_id=$2 AND changed_cols @> ARRAY['moved_out_on']::text[] ORDER BY occurred_at,id`, [ORG_ID, leaseId])).rows;
      return { lease, audit };
    });
    expect(state.lease).toEqual({ date:"2026-04-20", end_date:null, due:"2026-07-19" });
    expect(state.audit).toEqual([{ actor:USERS.admin, reason:"Initial verified date", old_date:null, new_date:"2026-04-10" }, { actor:USERS.manager, reason:"Corrected recorded date", old_date:"2026-04-10", new_date:"2026-04-20" }]);
    await page.screenshot({ path: testInfo.outputPath(`moveout-corrected-${width}.png`), fullPage: true });
    await signIn(page, ACCOUNTS.accountant);
    await page.goto(path);
    await expect(card).toHaveCount(0);
    await signIn(page, "admin@coast.demo");
    expectingCrossOrg404 = true;
    const crossOrg = await page.goto(path);
    expect(crossOrg?.status()).toBe(404);
    await expect(card).toHaveCount(0);
    expectingCrossOrg404 = false;
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
