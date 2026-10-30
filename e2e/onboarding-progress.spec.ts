import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ORG_ID, USERS } from "../src/server/ids";
import { ACCOUNTS, resetDemo, signIn, waitPastConsent } from "./session";

const db = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
if (process.env.DEMO_MODE !== "true") throw new Error("Local synthetic demo mode required");

for (const width of [390, 1280]) test(`live onboarding resumes and respects real acceptance at ${width}px`, async ({ page, browser }) => {
  await page.setViewportSize({ width, height: 844 });
  const errors: string[] = [];
  const watch = (target: typeof page) => {
    target.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
    target.on("console", (m) => { if (m.type() === "error") errors.push(`console ${m.text()}`); });
    target.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  };
  watch(page);
  await resetDemo(page);
  const client = new Client({ connectionString: db.href }); await client.connect();
  const originalRollout = (await client.query(`SELECT value FROM platform_settings WHERE key='onboarding_progress'`)).rows[0]?.value;
  const originalOrg = (await client.query(`SELECT feature_flags,settings FROM organizations WHERE id=$1`, [ORG_ID])).rows[0];
  try {
    await client.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}' WHERE key='onboarding_progress'`);
    await page.goto("/m"); await expect(page.getByTestId("live-onboarding")).toHaveCount(0);
    for (const table of ["properties","units","rooms","leases","lease_parties","contacts","invoices","property_owners","org_members","invitations"]) {
      await client.query(`INSERT INTO sample_marks(org_id,entity_table,entity_id) SELECT org_id,$2,id FROM ${table} WHERE org_id=$1 ON CONFLICT DO NOTHING`,[ORG_ID,table]);
    }
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"onboarding_progress":true}'::jsonb,settings=settings-'onboarding_progress' WHERE id=$1`,[ORG_ID]);
    await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='onboarding_progress'`,[ORG_ID]);
    await page.goto("/api/env?set=sandbox&next=/m"); await expect(page.getByTestId("env-banner")).toBeVisible(); await expect(page.getByTestId("live-onboarding")).toHaveCount(0);
    await page.goto("/api/env?set=live&next=/m");
    const card = page.getByTestId("live-onboarding"); await expect(card).toBeVisible();
    const row = (name: string) => card.locator("li").filter({ hasText: name });
    await expect(row("物件")).toContainText("進行中"); await expect(row("租約")).toContainText("進行中"); await expect(row("首張帳單")).toContainText("進行中");
    const property = (await client.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,'B005 browser','TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID])).rows[0].id;
    const unit = (await client.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'browser') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
    await page.reload(); await expect(row("物件")).toContainText("已完成"); await expect(row("租約")).toContainText("進行中");
    const lease = (await client.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active','2026-01-01','TWD',0) RETURNING id::text`,[ORG_ID,property,unit])).rows[0].id;
    const contact = (await client.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name,email) VALUES ($1,true,'B005 browser','b005-tenant@example.test') RETURNING id::text`,[ORG_ID])).rows[0].id;
    await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'primary')`,[ORG_ID,lease,contact]);
    await client.query(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor) VALUES ($1,$2,$3,'B005-BROWSER','TWD',current_date,'open',0)`,[ORG_ID,property,lease]);
    const token = randomBytes(32).toString("base64url"); const hash = createHash("sha256").update(token).digest("hex");
    await client.query(`INSERT INTO invitations(org_id,kind,contact_id,lease_id,email,code_hash,expires_at,invited_by) VALUES ($1,'tenant',$2,$3,'b005-tenant@example.test',$4,now()+interval '1 day',$5)`,[ORG_ID,contact,lease,hash,USERS.admin]);
    await page.reload(); await expect(row("租約")).toContainText("已完成"); await expect(row("首張帳單")).toContainText("已完成");
    await card.locator('input[name="tenant"]').check(); await card.getByRole("button",{ name:"儲存邀請選擇" }).click();
    await expect(row("租客")).toContainText("進行中"); await expect(row("租客")).toContainText("待接受邀請: 1");
    const guest = await browser.newContext({ viewport: { width, height: 844 } }); const guestPage = await guest.newPage(); watch(guestPage);
    try {
      await guestPage.goto(`/accept/${token}`); await expect(guestPage.getByTestId("portal-invite-title")).toBeVisible();
      await guestPage.getByTestId("new-password").fill("Synthetic1234"); await guestPage.getByTestId("portal-submit").click();
      await waitPastConsent(guestPage,"liff-frame");
    } finally { await guest.close(); }
    await page.reload(); await expect(row("租客")).toContainText("已完成");
    if (width === 390) await page.getByTestId("nav-toggle").click();
    await page.getByTestId(width === 390 ? "sign-out-drawer" : "sign-out").click(); await expect(page).toHaveURL(/\/login/);
    await signIn(page,ACCOUNTS.admin); await expect(card).toBeVisible(); await expect(row("租客")).toContainText("已完成");
    await card.locator('input[name="tenant"]').uncheck(); await card.getByRole("button",{name:"儲存邀請選擇"}).click(); await expect(row("租客")).toContainText("不需要");
    expect((await client.query(`SELECT 1 FROM audit_log WHERE org_id=$1 AND actor_user_id=$2 AND event_type='onboarding_invitation_policy_changed' AND new_row->'not_needed' @> '["tenant"]'::jsonb`,[ORG_ID,USERS.admin])).rowCount).toBeGreaterThan(0);
    mkdirSync("../B005-onboarding-evidence",{recursive:true}); await page.screenshot({path:`../B005-onboarding-evidence/onboarding-${width}.png`,fullPage:true});
    await signIn(page,ACCOUNTS.manager); await expect(page.getByTestId("live-onboarding")).toHaveCount(0);
    expect(errors).toEqual([]);
    writeFileSync(`../B005-onboarding-evidence/onboarding-${width}.json`,JSON.stringify({width,http5xx:0,consoleErrors:0,pageErrors:0,screenshot:`onboarding-${width}.png`},null,2));
  } finally {
    try {
      if (originalRollout === undefined) await client.query(`DELETE FROM platform_settings WHERE key='onboarding_progress'`);
      else await client.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='onboarding_progress'`, [JSON.stringify(originalRollout)]);
      if (originalOrg) await client.query(`UPDATE organizations SET feature_flags=$2::jsonb,settings=$3::jsonb WHERE id=$1`, [ORG_ID,JSON.stringify(originalOrg.feature_flags),JSON.stringify(originalOrg.settings)]);
    } finally { await client.end(); }
  }
});
