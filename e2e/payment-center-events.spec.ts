import { expect,test,type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ORG_ID,USERS } from "../src/server/ids";
import { confirmPayment,rejectPayment,reversePayment } from "../src/server/domain";
import type { Session } from "../src/server/types";
import { ACCOUNTS,signIn } from "./session";
const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE),database=decodeURIComponent(url.pathname.slice(1));
const origin="http://localhost:43141";
if(process.env.DEMO_MODE!=="true" || !/^condola_b010_center_[a-z0-9_]+$/.test(database) || process.env.B010_OWNED_DATABASE!==database) throw new Error("Owned local payment center browser database required");
type Control={key:string;value:unknown;description:string|null;updated_at:string};
function guard(info:TestInfo){if(!info.config.configFile?.endsWith("/e2e/b010-payment-center-private-playwright.config.ts") || info.project.use.trace!=="off" || info.project.use.video!=="off" || info.project.use.screenshot!=="off" || info.config.reporter.length!==1 || info.config.reporter[0][0]!=="line" || process.env.B010_PRIVATE_HTTP_CONFIG!=="1" || process.env.PLAYWRIGHT_NO_COPY_PROMPT!=="1") throw new Error("Private payment center browser configuration required");}
for(const width of [390,1280]) test(`actual payer payment center at ${width}px`,async({page},info)=>{
 guard(info);await page.setViewportSize({width,height:900});
 const errors:string[]=[];page.on("pageerror",()=>errors.push("page error"));page.on("console",m=>{if(m.type()==="error")errors.push("console error");});page.on("response",r=>{if(r.status()>=500)errors.push("server error");});
 await page.context().route("**/*",async route=>{try{if(new URL(route.request().url()).origin===origin){await route.continue();return;}}catch{/* reject malformed origin */}errors.push("off-origin request");await route.abort();});
 const c=new Client({connectionString:url.href});let saved:{controls:Control[];flags:unknown}|undefined;let primary:string|undefined,restore=false,phase="connect";
 try{
  await c.connect();await signIn(page,ACCOUNTS.admin);phase="reset";
  const reset=await page.request.post(`${origin}/api/demo/reset`,{data:{},maxRedirects:0});expect(reset.status()).toBe(200);await signIn(page,ACCOUNTS.admin);
  phase="baseline";
  saved={controls:(await c.query<Control>(`SELECT key,value,description,updated_at::text AS updated_at FROM platform_settings WHERE key IN ('notification_center_v2','payment_results_v2') ORDER BY key`)).rows,flags:(await c.query(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].feature_flags};
  expect(saved.controls.every(x=>(x.value as {enabled?:unknown}).enabled!==true)).toBe(true);expect((saved.flags as Record<string,unknown>).notification_center_v2!==true).toBe(true);
  phase="controls";await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',key='notification_center_v2','allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('notification_center_v2','payment_results_v2')`,[ORG_ID]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true,"payment_results_v2":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  const payer=(await c.query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL`,[ORG_ID,USERS.tenant])).rows[0];expect(Boolean(payer)).toBe(true);
  const property=(await c.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'B010 browser','TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID])).rows[0].id;
  const unit=(await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'B010') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
  const lease={id:(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2026-01-01','TWD',0) RETURNING id::text`,[ORG_ID,property,unit])).rows[0].id,property,payer:payer.id,currency:"TWD"};
  await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease.id,lease.payer]);
  const invoice=(await c.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor) VALUES($1,$2,$3,$4,'TWD','2026-11-01','open',100000) RETURNING id::text`,[ORG_ID,property,lease.id,`B010-${randomUUID()}`])).rows[0].id;
  await c.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic',1,100000,100000)`,[ORG_ID,invoice]);
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  const session:Session={userId:USERS.admin,sessionId:sid,kind:"staff",role:"admin",orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"zh-TW",calendar:"gregorian",leaseId:null,email:"synthetic@example.test",name:"Synthetic"};
  const submitted=async()=>(await c.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by,reference) VALUES($1,$2,$3,$4,$5,100,'2026-11-01','bank_transfer','submitted','tenant_portal',$6,'B010-private-payment-marker') RETURNING id::text`,[ORG_ID,lease.property,lease.id,lease.payer,lease.currency,USERS.tenant])).rows[0].id;
  phase="financial transitions";const confirmed=await submitted(),rejected=await submitted();await confirmPayment(session,confirmed);await rejectPayment(session,rejected,"Synthetic reason");await reversePayment(session,confirmed,"Synthetic correction");
  const recipients=(await c.query<{id:string;kind:string}>(`SELECT r.id::text,e.kind FROM app.b028_center_recipients r JOIN app.b028_center_events e ON e.org_id=r.org_id AND e.id=r.event_id JOIN app.b017_occurrences n ON n.org_id=e.org_id AND n.id=e.neutral_source_id WHERE n.org_id=$1 AND n.payment_id IN ($2,$3) AND r.principal_user_id=$4 ORDER BY e.kind`,[ORG_ID,confirmed,rejected,USERS.tenant])).rows;expect(recipients.length).toBe(3);
  phase="tenant list";await signIn(page,ACCOUNTS.tenant);await page.goto("/t");const picker=page.getByTestId("lease-picker");if(await picker.count()){await picker.locator("form").filter({has:page.locator(`input[name="leaseId"][value="${lease.id}"]`)}).getByRole("button").click();}await page.goto("/t/notifications");
  await expect(page.getByTestId("notification-center")).toBeVisible();
  for(const label of ["付款紀錄已確認","付款回報已退回","付款紀錄已撤銷"]){await expect(page.getByTestId("notification-item").filter({hasText:label})).toBeVisible();}
  expect((await page.content()).includes("B010-private-payment-marker")).toBe(false);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
  phase="tenant mark";const first=recipients[0];const row=page.getByTestId("notification-item").filter({hasText:"付款紀錄已確認"});await row.getByTestId("notification-mark").click();await expect(row.getByTestId("notification-read-state")).toHaveText("已讀");await page.reload();
  const read=(await c.query(`SELECT rd.recipient_id::text FROM app.b028_center_reads rd JOIN app.b028_center_recipients r ON r.org_id=rd.org_id AND r.id=rd.recipient_id WHERE rd.org_id=$1 AND r.principal_user_id=$2 AND rd.recipient_id=ANY($3::uuid[])`,[ORG_ID,USERS.tenant,recipients.map(x=>x.id)])).rows;expect(read.length===1 && read[0].recipient_id===first.id).toBe(true);
  await page.screenshot({path:info.outputPath(`actual-payer-${width}.png`),fullPage:true});
  phase="other tenant isolation";await signIn(page,ACCOUNTS.tenant2);await page.goto("/t/notifications");for(const recipient of recipients)expect((await page.content()).includes(recipient.id)).toBe(false);
  expect((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id IN ($1,$2)`,[confirmed,rejected])).rowCount).toBe(0);expect(errors).toEqual([]);
 }catch{primary=phase;}
 if(saved){try{await c.query("BEGIN");await c.query(`DELETE FROM platform_settings WHERE key IN ('notification_center_v2','payment_results_v2')`);for(const item of saved.controls)await c.query(`INSERT INTO platform_settings(key,value,description,updated_at) VALUES($1,$2::jsonb,$3,$4::timestamptz)`,[item.key,JSON.stringify(item.value),item.description,item.updated_at]);await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,[ORG_ID,JSON.stringify(saved.flags)]);const controls=(await c.query(`SELECT key,value,description,updated_at::text AS updated_at FROM platform_settings WHERE key IN ('notification_center_v2','payment_results_v2') ORDER BY key`)).rows;const flags=(await c.query(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].feature_flags;expect(JSON.stringify(controls)===JSON.stringify(saved.controls) && JSON.stringify(flags)===JSON.stringify(saved.flags)).toBe(true);await c.query("COMMIT");}catch{restore=true;try{await c.query("ROLLBACK");}catch{/* retain restoration failure */}}}
 try{await c.end();}catch{restore=true;}
 if(primary || restore)throw new Error([primary ? `Payment center journey failed at ${primary}` : "",restore ? "Payment center control restoration failed" : "",...["page error","console error","server error","off-origin request"].map(x=>`${x}: ${errors.filter(y=>y===x).length}`)].filter(Boolean).join("; "));
});
