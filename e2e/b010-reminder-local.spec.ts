import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true") throw new Error("B010 requires disposable demo mode");
async function db<T>(fn:(client:Client)=>Promise<T>) { const c=new Client({connectionString:url}); await c.connect(); try {return await fn(c);} finally {await c.end();} }

test.afterEach(async()=>{await db(async c=>{await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='rent_reminders_v2'`); await c.query(`UPDATE organizations SET feature_flags=feature_flags-'rent_reminders_v2' WHERE id=$1`,[ORG_ID]);});});

for (const width of [390,1280]) test(`manager local reminder at ${width}px`,async ({page},info)=>{
  await page.setViewportSize({width,height:850});
  const errors:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("response",r=>{if(r.status()>=500) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
  await resetDemo(page);
  const invoice=await db(async c=>(await c.query<{lease:string;user_id:string}>(`SELECT i.lease_id::text AS lease,ct.user_id::text FROM invoices i JOIN leases l ON l.id=i.lease_id
    JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.id=lp.contact_id
    WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL AND i.status IN ('open','partially_paid') AND i.balance_minor>0
      AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0)
      AND ct.email IS NOT NULL AND ct.user_id=ANY($2::uuid[]) LIMIT 1`,[ORG_ID,[USERS.tenant,USERS.tenant2]])).rows[0]);
  expect(invoice).toBeTruthy();
  await signIn(page,ACCOUNTS.manager);
  const off=await page.goto(`/m/rent/remind/${invoice.lease}`);
  expect(off?.status()).toBe(404);
  await db(async c=>{await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]); await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);});
  await page.goto(`/api/demo/locale?set=en&next=/m/rent/remind/${invoice.lease}`);
  await expect(page.getByRole("heading",{name:"Rent reminder"})).toBeVisible();
  await expect(page.getByText("This creates a local test record only. No message has been sent.")).toBeVisible();
  await page.getByTestId("queue-reminder").first().click();
  await expect(page.getByTestId("reminder-result")).toContainText(/Test recorded: [1-9]/);
  await expect(page.getByTestId("reminder-result")).not.toContainText(/delivered|sent/i);
  await page.screenshot({path:info.outputPath(`manual-reminder-${width}.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
  await signIn(page,invoice.user_id===USERS.tenant ? ACCOUNTS.tenant : ACCOUNTS.tenant2);
  await page.goto(`/t/reminders/${invoice.lease}`);
  await expect(page.getByTestId("tenant-due-preference")).toContainText("開啟");
  await page.getByTestId("tenant-due-toggle").click();
  await expect(page.getByTestId("tenant-due-preference")).toContainText("關閉");
  await page.reload(); await expect(page.getByTestId("tenant-due-preference")).toContainText("關閉");
  await page.screenshot({path:info.outputPath(`tenant-preference-${width}.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
  expect(errors).toEqual([]);
});
