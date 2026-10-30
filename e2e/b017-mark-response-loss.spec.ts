import { expect, test, type Request as BrowserRequest } from "@playwright/test";
import { B017_LOCAL_ORIGIN } from "../playwright.b017-localhost.config";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test.use({trace:"off"});
const target=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
if(process.env.DEMO_MODE!=="true") throw new Error("Disposable demo mode required");
test("lost response after committed mark stays unknown until reload",async({page})=>{
 const errors:string[]=[],consoleErrors:{path:string;expectedText:boolean;duringFault:boolean}[]=[];
 let expectedRequest:BrowserRequest|null=null,expectedFailures=0,aborted=false,faultActive=false;
 page.on("pageerror",()=>errors.push("page error"));
 page.on("console",message=>{
  if(message.type()!=="error") return;
  let path="";try{path=new URL(message.location().url).pathname;}catch{}
  consoleErrors.push({path,expectedText:message.text()==="Failed to load resource: net::ERR_FAILED",duringFault:faultActive});
 });
 page.on("response",response=>{if(response.status()>=500) errors.push("server error");});
 await page.route("**/*",async route=>{const u=new URL(route.request().url());if((u.protocol==="http:"||u.protocol==="https:")&&!['127.0.0.1','localhost'].includes(u.hostname)){errors.push("nonlocal request blocked");await route.abort();return;}await route.continue();});
 await resetDemo(page);await signIn(page,ACCOUNTS.manager);
 const c=new Client({connectionString:target}),lock=new Client({connectionString:target});await c.connect();await lock.connect();
 const prior=(await c.query<{platform:unknown;org:unknown}>(`SELECT (SELECT value FROM platform_settings WHERE key='notification_center_v2') platform,(SELECT feature_flags FROM organizations WHERE id=$1) org`,[ORG_ID])).rows[0];
 try {
  const src=(await c.query<{lease:string;invoice:string;member:string}>(`SELECT l.id::text lease,i.id::text invoice,m.id::text member FROM leases l JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id
   JOIN org_members m ON m.org_id=l.org_id AND m.user_id=$2 AND m.role='manager' AND m.status='active' WHERE l.org_id=$1 LIMIT 1`,[ORG_ID,USERS.manager])).rows[0];expect(src).toBeTruthy();
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query('BEGIN');
  const source=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[ORG_ID,src.lease,src.invoice,randomUUID()])).rows[0];
  const event=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,source.id,source.at])).rows[0];
  const recipient=(await c.query<{id:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id) VALUES($1,$2,'staff',$3,$4) RETURNING id::text`,[ORG_ID,event.id,USERS.manager,src.member])).rows[0];await c.query('COMMIT');
  await page.goto('/m/notifications');await expect(page.getByTestId('notification-read-state')).toContainText(/未讀|Unread/);
  page.on("requestfailed",request=>{
   if(request===expectedRequest && request.failure()?.errorText==="net::ERR_FAILED") expectedFailures++;
   else errors.push("unexpected failed request");
  });
  await page.route('**/api/notification-center/mark',async route=>{
   if(aborted){await route.continue();return;}
   aborted=true;expectedRequest=route.request();
   const requested=new URL(expectedRequest.url());
   expect(expectedRequest.method()).toBe('POST');expect(requested.origin).toBe(B017_LOCAL_ORIGIN);expect(requested.pathname).toBe('/api/notification-center/mark');
   expect(expectedRequest.postDataJSON()).toEqual({recipientId:recipient.id});
   const response=await route.fetch();expect(response.status()).toBe(200);expect(await response.json()).toEqual({status:'marked'});
   expect((await c.query<{n:number}>(`SELECT count(*)::int n FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rows[0].n).toBe(1);
   faultActive=true;await route.abort('failed');
  });
  await page.getByTestId('notification-mark').click();
  await expect(page.getByTestId('notification-read-state')).toContainText(/無法確認|Unable to confirm/);
  await expect(page.getByTestId('notification-read-state')).not.toContainText(/未讀|已讀|Unread|Read/);
  await expect.poll(()=>expectedFailures).toBe(1);faultActive=false;
  await lock.query('BEGIN');await lock.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);
  await page.getByTestId('notification-mark').click();await expect(page.getByTestId('notification-mark-busy')).toBeVisible();
  await expect(page.getByTestId('notification-read-state')).toContainText(/無法確認|Unable to confirm/);
  await expect(page.getByTestId('notification-read-state')).not.toContainText(/未讀|已讀|Unread|Read/);
  expect((await c.query<{n:number}>(`SELECT count(*)::int n FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rows[0].n).toBe(1);
  await lock.query('ROLLBACK');
  await page.reload();await expect(page.getByTestId('notification-read-state')).toContainText(/已讀|Read/);
  expect((await c.query<{n:number}>(`SELECT count(*)::int n FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rows[0].n).toBe(1);
  expect(aborted).toBe(true);expect(expectedFailures).toBe(1);expect(errors).toEqual([]);
  expect(consoleErrors.every(entry=>entry.path==='/api/notification-center/mark' && entry.expectedText && entry.duringFault)).toBeTruthy();expect(consoleErrors.length).toBeLessThanOrEqual(1);
 } finally {
  try{await lock.query('ROLLBACK');}catch{}await lock.end();
  try{await c.query('ROLLBACK');}catch{}
  if(prior){await c.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='notification_center_v2'`,[JSON.stringify(prior.platform)]);await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,[ORG_ID,JSON.stringify(prior.org)]);}
  await c.end();
 }
});
