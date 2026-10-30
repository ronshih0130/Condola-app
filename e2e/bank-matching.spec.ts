import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ORG_ID, USERS } from "../src/server/ids";
import { ACCOUNTS, signIn } from "./session";

const url = disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
if (process.env.DEMO_MODE !== "true") throw new Error("Local B009 browser database required");
for (const width of [390,1280]) test(`manual bank reconciliation at ${width}px`,async ({page}) => {
  await page.setViewportSize({width,height:844});
  const errors:string[]=[];
  page.on("pageerror",e=>errors.push(`pageerror ${e.message}`));
  page.on("console",m=>{if (m.type()==="error") errors.push(`console ${m.text()}`);});
  page.on("response",r=>{if (r.status()>=500) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
  await page.route("**/*", async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === "127.0.0.1" || host === "localhost") await route.continue();
    else { errors.push("unexpected external browser request"); await route.abort(); }
  });
  await signIn(page,ACCOUNTS.admin);
  const db=new Client({connectionString:url.href}); await db.connect();
  const original = (await db.query(`SELECT o.feature_flags ? 'bank_matching' AS present,o.feature_flags->'bank_matching' AS org_flag,p.value AS platform_flag FROM organizations o JOIN platform_settings p ON p.key='bank_matching' WHERE o.id=$1`,[ORG_ID])).rows[0];
  expect(original).toBeTruthy();
  const fixture = randomUUID();
  try {
    await db.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}' WHERE key='bank_matching'`);
    await page.goto("/m/bank"); await expect(page.getByTestId("bank-matching")).toHaveCount(0);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"bank_matching":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='bank_matching'`,[ORG_ID]);
    const account=(await db.query<{id:string;currency:string}>(`SELECT id::text,currency FROM bank_accounts WHERE org_id=$1 AND archived_at IS NULL AND property_id IS NULL ORDER BY created_at,id LIMIT 1`,[ORG_ID])).rows[0]; expect(account).toBeTruthy();
    const property=(await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,'B009 browser','TW',$2,'Asia/Taipei') RETURNING id::text`,[ORG_ID,account.currency])).rows[0].id;
    const unit=(await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'B009') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
    const lease=(await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active','2026-01-01',$4,0) RETURNING id::text`,[ORG_ID,property,unit,account.currency])).rows[0].id;
    await db.query(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor) VALUES ($1,$2,$3,$5,$4,current_date,'open',76500)`,[ORG_ID,property,lease,account.currency,`B009-${fixture}`]);
    const payment=(await db.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES ($1,$2,$3,$4,76500,'2026-01-03','bank_transfer','submitted','tenant_portal',$5) RETURNING id::text`,[ORG_ID,property,lease,account.currency,USERS.admin])).rows[0].id;
    await page.goto("/m/bank"); const card=page.getByTestId("bank-matching"); await expect(card).toBeVisible();
    const upload=card.locator('form').first(); await upload.locator('select[name="account"]').selectOption(account.id);
    const file={name:"synthetic.csv",mimeType:"text/csv",buffer:Buffer.from(`date,amount,last5,memo\n2026-01-03,765.00,12345,B009 browser ${fixture}`)};
    await upload.locator('input[type="file"]').setInputFiles(file); await upload.getByRole("button",{name:"匯入"}).click();
    const line=page.getByTestId("bank-line").filter({hasText:`B009 browser ${fixture}`}); await expect(line).toBeVisible();
    await expect(line).toContainText("配對建議");
    await upload.locator('select[name="account"]').selectOption(account.id); await upload.locator('input[type="file"]').setInputFiles(file); await upload.getByRole("button",{name:"匯入"}).click();
    await expect(page.getByTestId("bank-line").filter({hasText:`B009 browser ${fixture}`})).toHaveCount(1);
    const suggestion=line.locator("form").filter({hasText:"配對建議"}); await suggestion.locator('input[name="reason"]').fill("Synthetic rejection"); await suggestion.getByRole("button",{name:"拒絕建議"}).click();
    await expect(line).not.toContainText("配對建議");
    const manual=line.locator("form").filter({hasText:"手動選擇"}); await manual.locator('select[name="paymentId"]').selectOption(payment); await manual.locator('input[name="reason"]').fill("Synthetic match");
    await manual.getByRole("button",{name:"配對款項"}).click(); await expect(line).toHaveCount(0);
    const checks=(await db.query(`SELECT (SELECT count(*)::int FROM app.b009_decisions WHERE org_id=$1 AND actor_id=$2 AND payment_id=$3 AND decision='match' AND reason='Synthetic match') AS matched,(SELECT count(*)::int FROM app.b009_decisions WHERE org_id=$1 AND actor_id=$2 AND payment_id=$3 AND decision='reject' AND reason='Synthetic rejection') AS rejected,(SELECT count(*)::int FROM payment_allocations WHERE payment_id=$3) AS allocations`,[ORG_ID,USERS.admin,payment])).rows[0];
    expect(checks).toEqual({matched:1,rejected:1,allocations:1});
    mkdirSync("../B009-bank-evidence",{recursive:true}); await page.screenshot({path:`../B009-bank-evidence/bank-${width}.png`,fullPage:true}); expect(errors).toEqual([]);
    writeFileSync(`../B009-bank-evidence/bank-${width}.json`,JSON.stringify({width,http5xx:0,consoleErrors:0,pageErrors:0,screenshot:`bank-${width}.png`},null,2));
  } finally {
    await db.query(`UPDATE organizations SET feature_flags=CASE WHEN $2::boolean THEN jsonb_set(feature_flags,'{bank_matching}',$3::jsonb,true) ELSE feature_flags-'bank_matching' END WHERE id=$1`,[ORG_ID,original.present,JSON.stringify(original.org_flag)]);
    await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='bank_matching'`,[JSON.stringify(original.platform_flag)]);
    await db.end();
  }
});
