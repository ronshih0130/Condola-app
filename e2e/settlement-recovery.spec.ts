import { expect,test,type Request } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID,USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { resetDemo } from "./session";
const target=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
if(process.env.DEMO_MODE!=="true")throw new Error("Disposable demo mode is required");
if(process.env.B011_WIDTH==="390"||process.env.B011_WIDTH==="1280")test.use({viewport:{width:Number(process.env.B011_WIDTH),height:900}});
async function db<T>(fn:(c:Client)=>Promise<T>){const c=new Client({connectionString:target.href});await c.connect();try{return await fn(c);}finally{await c.end();}}
test("lost draft response recovers the committed request without another draft",async({page},info)=>{
  const errors:string[]=[];let injectionActive=false;let injectionPath="";let expectedRequestFailures=0,expectedConsole=0;
  page.on("pageerror",e=>errors.push(e.message));
  page.on("console",e=>{if(e.type()!=="error")return;if(injectionActive&&e.text()==="Failed to load resource: net::ERR_FAILED")expectedConsole++;else errors.push(e.text());});
  page.on("response",r=>{if(r.status()>=500)errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
  await page.route("**/*",async route=>{const u=new URL(route.request().url());if(["localhost","127.0.0.1"].includes(u.hostname))await route.continue();else{errors.push("External request blocked");await route.abort();}});
  await resetDemo(page);
  const lease=await db(async c=>{await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"deposit_settlements":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='deposit_settlements'`,[ORG_ID]);return (await c.query<{id:string}>(`SELECT l.id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 AND lp.role='primary' AND l.status<>'draft' LIMIT 1`,[ORG_ID,USERS.tenant])).rows[0].id;});
  await page.goto(`/api/demo/locale?set=en&next=/m/settlement/${lease}`);
  await expect(page.getByRole("heading",{name:"Deposit settlement"})).toBeVisible();
  expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith("condola:settlement:")).length)).toBe(0);
  // The strict request-failure window begins after setup navigation has settled.
  const inFlight=new Set<Request>();
  page.on("request",request=>{if(request.method()==="POST"&&request.url()===`http://127.0.0.1:43124/m/settlement/${lease}`)inFlight.add(request);});
  page.on("requestfinished",request=>{inFlight.delete(request);});
  page.on("requestfailed",request=>{inFlight.delete(request);const expected=injectionActive&&request.method()==="POST"&&request.url()===`http://127.0.0.1:43124${injectionPath}`&&request.failure()?.errorText==="net::ERR_FAILED";if(expected)expectedRequestFailures++;else errors.push(`Unexpected failed request ${new URL(request.url()).pathname}`);});
  let intercepted=false;let finishAbort!:()=>void;const aborted=new Promise<void>(resolve=>{finishAbort=resolve;});injectionPath=`/m/settlement/${lease}`;injectionActive=true;
  await page.route(`**/m/settlement/${lease}`,async route=>{if(!intercepted&&route.request().method()==="POST"){intercepted=true;const response=await route.fetch();expect(response.ok()).toBe(true);expect(await db(async c=>(await c.query<{n:number}>(`SELECT count(*)::int n FROM app.settlement_versions WHERE lease_id=$1`,[lease])).rows[0].n)).toBe(1);await route.abort();finishAbort();}else await route.continue();});
  await page.getByRole("button",{name:"Start a draft"}).click();
  await expect.poll(async()=>db(async c=>(await c.query<{n:number}>(`SELECT count(*)::int n FROM app.settlement_versions WHERE lease_id=$1`,[lease])).rows[0].n)).toBe(1);
  await aborted;expect(intercepted).toBe(true);await page.unroute(`**/m/settlement/${lease}`);await expect.poll(()=>expectedRequestFailures).toBe(1);await expect(page.getByText("A previous request in this form was recorded. Review the history before starting another.").first()).toBeVisible();await expect(page.getByText("Checking request…")).toHaveCount(0);await expect.poll(()=>inFlight.size).toBe(0);await page.waitForLoadState("networkidle");await expect.poll(()=>inFlight.size).toBe(0);await page.reload();
  await expect(page.getByText("A previous request in this form was recorded. Review the history before starting another.").first()).toBeVisible();
  expect(await db(async c=>(await c.query<{n:number}>(`SELECT count(*)::int n FROM app.settlement_versions WHERE lease_id=$1`,[lease])).rows[0].n)).toBe(1);
  injectionActive=false;expect(expectedRequestFailures).toBe(1);expect(expectedConsole).toBeLessThanOrEqual(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath("settlement-recovery.png"),fullPage:true});expect(errors).toEqual([]);
});
