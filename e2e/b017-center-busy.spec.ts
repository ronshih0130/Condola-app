import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test.use({trace:"off"});
const target=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
if(process.env.DEMO_MODE!=="true") throw new Error("Disposable demo mode required");
async function connect(){const client=new Client({connectionString:target});await client.connect();return client;}
test("busy admission and mark retry preserve unread state at both widths",async({page},info)=>{
 const errors:string[]=[];
 page.on("pageerror",()=>errors.push("page error"));
 page.on("console",m=>{if(m.type()==="error") errors.push("console error");});
 page.on("response",r=>{if(r.status()>=500) errors.push("server error");});
 await page.route("**/*",async route=>{const u=new URL(route.request().url());if((u.protocol==="http:"||u.protocol==="https:")&&!['127.0.0.1','localhost'].includes(u.hostname)){errors.push("nonlocal request blocked");await route.abort();return;}await route.continue();});
 await resetDemo(page);await signIn(page,ACCOUNTS.manager);
 const c=await connect(),lock=await connect();
 const prior=(await c.query<{platform:unknown;org:unknown}>(`SELECT (SELECT value FROM platform_settings WHERE key='notification_center_v2') platform,
   (SELECT feature_flags FROM organizations WHERE id=$1) org`,[ORG_ID])).rows[0];
 try {
  const src=(await c.query<{lease:string;invoice:string;member:string}>(`SELECT l.id::text lease,i.id::text invoice,m.id::text member FROM leases l
   JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id JOIN org_members m ON m.org_id=l.org_id AND m.user_id=$2 AND m.role='manager' AND m.status='active'
   WHERE l.org_id=$1 LIMIT 1`,[ORG_ID,USERS.manager])).rows[0];expect(src).toBeTruthy();
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query('BEGIN');
  const old=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
   VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[ORG_ID,src.lease,src.invoice,randomUUID()])).rows[0];
  const event=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,old.id,old.at])).rows[0];
  const recipient=(await c.query<{id:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id)
   VALUES($1,$2,'staff',$3,$4) RETURNING id::text`,[ORG_ID,event.id,USERS.manager,src.member])).rows[0];await c.query('COMMIT');
  const markPath='/api/notification-center/mark';
  for(const [origin,site] of [['http://other.example.test','cross-site'],['null','same-origin']] as const) {
   const response=await page.request.post(markPath,{headers:{origin,'sec-fetch-site':site},data:{recipientId:recipient.id}});expect(response.status()).toBe(403);
  }
  const extra=await page.request.post(markPath,{headers:{origin:'http://127.0.0.1:43123','sec-fetch-site':'same-origin'},data:{recipientId:recipient.id,actorId:USERS.manager}});
  expect(extra.status()).toBe(400);
  expect((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rowCount).toBe(0);
  for(const width of [390,1280]) {
   await page.setViewportSize({width,height:850});await c.query(`DELETE FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id]);
   await lock.query('BEGIN');await lock.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);
   await page.goto('/m/notifications');await expect(page.getByTestId('notification-busy')).toBeVisible();
   await page.screenshot({path:info.outputPath(`manager-${width}-busy.png`),fullPage:true});
   await lock.query('ROLLBACK');
   const reload=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/m/notifications' && r.request().method()==='GET' && r.status()===200;});
   await page.getByTestId('notification-busy').getByRole('link').click();await reload;
   await expect(page.getByTestId('notification-item')).toHaveCount(1);
   await expect(page.getByTestId('notification-read-state')).toContainText(/未讀|Unread/);
   await lock.query('BEGIN');await lock.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);
   await page.getByTestId('notification-mark').click();await expect(page.getByTestId('notification-mark-busy')).toBeVisible();
   await page.screenshot({path:info.outputPath(`manager-${width}-mark-busy.png`),fullPage:true});
   await expect(page.getByTestId('notification-read-state')).toContainText(/未讀|Unread/);
   expect((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rowCount).toBe(0);
   await lock.query('ROLLBACK');await page.getByTestId('notification-mark').click();
   await expect(page.getByTestId('notification-read-state')).toContainText(/已讀|Read/);await page.reload();
   await expect(page.getByTestId('notification-item')).toHaveCount(1);await expect(page.getByTestId('notification-read-state')).toContainText(/已讀|Read/);
   expect((await c.query<{n:number}>(`SELECT count(*)::int n FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rows[0].n).toBe(1);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  }
  expect(errors).toEqual([]);
 } finally {
  try{await lock.query('ROLLBACK');}catch{}await lock.end();
  try{await c.query('ROLLBACK');}catch{}
  if(prior) {
   await c.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='notification_center_v2'`,[JSON.stringify(prior.platform)]);
   await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,[ORG_ID,JSON.stringify(prior.org)]);
  }
  await c.end();
 }
});
