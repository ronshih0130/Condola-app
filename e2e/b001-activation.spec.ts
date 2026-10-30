import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "pg";
import { buildStoredConsent } from "../src/server/consent";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { EsignFlow } from "../src/server/esign/flow";
import type { Session } from "../src/server/types";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
test.use({channel:"chromium"});
if(process.env.DEMO_MODE!=="true" || process.env.ESIGN_ENABLED!=="true") throw new Error("Disposable e-sign mode required");
if(process.env.ESIGN_ASSET_ORIGIN!=="http://127.0.0.1:43123") throw new Error("Local signing asset origin required");
const base:Session={userId:USERS.admin,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",sessionId:"synthetic-fixture",
  kind:"staff",role:"admin",locale:"zh-TW",calendar:"gregorian",leaseId:null,email:"",name:"Synthetic",consent:buildStoredConsent("reconsent")};
const owner:Session={...base,userId:USERS.owner,kind:"owner",role:null};
const tenant:Session={...base,userId:USERS.tenant,kind:"tenant",role:null};

async function setup(db:Client,zero:boolean) {
  const property=randomUUID(),unit=randomUUID(),lease=randomUUID();
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES ($1,$2,'Synthetic signing','TW','TWD','Asia/Taipei')`,[property,ORG_ID]);
  await db.query(`INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,'Synthetic signing')`,[unit,ORG_ID,property]);
  await db.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor)
    VALUES ($1,$2,$3,$4,$4,'pending_signature','2027-01-01','2028-01-01','TWD',$5,$6)`,[lease,ORG_ID,property,unit,zero?0:1200000,zero?0:2400000]);
  const contacts=(await db.query<{id:string;user_id:string}>(`SELECT id::text,user_id::text FROM contacts WHERE org_id=$1 AND user_id=ANY($2::uuid[]) AND archived_at IS NULL`,[ORG_ID,[USERS.owner,USERS.tenant]])).rows;
  const ownerContact=contacts.find(c=>c.user_id===USERS.owner)!.id,tenantContact=contacts.find(c=>c.user_id===USERS.tenant)!.id;
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES ($1,$2,$3)`,[ORG_ID,property,ownerContact]);
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'primary')`,[ORG_ID,lease,tenantContact]);
  const pdf=await PDFDocument.create(),page=pdf.addPage([500,700]),font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Synthetic signing contract",{x:40,y:620,font,size:16});
  const localFont=new Uint8Array(await readFile("public/fonts/DroidSansFallback-subset.ttf"));
  const messages:{text:string}[]=[];
  const flow=new EsignFlow({enabled:()=>true,font:async()=>localFont,secret:"synthetic-browser-only-secret-32-bytes",
    mail:async message=>{messages.push({text:message.text});return {ok:true,messageId:"synthetic",provider:"cloudflare"};}});
  await flow.execute(base,{type:"create",leaseId:lease,pdf:await pdf.save(),ownerId:USERS.owner,tenantId:USERS.tenant,
    ownerDocument:false,tenantDocument:false,order:"parallel",deadline:new Date(Date.now()+86400000).toISOString()});
  const version=(await flow.list(base,lease)).versions[0],target={caseId:version.caseId,versionId:version.id};
  for(const actor of [owner,tenant]) {
    await flow.execute(actor,{...target,type:"consent"});
    await flow.execute(actor,{...target,type:"email"});
    const token=messages.at(-1)?.text.match(/[a-f0-9]{32}$/)?.[0];
    if(!token) throw new Error("Synthetic challenge unavailable");
    await flow.execute(actor,{...target,type:"confirm",response:token});
    expect((await flow.list(actor,lease)).versions[0].own?.status).toBe("pending_review");
  }
  return {lease,caseId:version.caseId,versionId:version.id};
}

async function reviewAndSign(page:Page, info:TestInfo, pdfStatuses:number[]) {
  const review=page.locator('[aria-label="契約內容審閱"]');
  await expect(review).toBeVisible(); await expect(review.locator("iframe")).toHaveCount(1);
  const next=page.getByRole("button",{name:"已閱畢，下一步",exact:true});
  await expect(next).toBeDisabled();
  try {
    await expect.poll(async()=>{
      await review.hover();
      await page.mouse.wheel(0,900);
      return next.isEnabled();
    }).toBe(true);
  } catch(error) {
    const state=await review.evaluate(el=>{
      const frame=el.querySelector("iframe");
      return {scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,scrollTop:el.scrollTop,
        frameScheme:frame?.getAttribute("src")?.split(":")[0] ?? null,
        frameReady:frame?.contentDocument?.readyState ?? null};
    });
    await info.attach("review-diagnostic",{body:Buffer.from(JSON.stringify({...state,pdfStatuses})),contentType:"application/json"});
    throw error;
  }
  await next.click();
  const canvas=page.locator('canvas[aria-label="手寫簽名"]'); await expect(canvas).toBeVisible();
  const box=await canvas.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x+20,box!.y+20);await page.mouse.down();
  await page.mouse.move(box!.x+80,box!.y+60,{steps:4});await page.mouse.move(box!.x+150,box!.y+25,{steps:4});await page.mouse.up();
  const submit=page.getByRole("button",{name:"送出簽名",exact:true}); await expect(submit).toBeEnabled(); await submit.click();
  await expect(page.getByText(/^本人已完成簽署 · /)).toBeVisible();
}

async function visitSigner(page:Page, kind:"owner"|"tenant",lease:string) {
  if(kind==="owner") {
    await signIn(page,ACCOUNTS.owner);
    await page.goto(`/api/demo/locale?set=zh-TW&next=/o/leases/${lease}/esign`);
    return;
  }
  await signIn(page,ACCOUNTS.tenant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  await expect(page.getByTestId("lease-picker")).toBeVisible();
  await page.getByTestId("lease-picker").getByRole("button").filter({hasText:"Synthetic signing"}).click();
  await expect(page.getByTestId("lease-picker")).toHaveCount(0);
  await page.goto("/t/lease");
}

for(const width of [390,1280]) for(const zero of [false,true]) test(`real e-sign completion ${zero?"zero":"positive"} at ${width}px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:844}); const errors:string[]=[], expectedOffPaths=new Set<string>(),pdfStatuses:number[]=[];
  page.on("pageerror",e=>errors.push(`pageerror ${e.message}`));
  page.on("console",m=>{
    if(m.type()!=="error") return;
    const location=m.location().url; let path="";
    try {const parsed=new URL(location);if(parsed.origin==="http://127.0.0.1:43123") path=parsed.pathname;} catch { /* Unknown source is not an allowed diagnostic. */ }
    if(expectedOffPaths.has(path) && /^Failed to load resource: the server responded with a status of 404\b/.test(m.text())) return;
    errors.push(`console ${m.text()}`);
  });
  page.on("response",r=>{const path=new URL(r.url()).pathname;if(path.startsWith("/api/esign/")) pdfStatuses.push(r.status());if(r.status()>=500) errors.push(`HTTP ${r.status()} ${path}`);});
  await page.route("**/*",async route=>{
    const request=new URL(route.request().url());
    const loopback=(request.protocol==="http:" || request.protocol==="https:") && ["127.0.0.1","localhost"].includes(request.hostname);
    const pdfViewer=(request.protocol==="chrome:" && request.hostname==="resources") ||
      (request.protocol==="chrome-extension:" && request.hostname==="mhjfbmdgcfjbbpaeojofohoefgiehjai");
    if(loopback || pdfViewer) await route.continue();else {errors.push("unexpected external request");await route.abort();}
  });
  await resetDemo(page); const db=new Client({connectionString:url});await db.connect();
  const original=(await db.query<{feature_flags:unknown}>("SELECT feature_flags FROM organizations WHERE id=$1",[ORG_ID])).rows[0].feature_flags;
  try {
    const {lease,caseId,versionId}=await setup(db,zero);
    const sample=await page.request.post("/api/demo/id-sample",{data:{leaseId:lease}});
    expect(sample.ok()).toBe(true);
    const first=zero?"tenant":"owner",last=zero?"owner":"tenant",finalActor=zero?USERS.owner:USERS.tenant;
    await visitSigner(page,first,lease);
    await reviewAndSign(page,testInfo,pdfStatuses);
    expect((await db.query(`SELECT status::text FROM leases WHERE id=$1`,[lease])).rows[0].status).toBe("pending_signature");
    expect((await db.query(`SELECT count(*)::int AS n FROM invoices WHERE lease_id=$1`,[lease])).rows[0].n).toBe(0);
    await visitSigner(page,last,lease); await reviewAndSign(page,testInfo,pdfStatuses);
    const evidence=(await db.query(`SELECT
      (SELECT count(*)::int FROM esign_signature_images WHERE version_id=$1) AS signatures,
      (SELECT count(DISTINCT actor_id)::int FROM esign_audit_events WHERE version_id=$1 AND event_type='review_delivery'
        AND actor_id=ANY($2::uuid[])) AS delivered_signers`,[versionId,[USERS.owner,USERS.tenant]])).rows[0];
    expect(evidence).toEqual({signatures:2,delivered_signers:2});
    const rows=(await db.query(`SELECT l.status::text,l.esign_status::text,i.id::text AS invoice,i.total_minor::text AS total,i.balance_minor::text AS balance,
      i.paid_minor::text AS paid,i.status::text AS invoice_status,
      i.created_by::text AS actor,i.ledger_transaction_id::text AS ledger,
      (SELECT count(*)::int FROM invoice_lines x WHERE x.invoice_id=i.id) AS lines,
      (SELECT count(*)::int FROM ledger_entries x WHERE x.invoice_id=i.id) AS entries,
      (SELECT count(*)::int FROM payment_allocations x WHERE x.invoice_id=i.id) AS allocations,
      EXISTS(SELECT 1 FROM audit_log a WHERE a.org_id=l.org_id AND a.row_id=l.id::text AND a.event_type='esign_lease_activated'
        AND a.actor_user_id=$2 AND a.new_row->>'version_id'=$3 AND a.new_row->'no_amount_due'=$4::jsonb) AS audited
      FROM leases l JOIN invoices i ON i.lease_id=l.id AND i.source='move_in' WHERE l.id=$1`,[lease,finalActor,versionId,JSON.stringify(zero)])).rows;
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({status:"active",esign_status:"fully_signed",invoice_status:"open",paid:"0",total:zero?"0":"3600000",balance:zero?"0":"3600000",actor:finalActor,lines:zero?1:2,entries:zero?0:3,allocations:0,audited:true});
    expect(Boolean(rows[0].ledger)).toBe(!zero);
    await signIn(page,ACCOUNTS.manager);await page.goto(`/m/leases/${lease}`);
    await expect(page.getByTestId("esign-flow")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("manager-completed.png"),fullPage:true});
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":false}'::jsonb WHERE id=$1`,[ORG_ID]);
    await page.reload();await expect(page.getByTestId("esign-flow")).toHaveCount(0);
    await expect(page.getByText("Synthetic signing",{exact:false}).first()).toBeVisible();
    await signIn(page,ACCOUNTS.owner); expectedOffPaths.add(`/o/leases/${lease}/esign`);expectedOffPaths.add(`/api/esign/${caseId}/${versionId}`);
    const ownerOff=await page.goto(`/o/leases/${lease}/esign`);expect(ownerOff?.status()).toBe(404);
    expect((await page.request.get(`/api/esign/${caseId}/${versionId}`)).status()).toBe(404);
    await visitSigner(page,"tenant",lease);
    await expect(page.getByTestId("esign-flow")).toHaveCount(0);await expect(page.getByRole("heading",{name:"我的租約"})).toBeVisible();
    expect(errors).toEqual([]);
  } finally {await db.query("UPDATE organizations SET feature_flags=$2 WHERE id=$1",[ORG_ID,original]);await db.end();}
});
