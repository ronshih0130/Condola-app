import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ORG_ID } from "../src/server/ids";
import { resetDemo } from "./session";

const target=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
if(target.hostname!=="127.0.0.1"||target.port!=="55435"||!/^\/condola_b015_archive_(focus|browser)_[0-9a-f]{7}[a-z0-9]{1,12}$/.test(target.pathname)||process.env.B015_OWNED_DATABASE!==target.pathname.slice(1)||process.env.DEMO_MODE!=="true") throw new Error("Owned B015 demo required");
const origin="http://127.0.0.1:43151";
async function db<T>(fn:(client:Client)=>Promise<T>):Promise<T>{
  const c=new Client({connectionString:target.href}); await c.connect();
  try{return await fn(c);}finally{await c.end();}
}
for(const locale of ["en","zh-TW"] as const) for(const width of [390,1280]) {
  test(`archive ancestry ${locale} ${width}`,async({page},info)=>{
    await page.setViewportSize({width,height:900});
    const errors:string[]=[];
    page.on("pageerror",e=>errors.push(e.message));
    page.on("console",e=>{if(e.type()==="error")errors.push(e.text());});
    page.on("response",r=>{if(r.status()>=500)errors.push(`HTTP ${r.status()}`);});
    await page.route("**/*",async route=>{if(new URL(route.request().url()).origin===origin)await route.continue();else{errors.push("External request");await route.abort();}});
    await resetDemo(page);
    const tag=`B015 browser ${randomUUID()}`;
    const f=await db(async c=>{
      const property=(await c.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,tag])).rows[0].id;
      const unit=(await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES($1,$2,'B015','by_room',1000000) RETURNING id::text`,[ORG_ID,property])).rows[0].id;
      const room=(await c.query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label,base_rent_minor) VALUES($1,$2,'B015 room',1000000) RETURNING id::text`,[ORG_ID,unit])).rows[0].id;
      return {property,unit,room};
    });
    try{
      await page.goto(`/api/demo/locale?set=${locale}&next=/m/leases/new`);
      const select=page.getByTestId("lease-room"); await expect(select.locator(`option[value="${f.room}"]`)).toHaveCount(1);
      await select.selectOption(f.room); await expect(select).toHaveValue(f.room); await expect(select.locator(`option[value="${f.room}"]`)).toContainText(tag);
      await page.screenshot({path:info.outputPath(`active-${locale}-${width}.png`),fullPage:true});
      await page.getByTestId("wizard-next").click();
      await page.getByTestId("tenant-name").fill(tag); await page.getByTestId("tenant-phone").fill("0912345678"); await page.getByTestId("wizard-next").click();
      await page.getByTestId("start-date").fill("2094-01-01"); await page.getByTestId("term-months").fill("12"); await page.getByTestId("rent").fill("10000"); await page.getByTestId("wizard-next").click();
      await page.getByTestId("deposit-months").fill("2"); await page.getByTestId("wizard-next").click();
      await page.getByTestId("due-day").fill("5"); await page.getByTestId("wizard-next").click();
      await page.getByTestId("wizard-next").click(); await expect(page.getByTestId("lease-template")).toBeVisible();
      await page.getByTestId("wizard-next").click(); await expect(page.getByTestId("submit-lease")).toBeEnabled();
      await db(c=>c.query(`UPDATE properties SET archived_at=now() WHERE id=$1`,[f.property]));
      const count=()=>db(async c=>(await c.query(`SELECT (SELECT count(*)::int FROM leases WHERE property_id=$1) leases,(SELECT count(*)::int FROM contacts WHERE org_id=$2 AND display_name=$3) contacts,(SELECT count(*)::int FROM auth.users) users,(SELECT count(*)::int FROM lease_signatures s JOIN leases l ON l.id=s.lease_id WHERE l.property_id=$1) signatures,(SELECT count(*)::int FROM invoices WHERE property_id=$1) invoices`,[f.property,ORG_ID,tag])).rows[0]);
      const before=await count();
      await page.getByTestId("submit-lease").click(); await expect(page.getByTestId("lease-error")).toHaveText(locale==="en" ? "We couldn't find that record. Please go back to the list and open it again." : "找不到這筆資料。請回到列表再打開一次。");
      expect(await count()).toEqual(before); await page.screenshot({path:info.outputPath(`stale-${locale}-${width}.png`),fullPage:true});
      const api=await page.request.post("/api/flows/createLease",{data:{roomId:f.room,tenantName:tag,tenantPhone:"0912345678",tenantEmail:"",lineUserId:"",startDate:"2094-01-01",endDate:"2094-12-31",rentMajor:10000,depositMonths:2,depositReason:"",dueDay:5,splitMethod:"even",periodStart:"2094-01-01",periodEnd:"2094-01-31",billTotalMajor:null,usageKwh:null,rateMajor:null,rateSource:"bill_average",overrideReason:"",subUsages:[],idempotencyKey:randomUUID()}});
      expect(api.status()).toBe(400); expect(await api.json()).toEqual({ok:false,error:"errors.notFound"}); expect(await count()).toEqual(before);
      await page.goto("/m/leases/new"); await expect(page.getByTestId("lease-room")).toBeVisible(); await expect(page.getByTestId("lease-room")).toBeEnabled(); await expect(page.getByTestId("lease-room").locator("option").first()).toBeAttached(); await expect(page.getByTestId("lease-room").locator(`option[value="${f.room}"]`)).toHaveCount(0);
      await page.screenshot({path:info.outputPath(`filtered-${locale}-${width}.png`),fullPage:true}); expect(errors).toEqual([]);
    }finally{await db(c=>c.query(`UPDATE properties SET archived_at=NULL WHERE id=$1`,[f.property]));}
  });
}
