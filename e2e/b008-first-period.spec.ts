import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { resetDemo } from "./session";

const url = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true") throw new Error("B008 requires disposable demo mode");
async function db<T>(fn:(client:Client)=>Promise<T>) { const client=new Client({connectionString:url}); await client.connect(); try { return await fn(client); } finally { await client.end(); } }
test.afterEach(async () => { await db(async c=>{ await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`); await c.query(`UPDATE organizations SET feature_flags=feature_flags - 'billing_previews' WHERE id=$1`,[ORG_ID]); }); });

for (const width of [390,1280]) test(`first period preview and saved edit at ${width}px`,async ({page},info)=>{
  await page.setViewportSize({width,height:850});
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  page.on("response",response=>{if(response.status()>=500)errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);});
  await resetDemo(page);
  await db(async c=>{ await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`); });
  await page.goto("/api/demo/locale?set=en&next=/m/leases/new");
  await expect(page.getByTestId("first-period-preview")).toHaveCount(0);
  const unit=await db(async c=>{
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    const property=(await c.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,jurisdiction_id,currency,timezone,default_rental_mode) SELECT $1,'First period fixture','US',id,'USD','America/Los_Angeles','whole_unit' FROM jurisdictions WHERE code='US' RETURNING id::text`,[ORG_ID])).rows[0].id;
    return (await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES ($1,$2,'First period','whole_unit',30000) RETURNING id::text`,[ORG_ID,property])).rows[0].id;
  });
  await page.goto("/m/leases/new");
  await page.getByTestId("lease-room").selectOption(unit);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("First period fixture");
  await page.getByTestId("tenant-phone").fill("0912000333");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("start-date").fill("2035-12-16");
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("300");
  await page.getByLabel("Calculate partial first-month rent by day").check();
  await expect(page.getByTestId("first-period-preview")).toContainText("160.00");
  await expect(page.getByTestId("first-period-preview")).toContainText("16 days");
  await page.screenshot({path:info.outputPath(`first-period-wizard-${width}.png`),fullPage:true});
  for(let step=0;step<5;step++) await page.getByTestId("wizard-next").click();
  await page.getByTestId("submit-lease").click();
  await page.waitForURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1/);
  const id=new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByTestId("first-period-summary")).toContainText("160.00");
  await expect(page.getByTestId("first-period-summary")).toContainText("separately from the lease PDF");
  await page.locator("#first-period-choice").selectOption("false");
  await expect(page.getByTestId("edit-first-period-preview")).toContainText("300.00");
  await page.screenshot({path:info.outputPath(`first-period-edit-${width}.png`),fullPage:true});
  await page.getByTestId("save-lease-terms").click();
  await expect.poll(async()=>db(async c=>(await c.query<{basis:{prorateFirstPeriod:boolean}}>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`,[id])).rows[0].basis.prorateFirstPeriod)).toBe(false);
  await expect(page.getByTestId("first-period-summary")).toContainText("300.00");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
  expect(errors).toEqual([]);
});
