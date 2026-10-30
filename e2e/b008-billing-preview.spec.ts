import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { prepareUtilityRun } from "../src/server/utility-posting";
import type { Session } from "../src/server/types";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true") throw new Error("B008 requires disposable demo mode");
async function db<T>(fn:(c:Client)=>Promise<T>) { const c=new Client({connectionString:url}); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
const admin:Session={userId:USERS.admin,sessionId:"b008-browser",email:"fixture@example.invalid",name:"Fixture",kind:"staff",role:"admin",orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"en",calendar:"gregorian",leaseId:null};

test.afterEach(async () => { await db(async(c)=>{ await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`); await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]); }); });

for (const width of [390,1280]) test(`statement and close preview at ${width}px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:850});
  const errors:string[]=[];
  page.on("pageerror",(error)=>errors.push(error.message));
  page.on("console",(message)=>{if(message.type()==="error")errors.push(message.text());});
  page.on("response",(response)=>{if(response.status()>=500)errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);});
  await resetDemo(page);
  const fixture=await db(async(c)=>{
    const owner=(await c.query<{owner:string;property:string}>(`SELECT po.owner_contact_id::text AS owner,po.property_id::text AS property FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND p.currency='TWD' ORDER BY p.name LIMIT 1`,[ORG_ID])).rows[0];
    const expense=(await c.query<{id:string}>(`INSERT INTO expenses(org_id,property_id,category,currency,amount_minor,incurred_on,paid_by,bill_to,status) VALUES ($1,$2,'fixture','TWD',10000,'2099-06-15','owner','owner','approved') RETURNING id::text`,[ORG_ID,owner.property])).rows[0].id;
    const unit=(await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'B008 browser','by_room') RETURNING id::text`,[ORG_ID,owner.property])).rows[0].id;
    await c.query(`INSERT INTO rooms(org_id,unit_id,label,electricity_method) VALUES ($1,$2,'A','even'),($1,$2,'B','even'),($1,$2,'C','even')`,[ORG_ID,unit]);
    return {...owner,expense,unit};
  });
  const path=`/m/statements/preview?owner=${fixture.owner}&month=2099-06`;
  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(path)}`);
  await expect(page.getByTestId("statement-amount-preview")).toHaveCount(0);
  await expect(page.getByTestId("preview-generate")).toBeVisible();
  await db(async(c)=>{await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);});
  await signIn(page,ACCOUNTS.manager);
  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(path)}`);
  await expect(page.getByTestId("statement-amount-preview")).toBeVisible();
  await expect(page.getByTestId("preview-generate")).toHaveCount(0);
  await signIn(page,ACCOUNTS.admin);
  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(path)}`);
  const preview=page.getByTestId("statement-amount-preview");
  await expect(preview).toContainText("Expenses");
  await expect(page.getByTestId("preview-generate")).toBeVisible();
  await page.screenshot({path:testInfo.outputPath(`statement-${width}.png`),fullPage:true});
  await db((c)=>c.query(`UPDATE expenses SET amount_minor=20000 WHERE id=$1`,[fixture.expense]));
  await page.getByTestId("preview-generate").click();
  await expect(page.getByText("The sources changed. Review the refreshed preview before generating.")).toBeVisible();
  await expect(page.getByTestId("statement-amount-preview")).toBeVisible();
  await page.getByTestId("preview-generate").click();
  await page.waitForURL(/\/m\/statements\/[0-9a-f-]{36}$/);
  const statementId=new URL(page.url()).pathname.split("/").at(-1)!;
  const amount=await db(async(c)=>(await c.query(`SELECT expenses_minor::text AS value FROM owner_statements WHERE id=$1`,[statementId])).rows[0].value);
  expect(Number(amount)).toBe(20000);
  const run=await prepareUtilityRun(admin,{unitId:fixture.unit,periodStart:"2099-07-01",periodEnd:"2099-07-31",rateMajor:4,totalKwh:null,billTotalMajor:100,overrideReason:"",readings:[]});
  await db((c)=>c.query(`UPDATE utility_allocation_lines SET amount_minor=amount_minor+100 WHERE id=(SELECT id FROM utility_allocation_lines WHERE run_id=$1 ORDER BY id LIMIT 1)`,[run.runId]));
  await page.goto("/m/close?month=2099-07");
  await expect(page.getByTestId("utility-reconciliation")).toContainText("Unexplained difference");
  await expect(page.getByTestId("utility-reconciliation")).toContainText("−NT$1");
  await expect(page.getByTestId("close-month")).toHaveValue("2099-07");
  await page.screenshot({path:testInfo.outputPath(`close-${width}.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth+1)).toBe(true);
  expect(errors).toEqual([]);
});
