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
test("mark stays safe before hydration and works after hydration",async({page})=>{
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
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let held=0, documents=0, posts=0;
  await page.route(/\/_next\/static\/.*\.js(?:\?.*)?$/,async route=>{held++;await gate;await route.continue();});
  page.on('request',request=>{const u=new URL(request.url());if(u.pathname==='/m/notifications' && request.resourceType()==='document') documents++;if(u.pathname==='/api/notification-center/mark' && request.method()==='POST') posts++;});
  try {
   await page.goto('/m/notifications',{waitUntil:'commit'});
   const button=page.getByTestId('notification-mark');
   await expect(button).toBeVisible();await expect(button).toBeDisabled();expect(held).toBeGreaterThan(0);
   const initialDocuments=documents;
   const box=await button.boundingBox();expect(box).not.toBeNull();
   await page.mouse.click(box!.x+box!.width/2,box!.y+box!.height/2);
   await button.evaluate(element=>element.focus());
   await page.keyboard.press('Enter');await page.keyboard.press('Space');
   expect(documents).toBe(initialDocuments);expect(posts).toBe(0);
  } finally {release();}
  await expect(page.getByTestId('notification-mark')).toBeEnabled();
  const marked=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/notification-center/mark' && response.request().method()==='POST');
  await page.getByTestId('notification-mark').click();
  const response=await marked;expect(response.status()).toBe(200);expect(await response.json()).toEqual({status:'marked'});expect(posts).toBe(1);
  await expect(page.getByTestId('notification-read-state')).toContainText(/已讀|Read/);
  expect((await c.query<{n:number}>(`SELECT count(*)::int n FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipient.id])).rows[0].n).toBe(1);
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
