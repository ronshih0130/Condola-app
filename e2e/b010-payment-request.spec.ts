import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true") throw new Error("B010 requires disposable demo mode");
async function db<T>(fn:(c:Client)=>Promise<T>) { const c=new Client({connectionString:url}); await c.connect(); try {return await fn(c);} finally {await c.end();} }
test.afterEach(async()=>{await db(async c=>{await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='payment_results_v2'`); await c.query(`UPDATE organizations SET feature_flags=feature_flags-'payment_results_v2' WHERE id=$1`,[ORG_ID]);});});

test("pending payment survives abort, reopen and reload; recorded result permits a distinct payment",async({page})=>{
  await resetDemo(page);
  const lease=await db(async c=>(await c.query<{id:string}>(`SELECT l.id::text FROM leases l JOIN invoices i ON i.lease_id=l.id AND i.org_id=l.org_id WHERE l.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL AND i.status IN ('open','partially_paid') AND i.balance_minor>1000 LIMIT 1`,[ORG_ID])).rows[0].id);
  await db(async c=>{await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]); await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);});
  await signIn(page,ACCOUNTS.manager);
  await page.goto(`/api/demo/locale?set=en&next=/m/leases/${lease}?tab=ledger`);
  await page.evaluate(()=>{const original=Storage.prototype.getItem; Object.defineProperty(window,"__restorePaymentStorage",{value:()=>{Storage.prototype.getItem=original;},configurable:true}); Storage.prototype.getItem=()=>{throw new Error("storage unavailable");};});
  await page.getByTestId("record-payment").click();
  await expect(page.getByTestId("payment-request-status")).toContainText("cannot be checked");
  await expect(page.getByTestId("submit-payment")).toBeDisabled();
  await page.getByTestId("pay-dialog-close").click();
  await page.evaluate(()=>(window as unknown as {__restorePaymentStorage:()=>void}).__restorePaymentStorage());
  await page.getByTestId("record-payment").click();
  await expect(page.getByTestId("submit-payment")).toBeEnabled();
  const request=await page.locator('input[name="requestId"]').inputValue();
  expect(request).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByTestId("pay-dialog-close").click();
  await page.getByTestId("record-payment").click();
  await expect(page.getByTestId("submit-payment")).toBeEnabled();
  expect(await page.locator('input[name="requestId"]').inputValue()).toBe(request);
  await page.reload(); await page.getByTestId("record-payment").click();
  await expect(page.getByTestId("submit-payment")).toBeEnabled();
  expect(await page.locator('input[name="requestId"]').inputValue()).toBe(request);
  await page.getByTestId("pay-amount").fill("1");
  await page.getByTestId("pay-last5").fill("12345");
  let intercepted=0;
  await page.route(`**/m/leases/${lease}*`,async route=>{
    if (route.request().method()==="POST" && route.request().headers()["next-action"]) { intercepted++; await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await page.locator('form:has([data-testid="submit-payment"])').evaluate((form:HTMLFormElement)=>{ form.requestSubmit(); form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(async()=>db(async c=>Number((await c.query<{n:string}>(`SELECT count(*)::text n FROM app.b010_payment_commands WHERE org_id=$1 AND actor_id=$2 AND request_id=$3`,[ORG_ID,USERS.manager,request])).rows[0].n))).toBe(1);
  expect(intercepted).toBeGreaterThan(0);
  await page.unrouteAll({behavior:"wait"});
  await page.reload(); await page.getByTestId("record-payment").click();
  await expect(page.getByTestId("payment-request-status")).toContainText("previous payment was recorded");
  expect(await page.locator('input[name="requestId"]').inputValue()).toBe(request);
  await page.getByTestId("payment-new-intent").click();
  const second=await page.locator('input[name="requestId"]').inputValue();
  expect(second).not.toBe(request);
  await page.getByTestId("pay-amount").fill("2");
  await page.getByTestId("pay-last5").fill("12345");
  await page.getByTestId("submit-payment").click();
  await expect.poll(async()=>db(async c=>Number((await c.query<{n:string}>(`SELECT count(*)::text n FROM app.b010_payment_commands WHERE org_id=$1 AND actor_id=$2 AND request_id=ANY($3::uuid[])`,[ORG_ID,USERS.manager,[request,second]])).rows[0].n))).toBe(2);
  const results=await db(async c=>(await c.query<{request_id:string;payment_id:string;amount:string;events:string}>(`SELECT cmd.request_id::text,cmd.payment_id::text,p.amount_minor::text AS amount,(SELECT count(*)::text FROM app.b010_source_events e WHERE e.payment_id=p.id AND e.kind='payment_confirmed' AND e.actor_id=$2) AS events FROM app.b010_payment_commands cmd JOIN payments p ON p.id=cmd.payment_id AND p.org_id=cmd.org_id WHERE cmd.org_id=$1 AND cmd.actor_id=$2 AND cmd.request_id=ANY($3::uuid[])`,[ORG_ID,USERS.manager,[request,second]])).rows);
  expect(new Set(results.map(r=>r.payment_id)).size).toBe(2);
  expect(results.find(r=>r.request_id===request)).toMatchObject({amount:"100",events:"1"});
  expect(results.find(r=>r.request_id===second)).toMatchObject({amount:"200",events:"1"});
});
