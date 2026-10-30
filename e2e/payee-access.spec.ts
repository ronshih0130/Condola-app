import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SESSION_COOKIE } from "../src/server/auth";
import { Client } from "pg";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ORG_ID, USERS } from "../src/server/ids";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
const fullNumber = "1234509876"; // Synthetic local fixture only.
async function withDb<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({connectionString: databaseUrl});
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

for (const width of [390, 1280]) {
  test(`payee OFF and audited ON account display at ${width}px`, async ({page}) => {
    expect(process.env.DEMO_MODE).toBe("true");
    await page.setViewportSize({width, height:844});
    const errors:string[]=[];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if(message.type()==="error") errors.push(message.text()); });
    page.on("response", response => { if(response.status()>=500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
    await resetDemo(page);
    const leaseId = await withDb(async client => {
      await client.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}' WHERE key='payee_details'`);
      const lease = await client.query<{id:string}>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id WHERE c.user_id=$1 AND l.org_id=$2 AND l.status='active' ORDER BY l.created_at LIMIT 1`,[USERS.tenant,ORG_ID]);
      expect(lease.rowCount).toBe(1);
      return lease.rows[0].id;
    });
    await page.goto("/m/settings");
    await expect(page.getByRole("heading",{name:"匯款資訊",exact:true})).toHaveCount(0);
    await signIn(page,ACCOUNTS.tenant);
    await page.goto("/t");
    await page.getByRole("button",{name:/松信住宅管理/}).click();
    await expect(page.getByTestId("lease-picker")).toHaveCount(0);
    await page.getByRole("link",{name:"我的帳單",exact:true}).first().click();
    await expect(page).toHaveURL(/\/t\/pay$/);
    await expect(page.getByTestId("tenant-payee")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(fullNumber);
    mkdirSync("../B003",{recursive:true});
    await page.screenshot({path:`../B003/off-${width}.png`,fullPage:true});
    await signIn(page,ACCOUNTS.admin);
    await withDb(async client => {
      await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payee_details'`,[ORG_ID]);
      await client.query(`UPDATE organizations SET feature_flags=feature_flags||'{"payee_details":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    });
    await page.goto("/m/settings");
    const form=page.locator("form").filter({has:page.locator('[name="accountNumber"]')}).filter({hasNot:page.locator('[name="id"]')});
    await form.locator('[name="holderName"]').fill("合成帳戶測試");
    await form.locator('[name="bankName"]').fill("範例銀行");
    await form.locator('[name="bankCode"]').fill("123");
    await form.locator('[name="branchCode"]').fill("456");
    await form.locator('[name="accountNumber"]').fill(fullNumber);
    await form.locator('[name="isDefault"]').check();
    await form.getByRole("button",{name:"儲存",exact:true}).click();
    await expect(page).toHaveURL(/\/m\/settings\?saved=1/);
    await expect(page.locator("form").filter({has:page.getByRole("heading",{name:"合成帳戶測試",exact:true})}).locator('[name="accountNumber"]')).toHaveValue(fullNumber);
    await page.screenshot({path:`../B003/settings-${width}.png`,fullPage:true});
    await signIn(page,ACCOUNTS.tenant);
    await page.goto("/t");
    await page.getByRole("button",{name:/松信住宅管理/}).click();
    await expect(page.getByTestId("lease-picker")).toHaveCount(0);
    await page.getByRole("link",{name:"我的帳單",exact:true}).first().click();
    await expect(page).toHaveURL(/\/t\/pay$/);
    await expect(page.getByTestId("tenant-payee")).toContainText(fullNumber);
    await page.screenshot({path:`../B003/on-${width}.png`,fullPage:true});
    const before=await withDb(async client => Number((await client.query(`SELECT count(*) AS n FROM app.payee_access_log WHERE operation='tenant' AND actor_id=$1`,[USERS.tenant])).rows[0].n));
    const response=await page.request.post(`/api/payee/${leaseId}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect((await response.json()).data.account.account_number).toBe(fullNumber);
    const after=await withDb(async client => Number((await client.query(`SELECT count(*) AS n FROM app.payee_access_log WHERE operation='tenant' AND actor_id=$1`,[USERS.tenant])).rows[0].n));
    expect(after-before).toBe(1);
    const denied=await page.request.post('/api/payee/00000000-0000-4000-8000-000000000000');
    expect(denied.status()).toBe(403);
    expect(await denied.text()).not.toContain(fullNumber);
    await withDb(async client => {
      const rows=await client.query(`SELECT row_to_json(a)::text AS data FROM app.payee_access_log a WHERE actor_id=$1`,[USERS.tenant]);
      expect(rows.rows.some(row => row.data.includes(fullNumber))).toBe(false);
      await client.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}' WHERE key='payee_details'`);
      await client.query(`UPDATE organizations SET feature_flags=feature_flags-'payee_details' WHERE id=$1`,[ORG_ID]);
    });
    expect(errors).toEqual([]);
  });
}


test("explicit payee HTTP attempts audit unauthenticated and verified no-org identity", async ({page}) => {
  const anonymousBefore = await withDb(async client => Number((await client.query(
    "SELECT count(*) AS n FROM app.payee_access_log WHERE operation='ingress' AND reason='unauthenticated'",
  )).rows[0].n));
  expect((await page.request.post('/api/payee/00000000-0000-4000-8000-000000000000')).status()).toBe(401);
  const anonymousAfter = await withDb(async client => Number((await client.query(
    "SELECT count(*) AS n FROM app.payee_access_log WHERE operation='ingress' AND reason='unauthenticated'",
  )).rows[0].n));
  expect(anonymousAfter-anonymousBefore).toBe(1);
  const id=randomUUID(), token=randomBytes(32).toString('hex');
  await withDb(async client => {
    await client.query("INSERT INTO auth.users(id,email) VALUES ($1,$2)",[id,`${id}@no-org.example.test`]);
    await client.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",[id,createHash('sha256').update(token).digest('hex')]);
  });
  try {
    await page.context().addCookies([{name:SESSION_COOKIE,value:token,url:'http://127.0.0.1:43123',httpOnly:true,sameSite:'Lax'}]);
    const response=await page.request.post('/api/payee/00000000-0000-4000-8000-000000000000',{data:{userId:USERS.admin,orgId:ORG_ID}});
    expect(response.status()).toBe(401);
    const rows=await withDb(client => client.query("SELECT actor_id::text,org_id,reason FROM app.payee_access_log WHERE actor_id=$1 AND operation='ingress'",[id]));
    expect(rows.rows).toEqual([{actor_id:id,org_id:null,reason:'no_context'}]);
    expect(await response.text()).not.toContain(fullNumber);
  } finally {
    await withDb(client => client.query("DELETE FROM auth.users WHERE id=$1",[id]));
  }
});
