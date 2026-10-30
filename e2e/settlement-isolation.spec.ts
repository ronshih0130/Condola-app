import { expect,test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { ORG_ID,USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { resetDemo } from "./session";
const target=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
if(process.env.DEMO_MODE!=="true")throw new Error("Disposable demo mode is required");
async function db<T>(fn:(c:Client)=>Promise<T>){const c=new Client({connectionString:target.href});await c.connect();try{return await fn(c);}finally{await c.end();}}
test("one draft action settles and recovers its own request before further interaction",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));page.on("console",e=>{if(e.type()==="error")errors.push(e.text());});page.on("response",r=>{if(r.status()>=500)errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
 await page.route("**/*",async route=>{const url=new URL(route.request().url());if(["localhost","127.0.0.1"].includes(url.hostname))await route.continue();else{errors.push("External request blocked");await route.abort();}});await resetDemo(page);
 const lease=await db(async c=>{await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"deposit_settlements":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='deposit_settlements'`,[ORG_ID]);return (await c.query<{id:string}>(`SELECT l.id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts ct ON ct.id=lp.contact_id WHERE l.org_id=$1 AND ct.user_id=$2 AND lp.role='primary' AND l.status<>'draft' LIMIT 1`,[ORG_ID,USERS.tenant])).rows[0].id;});
 await page.goto(`/api/demo/locale?set=en&next=/m/settlement/${lease}`);await expect(page.getByRole("heading",{name:"Deposit settlement"})).toBeVisible();
 const manifest=decodeURIComponent(await readFile(".next/server/server-reference-manifest.json","utf8")),actions=new Map<string,string>();for(const match of manifest.matchAll(/"id":"([0-9a-f]+)","exportedName":"([^"]+)"/g))actions.set(match[1],match[2]);expect([...actions.values()]).toContain("createSettlementDraftAction");expect([...actions.values()]).toContain("settlementCommandStatusAction");
 const failures:string[]=[],timeline:string[]=[];let mutationRequests=0;
 const tracked=(request:import("@playwright/test").Request)=>{const url=new URL(request.url());if(request.method()!=="POST"||url.origin!=="http://127.0.0.1:43124"||url.pathname!==`/m/settlement/${lease}`)return null;const name=actions.get(request.headers()["next-action"]??"");return name==="createSettlementDraftAction"||name==="settlementCommandStatusAction"?name:null;};
 page.on("request",request=>{const name=tracked(request);if(name){timeline.push(`${Math.round(performance.now())} submit ${name}`);if(name==="createSettlementDraftAction")mutationRequests++;}});
 page.on("response",response=>{const name=tracked(response.request());if(name)timeline.push(`${Math.round(performance.now())} headers ${name} ${response.status()}`);});
 page.on("requestfinished",request=>{const name=tracked(request);if(name)timeline.push(`${Math.round(performance.now())} finished ${name}`);});
 page.on("requestfailed",request=>{const name=tracked(request);if(name){const event=`${name}: ${request.failure()?.errorText??"unknown"}`;failures.push(event);timeline.push(`${Math.round(performance.now())} failed ${event}`);}});
 await page.getByRole("button",{name:"Start a draft"}).click();
 // From submit until the recorded state is visible, the fixture performs no
 // further browser action; any navigation is initiated by the product itself.
 await expect(page.getByText("A previous request in this form was recorded. Review the history before starting another.").first()).toBeVisible();timeline.push(`${Math.round(performance.now())} recorded UI`);await page.waitForLoadState("networkidle");
 const requestId=await page.evaluate(({actor,org,leaseId})=>sessionStorage.getItem(`condola:settlement:${actor}:${org}:${leaseId}:statement:none:new-draft`),{actor:USERS.admin,org:ORG_ID,leaseId:lease});expect(requestId).toBeTruthy();expect(mutationRequests).toBe(1);
 expect(await db(async c=>(await c.query<{n:number}>(`SELECT count(*)::int n FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`,[ORG_ID,lease,USERS.admin,requestId])).rows[0].n)).toBe(1);
 expect(failures,JSON.stringify(timeline)).toEqual([]);expect(errors).toEqual([]);
});
