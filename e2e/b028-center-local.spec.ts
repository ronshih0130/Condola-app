import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { hashVendorToken, newVendorToken } from "../src/server/vendor-repair-rules";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test.use({trace:"off"}); // A job bearer must not be retained in a trace.
const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
if(process.env.DEMO_MODE!=="true") throw new Error("Disposable demo mode required");
async function db<T>(fn:(c:Client)=>Promise<T>) {const c=new Client({connectionString:url});await c.connect();try{return await fn(c);}finally{await c.end();}}

test("synthetic notifications are independently read in four actual portals",async({page},info)=>{
 const errors:string[]=[];
 let expectedOff=false;
 page.on("pageerror",()=>errors.push("page error"));
 page.on("console",message=>{
  if(message.type()!=="error") return;
  let path=""; try {path=new URL(message.location().url).pathname;} catch { /* no source URL */ }
  if(!(expectedOff && path==="/m/notifications" && /\b404\b/.test(message.text()))) errors.push("console error");
 });
 page.on("response",response=>{if(response.status()>=500) errors.push("server error");});
 await page.route("**/*",async route=>{
  const target=new URL(route.request().url());
  if ((target.protocol==="http:" || target.protocol==="https:") && !["127.0.0.1","localhost"].includes(target.hostname)) {errors.push("nonlocal request blocked"); await route.abort(); return;}
  await route.continue();
 });
 await resetDemo(page);
 await signIn(page,ACCOUNTS.manager);
 await page.goto("/m");
 await expect(page.getByTestId("notification-center-entry")).toHaveCount(0);
 expectedOff=true;
 expect((await page.goto('/m/notifications'))?.status()).toBe(404);
 expectedOff=false;
 const fixture=await db(async c=>{
  const l=(await c.query<{lease:string;tenant:string;owner:string;property:string;invoice:string}>(`SELECT l.id::text lease,ct.id::text tenant,oc.id::text owner,l.property_id::text property,i.id::text invoice
    FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.id=lp.contact_id JOIN property_owners po ON po.property_id=l.property_id
    JOIN contacts oc ON oc.id=po.owner_contact_id JOIN invoices i ON i.lease_id=l.id WHERE l.org_id=$1 AND ct.user_id=$2 AND oc.user_id=$3 LIMIT 1`,[ORG_ID,USERS.tenant,USERS.owner])).rows[0];
  if(!l) throw new Error("Synthetic linked lease unavailable");
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key IN ('rent_reminders_v2','payment_results_v2')`);
  await c.query(`UPDATE organizations SET feature_flags=(feature_flags-'rent_reminders_v2'-'payment_results_v2') || '{"notification_center_v2":true,"vendor_link":false}'::jsonb,plan_tier='beta' WHERE id=$1`,[ORG_ID]);
  const member=(await c.query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,[ORG_ID,USERS.manager])).rows[0].id;
  const vendor=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,'Synthetic vendor','+886900111222') RETURNING id::text`,[ORG_ID])).rows[0].id;
  const ticket=(await c.query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,lease_id,title,status,reported_by_user,reported_by_contact_id,assigned_vendor_contact_id) VALUES($1,987654,$2,$3,'Synthetic','open',$4,$5,$6) RETURNING id::text`,[ORG_ID,l.property,l.lease,USERS.tenant,l.tenant,vendor])).rows[0].id;
  const token=newVendorToken();
  const job=(await c.query<{id:string;created_at:string}>(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,vendor_contact_id) VALUES($1,$2,'Synthetic','+886900111222','day',$3,clock_timestamp()+interval '1 hour',$4) RETURNING id::text,created_at::text`,[ORG_ID,ticket,hashVendorToken(token),vendor])).rows[0];
  await c.query('BEGIN');
  const source=(await c.query<{id:string;created_at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text`,[ORG_ID,l.lease,l.invoice,randomUUID()])).rows[0];
  const bill=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,source.id,source.created_at])).rows[0].id;
  const jobEvent=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,ticket_id,job_id,occurred_at) VALUES($1,'vendor_job_assigned',$2,$3,$4) RETURNING id::text`,[ORG_ID,ticket,job.id,job.created_at])).rows[0].id;
  await c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id,contact_id,ticket_id,job_id) VALUES
    ($1,$2,'staff',$3,$4,NULL,NULL,NULL),($1,$2,'tenant',$5,NULL,$6,NULL,NULL),($1,$7,'owner',$8,NULL,$9,NULL,NULL),($1,$7,'vendor_job',NULL,NULL,NULL,$10,$11)`,[ORG_ID,bill,USERS.manager,member,USERS.tenant,l.tenant,jobEvent,USERS.owner,l.owner,ticket,job.id]);
  await c.query('COMMIT');
  return {token,jobId:job.id,leaseId:l.lease};
 });
 try {
 for(const width of [390,1280]) {
  await db(async c=>{await c.query(`DELETE FROM app.b028_center_reads WHERE org_id=$1`,[ORG_ID]);});
  await page.setViewportSize({width,height:850});
  for(const [account,path] of [[ACCOUNTS.manager,'/m/notifications'],[ACCOUNTS.tenant,'/t/notifications'],[ACCOUNTS.owner,'/o/notifications']] as const) {
   await signIn(page,account); await page.goto(path.split("/notifications")[0]);
   if (path === "/t/notifications") {
    const picker=page.getByTestId("lease-picker");
    await expect(picker).toBeVisible();
    const leaseForm=picker.locator("form").filter({has:page.locator(`input[name="leaseId"][value="${fixture.leaseId}"]`)});
    await leaseForm.getByRole("button").click();
    await expect(picker).toHaveCount(0);
   }
   await page.getByTestId("notification-center-entry").click();
   await expect(page.getByTestId('notification-item')).toHaveCount(1);
   await expect(page.getByTestId('notification-mark')).toBeVisible();
   const box=await page.getByTestId('notification-mark').boundingBox(); expect(box && box.height>=44).toBe(true);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
   await page.getByTestId('notification-mark').click();
   await expect(page.getByTestId('notification-item')).toHaveCount(1); await expect(page.getByTestId('notification-read-state')).toHaveText(/^(已讀|Read)$/);
   await page.reload(); await expect(page.getByTestId('notification-item')).toHaveCount(1); await expect(page.getByTestId('notification-read-state')).toHaveText(/^(已讀|Read)$/);
   await page.screenshot({path:info.outputPath(`${path.split('/')[1]}-${width}.png`),fullPage:true});
  }
  await page.context().clearCookies();
  expect((await page.context().cookies()).some(cookie=>cookie.name==="condola_session")).toBe(false);
  try {
   await page.goto(`/v/${encodeURIComponent(fixture.token)}`);
   await page.getByTestId("notification-center-entry").click();
  } catch {throw new Error("Vendor page unavailable");}
  await expect(page.getByTestId('notification-item')).toHaveCount(1);
  const vendorBox=await page.getByTestId('notification-mark').boundingBox(); expect(vendorBox && vendorBox.height>=44).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
  await page.getByTestId('notification-mark').click();
  await expect(page.getByTestId('notification-item')).toHaveCount(1); await expect(page.getByTestId('notification-read-state')).toHaveText(/^(已讀|Read)$/);
  await page.reload(); await expect(page.getByTestId('notification-item')).toHaveCount(1); await expect(page.getByTestId('notification-read-state')).toHaveText(/^(已讀|Read)$/);
  expect((await page.context().cookies()).some(cookie=>cookie.name==="condola_session")).toBe(false);
  await page.screenshot({path:info.outputPath(`vendor-${width}.png`),fullPage:true});
  const counts=await db(async c=>(await c.query<{n:string}>(`SELECT count(*)::text n FROM app.b028_center_reads WHERE org_id=$1`,[ORG_ID])).rows[0].n);
  expect(counts).toBe('4');
 }
 expect(errors).toEqual([]);
 } finally { await db(async c=>{await c.query(`UPDATE repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1`,[fixture.jobId]);}); }
});
