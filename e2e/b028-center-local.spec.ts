import { chromium, expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { hashVendorToken, newVendorToken } from "../src/server/vendor-repair-rules";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test.use({trace:"off"}); // A job bearer must not be retained in a trace.
// No local browser: skip cleanly. The same 4-portal x 6-control OFF matrix also runs
// at server-render level in src/server/notification-off.integration.test.ts.
// Note: this is a test-level skip, so Playwright still boots the config's
// webServer (local Next dev on :43153 against the local DB) before skipping.
test.skip(!existsSync(chromium.executablePath()),"Chromium is not installed locally");
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

// B-028 package 5 — browser OFF matrix. Each portal is exercised through the
// real dev server: home entry hidden, notifications route 404, a well-formed
// same-origin mark attempt answers 404 and writes no read marker, and every
// public/app row (all organizations) is unchanged, apart from the session
// bookkeeping columns that any authenticated request refreshes.
const OFF_CONTROLS:{name:string;value:unknown;orgEnabled?:boolean}[]=[
 {name:"absent global",value:undefined},
 {name:"false global",value:{enabled:false,allowed_org_ids:[ORG_ID]}},
 {name:"malformed global enabled",value:{enabled:"true",allowed_org_ids:[ORG_ID]}},
 {name:"malformed global allowlist",value:{enabled:true,allowed_org_ids:ORG_ID}},
 {name:"org missing from allowlist",value:{enabled:true,allowed_org_ids:["00000000-0000-4000-8000-0000000000ff"]}},
 {name:"false org control",value:{enabled:true,allowed_org_ids:[ORG_ID]},orgEnabled:false},
];
const SESSION_BOOKKEEPING=new Set(["last_active_at","expires_at"]);
async function snapshotRows(c:Client) {
 const tables=(await c.query<{schema:string;name:string}>(`SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname IN ('public','app') ORDER BY 1,2`)).rows;
 const out:Record<string,unknown>={};
 for(const {schema,name} of tables) {
  const q=[schema,name].map(s=>'"'+s.replaceAll('"','""')+'"').join('.');
  const strip=schema==="public" && name==="auth_sessions" ? [...SESSION_BOOKKEEPING].map(col=>` - '${col}'`).join('') : '';
  out[`${schema}.${name}`]=(await c.query(`SELECT coalesce(jsonb_agg(r ORDER BY r::text),'[]'::jsonb) AS rows FROM (SELECT to_jsonb(t)${strip} AS r FROM ${q} t) s`)).rows[0].rows;
 }
 return out;
}

test("OFF matrix: four portals hide the center, 404 the route and write no marker for every disabled control",async({browser,baseURL},info)=>{
 const origin=new URL(baseURL!).origin;
 const errors:string[]=[];
 const offPaths=new Set<string>();
 const guard=async(page:import("@playwright/test").Page)=>{
  page.on("pageerror",()=>errors.push("page error"));
  page.on("console",message=>{
   if(message.type()!=="error") return;
   let path=""; try {path=new URL(message.location().url).pathname;} catch { /* no source URL */ }
   if(!(offPaths.has(path) && /\b404\b/.test(message.text()))) errors.push("console error");
  });
  page.on("response",response=>{if(response.status()>=500) errors.push("server error");});
  await page.route("**/*",async route=>{
   const target=new URL(route.request().url());
   if((target.protocol==="http:"||target.protocol==="https:") && !["127.0.0.1","localhost"].includes(target.hostname)) {errors.push("nonlocal request blocked");await route.abort();return;}
   await route.continue();
  });
 };
 const contexts:import("@playwright/test").BrowserContext[]=[];
 const newPage=async()=>{const ctx=await browser.newContext({baseURL});contexts.push(ctx);const page=await ctx.newPage();await guard(page);return page;};
 const setup=await newPage();
 await resetDemo(setup);
 const prior=await db(async c=>(await c.query<{platform:unknown;org:unknown}>(`SELECT (SELECT value FROM platform_settings WHERE key='notification_center_v2') platform,(SELECT feature_flags FROM organizations WHERE id=$1) org`,[ORG_ID])).rows[0]);
 const fixture=await db(async c=>{
  const l=(await c.query<{lease:string;tenant:string;owner:string;property:string;invoice:string}>(`SELECT l.id::text lease,ct.id::text tenant,oc.id::text owner,l.property_id::text property,i.id::text invoice
    FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.id=lp.contact_id JOIN property_owners po ON po.property_id=l.property_id
    JOIN contacts oc ON oc.id=po.owner_contact_id JOIN invoices i ON i.lease_id=l.id WHERE l.org_id=$1 AND ct.user_id=$2 AND oc.user_id=$3 LIMIT 1`,[ORG_ID,USERS.tenant,USERS.owner])).rows[0];
  if(!l) throw new Error("Synthetic linked lease unavailable");
  await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key IN ('rent_reminders_v2','payment_results_v2')`);
  await c.query(`UPDATE organizations SET feature_flags=(feature_flags-'rent_reminders_v2'-'payment_results_v2') || '{"notification_center_v2":true,"vendor_link":false}'::jsonb,plan_tier='beta' WHERE id=$1`,[ORG_ID]);
  const member=(await c.query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,[ORG_ID,USERS.manager])).rows[0].id;
  const vendor=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,'Synthetic OFF vendor','+886900111223') RETURNING id::text`,[ORG_ID])).rows[0].id;
  const ticket=(await c.query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,lease_id,title,status,reported_by_user,reported_by_contact_id,assigned_vendor_contact_id) VALUES($1,987656,$2,$3,'Synthetic OFF','open',$4,$5,$6) RETURNING id::text`,[ORG_ID,l.property,l.lease,USERS.tenant,l.tenant,vendor])).rows[0].id;
  const token=newVendorToken();
  const job=(await c.query<{id:string;created_at:string}>(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,vendor_contact_id) VALUES($1,$2,'Synthetic','+886900111223','day',$3,clock_timestamp()+interval '1 hour',$4) RETURNING id::text,created_at::text`,[ORG_ID,ticket,hashVendorToken(token),vendor])).rows[0];
  await c.query('BEGIN');
  const source=(await c.query<{id:string;created_at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text`,[ORG_ID,l.lease,l.invoice,randomUUID()])).rows[0];
  const bill=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,source.id,source.created_at])).rows[0].id;
  const jobEvent=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,ticket_id,job_id,occurred_at) VALUES($1,'vendor_job_assigned',$2,$3,$4) RETURNING id::text`,[ORG_ID,ticket,job.id,job.created_at])).rows[0].id;
  const rows=(await c.query<{id:string;persona:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id,contact_id,ticket_id,job_id) VALUES
    ($1,$2,'staff',$3,$4,NULL,NULL,NULL),($1,$2,'tenant',$5,NULL,$6,NULL,NULL),($1,$7,'owner',$8,NULL,$9,NULL,NULL),($1,$7,'vendor_job',NULL,NULL,NULL,$10,$11) RETURNING id::text,persona`,[ORG_ID,bill,USERS.manager,member,USERS.tenant,l.tenant,jobEvent,USERS.owner,l.owner,ticket,job.id])).rows;
  await c.query('COMMIT');
  const recipient=Object.fromEntries(rows.map(r=>[r.persona,r.id]));
  return {token,jobId:job.id,leaseId:l.lease,recipient};
 });
 const configure=(value:unknown,orgEnabled=true)=>db(async c=>{
  await c.query(`DELETE FROM platform_settings WHERE key='notification_center_v2'`);
  if(value!==undefined) await c.query(`INSERT INTO platform_settings(key,value) VALUES('notification_center_v2',$1::jsonb)`,[JSON.stringify(value)]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('notification_center_v2',$2::boolean) WHERE id=$1`,[ORG_ID,orgEnabled]);
 });
 const results:{control:string;portal:string;entryHidden:boolean;routeStatus:number|undefined;markStatus:number;markers:number;rowsUnchanged:boolean}[]=[];
 try {
  const portals:{name:string;home:string;route:string;page:import("@playwright/test").Page;mark:()=>Promise<number>}[]=[];
  for(const [name,account,persona] of [["m",ACCOUNTS.manager,"staff"],["t",ACCOUNTS.tenant,"tenant"],["o",ACCOUNTS.owner,"owner"]] as const) {
   const page=await newPage();
   await signIn(page,account);
   if(name==="t") {
    await page.goto("/t");
    const picker=page.getByTestId("lease-picker");
    if(await picker.count()) {
     await picker.locator("form").filter({has:page.locator(`input[name="leaseId"][value="${fixture.leaseId}"]`)}).getByRole("button").click();
     await expect(picker).toHaveCount(0);
    }
   }
   offPaths.add(`/${name}/notifications`);
   portals.push({name,home:`/${name}`,route:`/${name}/notifications`,page,
    mark:async()=>(await page.request.post("/api/notification-center/mark",{headers:{origin,"sec-fetch-site":"same-origin"},data:{recipientId:fixture.recipient[persona]}})).status()});
  }
  const vendorPage=await newPage();
  const vendorHome=`/v/${encodeURIComponent(fixture.token)}`;
  offPaths.add(`${vendorHome}/notifications`);
  portals.push({name:"v",home:vendorHome,route:`${vendorHome}/notifications`,page:vendorPage,
   mark:async()=>(await vendorPage.request.post("/api/notification-center/vendor-mark",{headers:{origin,"sec-fetch-site":"same-origin"},data:{recipientId:fixture.recipient.vendor_job,token:fixture.token}})).status()});

  // Positive control: valid ON configuration shows each entry and unread item,
  // so OFF hiding below cannot be explained by bad sessions or fixtures.
  await configure({enabled:true,allowed_org_ids:[ORG_ID]});
  for(const p of portals) {
   expect((await p.page.goto(p.home))?.status(),p.name).toBe(200);
   await expect(p.page.getByTestId("notification-center-entry"),p.name).toHaveCount(1);
   expect((await p.page.goto(p.route))?.status(),p.name).toBe(200);
   await expect(p.page.getByTestId("notification-item"),p.name).toHaveCount(1);
   await expect(p.page.getByTestId("notification-read-state"),p.name).toHaveText(/^(未讀|Unread)$/);
  }

  for(const control of OFF_CONTROLS) {
   await configure(control.value,control.orgEnabled ?? true);
   for(const p of portals) {
    await test.step(`${p.name}: ${control.name}`,async()=>{
     const before=await db(snapshotRows);
     expect((await p.page.goto(p.home))?.status(),`${p.name} home renders`).toBe(200);
     await expect(p.page.locator("body")).not.toBeEmpty();
     const entryHidden=(await p.page.getByTestId("notification-center-entry").count())===0;
     const routeStatus=(await p.page.goto(p.route))?.status();
     await expect(p.page.getByTestId("notification-item")).toHaveCount(0);
     const markStatus=await p.mark();
     const markers=await db(async c=>(await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1`,[ORG_ID])).rowCount ?? 0);
     const after=await db(snapshotRows);
     const changed=Object.keys(before).filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k]));
     results.push({control:control.name,portal:p.name,entryHidden,routeStatus,markStatus,markers,rowsUnchanged:changed.length===0});
     expect(entryHidden,"entry hidden").toBe(true);
     expect(routeStatus,"route unavailable").toBe(404);
     expect(markStatus,"mark attempt denied").toBe(404);
     expect(markers,"no read marker").toBe(0);
     expect(changed,"rows unchanged").toEqual([]);
    });
   }
  }

  // Re-enable: each retained recipient is still unread (OFF consumed nothing)
  // and the identical mark request now succeeds, proving the OFF 404s came
  // from the control, not from a malformed or cross-origin request.
  await configure({enabled:true,allowed_org_ids:[ORG_ID]});
  for(const p of portals) {
   expect((await p.page.goto(p.route))?.status(),p.name).toBe(200);
   await expect(p.page.getByTestId("notification-read-state"),p.name).toHaveText(/^(未讀|Unread)$/);
   expect(await p.mark(),`${p.name} ON mark`).toBe(200);
  }
  expect(await db(async c=>(await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1`,[ORG_ID])).rowCount)).toBe(4);
  expect(errors).toEqual([]);
 } finally {
  await info.attach("b028-off-matrix.json",{body:JSON.stringify({cases:results.length,results},null,1),contentType:"application/json"});
  if(process.env.B028_OFF_MATRIX_JSON) {const {writeFileSync}=await import("node:fs");writeFileSync(process.env.B028_OFF_MATRIX_JSON,JSON.stringify({cases:results.length,results},null,1)+"\n");}
  await db(async c=>{
   await c.query(`UPDATE repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1`,[fixture.jobId]);
   await c.query(`DELETE FROM platform_settings WHERE key='notification_center_v2'`);
   if(prior.platform!==null) await c.query(`INSERT INTO platform_settings(key,value) VALUES('notification_center_v2',$1::jsonb)`,[JSON.stringify(prior.platform)]);
   await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,[ORG_ID,JSON.stringify(prior.org)]);
  });
  for(const ctx of contexts) await ctx.close();
 }
});
