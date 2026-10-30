import { expect,test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { ORG_ID } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS,resetDemo,signIn } from "./session";

const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
if(process.env.DEMO_MODE!=="true") throw new Error("Disposable demo mode required");
async function db<T>(fn:(c:Client)=>Promise<T>){const c=new Client({connectionString:url});await c.connect();try{return await fn(c);}finally{await c.end();}}
async function search(page:import('@playwright/test').Page,q:string){await page.goto('/m/tenants');await page.getByTestId('list-search').fill(q);await page.getByTestId('list-search-form').locator('button[type="submit"]').click();await expect(page.getByTestId('tenant-directory')).toBeVisible();}

test('directory shows original zero-lease and co-tenant contacts while accountant contact fields remain private at both widths',async({page},info)=>{
 const errors:string[]=[];
 page.on('pageerror',()=>errors.push('page error'));
 page.on('console',m=>{if(m.type()==='error') errors.push('console error');});
 page.on('response',r=>{if(r.status()>=500) errors.push('server error');});
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&!['127.0.0.1','localhost'].includes(u.hostname)){errors.push('nonlocal request blocked');await route.abort();return;}await route.continue();});
 await resetDemo(page);await signIn(page,ACCOUNTS.manager);await page.goto('/m/tenants');await expect(page.getByTestId('tenant-directory')).toHaveCount(0);await expect(page.getByTestId('tenant-list')).toBeVisible();await expect(page.getByTestId('tenant-list').locator('tbody a[href^="/m/tenants/"]').first()).toBeVisible();
 const zero=randomUUID(),co=randomUUID();
 const saved=await db(async c=>{
  const prior=(await c.query(`SELECT value FROM platform_settings WHERE key='tenant_directory_edit'`)).rows[0];
  const flags=(await c.query(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].feature_flags;
  await c.query(`INSERT INTO contacts(id,org_id,is_tenant,display_name,email,phone_e164) VALUES($1,$3,true,'Directory Zero','directory-zero@example.test','+19995550101'),($2,$3,true,'Directory Co','directory-co@example.test','+19995550102')`,[zero,co,ORG_ID]);
  const lease=(await c.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 ORDER BY id LIMIT 1`,[ORG_ID])).rows[0];
  await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')`,[ORG_ID,lease.id,co]);
  await c.query(`INSERT INTO platform_settings(key,value,description) VALUES('tenant_directory_edit',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)),'local directory fixture') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[ORG_ID]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags||'{"tenant_directory_edit":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  return {prior,flags};
 });
 try {
  for(const width of [390,1280]) {
   await page.setViewportSize({width,height:850});await signIn(page,ACCOUNTS.manager);await search(page,'Directory ');
   await expect(page.getByTestId('directory-contact')).toHaveCount(2);await expect(page.getByTestId('tenant-directory')).toContainText('directory-zero@example.test');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
   await page.screenshot({path:info.outputPath(`manager-list-${width}.png`),fullPage:true});
   await page.getByRole('link',{name:'Directory Zero',exact:true}).click();await expect(page.getByTestId('directory-history')).toBeVisible();await expect(page.getByTestId('directory-history').locator('tbody tr')).toHaveCount(0);expect(new URL(page.url()).pathname).toBe(`/m/tenants/${zero}`);
   await page.screenshot({path:info.outputPath(`zero-detail-${width}.png`),fullPage:true});
   await search(page,'Directory Co');await page.getByRole('link',{name:'Directory Co',exact:true}).click();await expect(page.getByTestId('directory-history').locator('tbody tr')).toHaveCount(1);await page.reload();await expect(page.getByTestId('directory-history').locator('tbody tr')).toHaveCount(1);expect(new URL(page.url()).pathname).toBe(`/m/tenants/${co}`);
   await page.screenshot({path:info.outputPath(`co-detail-${width}.png`),fullPage:true});
   await search(page,'directory-zero@example.test');await expect(page.getByTestId('directory-contact')).toHaveCount(1);
   await signIn(page,ACCOUNTS.accountant);await search(page,'directory-zero@example.test');await expect(page.getByTestId('directory-contact')).toHaveCount(0);
   await search(page,'Directory Zero');await expect(page.getByTestId('directory-contact')).toHaveCount(1);await expect(page.getByTestId('tenant-directory')).not.toContainText('directory-zero@example.test');await expect(page.getByTestId('tenant-directory')).not.toContainText('+19995550101');
   await page.getByRole('link',{name:'Directory Zero',exact:true}).click();await expect(page.getByTestId('directory-history')).toBeVisible();await expect(page.locator('main')).not.toContainText('directory-zero@example.test');await expect(page.locator('main')).not.toContainText('+19995550101');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
   await page.screenshot({path:info.outputPath(`accountant-detail-${width}.png`),fullPage:true});
  }
  const identities=await db(async c=>(await c.query(`SELECT id::text,user_id::text FROM contacts WHERE id IN ($1,$2) ORDER BY id`,[zero,co])).rows);
  expect(identities).toHaveLength(2);expect(identities.every(r=>r.user_id===null)).toBe(true);
  expect(errors).toEqual([]);
 } finally {
  await db(async c=>{await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,[ORG_ID,JSON.stringify(saved.flags)]);if(saved.prior) await c.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='tenant_directory_edit'`,[JSON.stringify(saved.prior.value)]);else await c.query(`DELETE FROM platform_settings WHERE key='tenant_directory_edit'`);});
 }
});
