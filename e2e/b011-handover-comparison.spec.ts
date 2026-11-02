import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { deflateSync } from "node:zlib";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const target=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
if (process.env.DEMO_MODE !== "true") throw new Error("Disposable comparison demo database required");
const origin="http://127.0.0.1:43148";
async function db<T>(fn:(client:Client)=>Promise<T>) { const client=new Client({connectionString:target.href}); await client.connect(); try{return await fn(client);}finally{await client.end();} }
async function sourceState(lease:string) { return db(async c=>(await c.query(`SELECT
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM app.handover_records t WHERE lease_id=$1) records,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM app.handover_versions t WHERE lease_id=$1) versions,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM app.handover_attachments t WHERE lease_id=$1) attachments,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.version_id,t.attachment_id),'[]'::jsonb) FROM app.handover_version_attachments t WHERE lease_id=$1) links,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM app.handover_replies t WHERE lease_id=$1) replies,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.invoices t WHERE org_id=$2) invoices,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.invoice_lines t WHERE org_id=$2) invoice_lines,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.payments t WHERE org_id=$2) payments,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.payment_allocations t WHERE org_id=$2) allocations,
  (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.ledger_transactions t WHERE org_id=$2) ledger`,[lease,ORG_ID])).rows[0]); }
function png(red:number,green:number,blue:number) {
  const crc32=(bytes:Buffer)=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
  const chunk=(type:string,data:Buffer)=>{const tag=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([tag,data])));return Buffer.concat([length,tag,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(Buffer.from([0,red,green,blue]))),chunk("IEND",Buffer.alloc(0))]);
}
const image1=png(210,30,60),image2=png(30,90,220);
const pdf=Buffer.from("%PDF-1.4\n%%EOF\n");
for (const locale of ["en","zh-TW"] as const) for (const width of [390,1280]) test(`handover photo comparison ${locale} ${width}`,async ({page},info) => {
  await page.setViewportSize({width,height:900});
  const errors:string[]=[];
  let injectedImageError="",knownInjectedPhoto="",expectedOffUrl="",phase="setup",offNavigation=false,offConsoleCount=0,offResponseCount=0;
  const exact404Message="Failed to load resource: the server responded with a status of 404 (Not Found)";
  const consoleCategories:Record<string,number>={}, responseCategories:Record<string,number>={};
  function locationCategory(value:string) {
    if (!value) return "missing";
    if (value===knownInjectedPhoto && knownInjectedPhoto) return "exactKnownInjectedPhoto";
    if (value===expectedOffUrl && expectedOffUrl) return "exactOwnedOFFdocument";
    try { return new URL(value).origin===origin ? "otherLocal" : "external"; } catch { return "missing"; }
  }
  function count(buckets:Record<string,number>,key:string) { buckets[key]=(buckets[key]??0)+1; }
  page.on("pageerror",e=>errors.push(e.message));
  page.on("console",e=>{if(e.type()==="error"){const location=e.location().url; count(consoleCategories,`${phase}:${locationCategory(location)}:404=${e.text().includes("404")}`);if(offNavigation && phase==="off" && expectedOffUrl && location && location===expectedOffUrl && e.text()===exact404Message)offConsoleCount++;else if(!(injectedImageError && location===injectedImageError && e.text().includes("404")))errors.push(e.text());}});
  page.on("response",r=>{if(r.status()===404){const req=r.request(),type=req.resourceType()==="document"?"document":req.resourceType()==="image"?"image":"other";let main=false;try{main=req.frame()===page.mainFrame();}catch{}count(responseCategories,`${phase}:${locationCategory(r.url())}:${type}:main=${main}`);if(offNavigation && phase==="off" && expectedOffUrl && r.url()===expectedOffUrl && req.method()==="GET" && type==="document" && main)offResponseCount++;}if(r.status()>=500)errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
  await page.route("**/*",async route=>{if(new URL(route.request().url()).origin===origin)await route.continue();else{errors.push("Unexpected external request");await route.abort();}});
  await resetDemo(page);
  const before=await db(async c=>({setting:(await c.query(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='handover_records'`)).rows[0],flags:(await c.query(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].feature_flags}));
  const label=locale==="en" ? {in:"Move-in",out:"Move-out",condition:"Condition and notes",publish:"Publish version",choose:"Choose file",upload:"Add photo or PDF",version:"Choose version",photo:"Choose photo",noVersion:"No record for this phase yet.",noPhotos:"This version has no photos.",pdfOnly:"This version contains only PDFs, so there are no photos to compare.",published:"Version published",uploaded:"Originally uploaded"} : {in:"入住點交",out:"退租點交",condition:"現況與備註",publish:"發布版本",choose:"選擇檔案",upload:"新增照片或 PDF",version:"選擇版本",photo:"選擇照片",noVersion:"尚無此階段紀錄。",noPhotos:"此版本沒有照片。",pdfOnly:"此版本只有 PDF，沒有照片可比較。",published:"版本發布",uploaded:"原始上傳"};
  try {
    const lease=await db(async c=>{await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"handover_records":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='handover_records'`,[ORG_ID]);return (await c.query<{id:string}>(`SELECT l.id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts ct ON ct.id=lp.contact_id AND ct.org_id=lp.org_id WHERE l.org_id=$1 AND ct.user_id=$2 AND lp.role='primary' AND l.status<>'draft' LIMIT 1`,[ORG_ID,USERS.tenant])).rows[0].id;});
    await page.goto(`/api/demo/locale?set=${locale}&next=/m/handover/${lease}`);
    const comparison=page.getByTestId("handover-comparison"), cin=comparison.getByTestId("comparison-move_in"), cout=comparison.getByTestId("comparison-move_out");
    await expect(cin).toContainText(label.noVersion); await expect(cout).toContainText(label.noVersion); await page.screenshot({path:info.outputPath(`empty-${locale}-${width}.png`),fullPage:true});
    const moveIn=page.getByRole("region",{name:label.in,exact:true}); const moveOut=page.getByRole("region",{name:label.out,exact:true});
    await moveIn.getByLabel(label.condition).fill("synthetic move-in"); await moveIn.getByRole("button",{name:label.publish}).click(); await expect(cin).toContainText(label.noPhotos); await page.screenshot({path:info.outputPath(`no-photos-${locale}-${width}.png`),fullPage:true});
    await moveIn.getByLabel(label.choose).setInputFiles({name:"document.pdf",mimeType:"application/pdf",buffer:pdf}); await moveIn.getByRole("button",{name:label.upload}).click(); await expect(cin).toContainText(label.pdfOnly); await page.screenshot({path:info.outputPath(`pdf-only-${locale}-${width}.png`),fullPage:true}); console.log("B011_COMPARISON_PHASE pdf_complete");
    await moveIn.getByLabel(label.choose).setInputFiles({name:"in.png",mimeType:"image/png",buffer:image1}); await moveIn.getByRole("button",{name:label.upload}).click(); await expect(cin.getByRole("img")).toBeVisible(); await expect.poll(()=>cin.getByRole("img").evaluate((image:HTMLImageElement)=>image.complete && image.naturalWidth>0 && image.naturalHeight>0)).toBe(true); await expect(cin).toContainText(label.published); await expect(cin).toContainText(label.uploaded); console.log("B011_COMPARISON_EVENT move_in_decoded");
    await moveOut.getByLabel(label.condition).fill("synthetic move-out"); await moveOut.getByRole("button",{name:label.publish}).click(); await moveOut.getByLabel(label.choose).setInputFiles({name:"out.png",mimeType:"image/png",buffer:image2}); await moveOut.getByRole("button",{name:label.upload}).click(); await expect(cout.getByRole("img")).toBeVisible();
    const photoUrl=await cin.getByRole("img").getAttribute("src"); expect(photoUrl).toMatch(new RegExp(`^/api/handover/${lease}/`));
    const response=await page.request.get(photoUrl!); expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toBe("private, no-store"); expect(await response.body()).toEqual(image1);
    const existingOut=await cout.getByRole("img").getAttribute("src"); expect(existingOut).toMatch(new RegExp(`^/api/handover/${lease}/`)); phase="injected_image";
    const excluded=new Set([new URL(photoUrl!,origin).href,new URL(existingOut!,origin).href]);
    let observed=0,release!:()=>void; const hold=new Promise<void>(resolve=>{release=resolve;});
    const protectedPrefix=`/api/handover/${lease}/`;
    const matches=(url:URL)=>url.origin===origin && url.pathname.startsWith(protectedPrefix);
    await page.route(matches,async route=>{
      const request=route.request(),url=request.url();
      if(request.method()!=="GET" || request.resourceType()!=="image" || excluded.has(url) || (injectedImageError && url!==injectedImageError)) return route.continue();
      if(!injectedImageError) { injectedImageError=url; knownInjectedPhoto=url; }
      observed++; await hold; await route.fulfill({status:404,body:"Not found"});
    });
    let state:Awaited<ReturnType<typeof sourceState>>;
    try {
      await moveOut.getByLabel(label.choose).setInputFiles({name:"out-later.png",mimeType:"image/png",buffer:image1}); await moveOut.getByRole("button",{name:label.upload}).click(); await expect(cout.getByLabel(label.photo).locator("option")).toHaveCount(2); console.log("B011_COMPARISON_EVENT move_out_two_photos");
      state=await sourceState(lease);
      console.log("B011_COMPARISON_PHASE first_new_image_request_wait"); await expect.poll(()=>observed,{timeout:20_000}).toBeGreaterThan(0); console.log("B011_COMPARISON_EVENT first_new_image_request_observed");
      await cout.getByLabel(label.photo).selectOption({label:"out-later.png"}); await expect(cout.getByRole("img")).toHaveAttribute("src",new URL(injectedImageError).pathname); await expect(cout.getByRole("status")).toBeVisible(); await page.screenshot({path:info.outputPath(`loading-${locale}-${width}.png`),fullPage:true}); release(); await expect(cout.getByRole("alert")).toBeVisible(); await page.screenshot({path:info.outputPath(`image-error-${locale}-${width}.png`),fullPage:true});
    } finally { release(); await page.unroute(matches); }
    const newPhotoUrl=injectedImageError; injectedImageError=""; phase="recovery"; await page.reload(); await cout.getByLabel(label.photo).selectOption({label:"out-later.png"}); await expect.poll(()=>cout.getByRole("img").evaluate((image:HTMLImageElement)=>image.complete && image.naturalWidth>0 && image.naturalHeight>0)).toBe(true); const restored=await page.request.get(newPhotoUrl); expect(restored.status()).toBe(200); expect(restored.headers()["cache-control"]).toBe("private, no-store"); expect(await restored.body()).toEqual(image1);
    await cin.getByLabel(label.version).selectOption({label:locale==="en"?"Version 1":"版本 1"}); await expect(cin).toContainText(label.noPhotos); await expect(cin.getByRole("img")).toHaveCount(0);
    await cin.getByLabel(label.version).selectOption({label:locale==="en"?"Version 2":"版本 2"}); await expect(cin).toContainText(label.pdfOnly);
    await cin.getByLabel(label.version).selectOption({label:locale==="en"?"Version 3":"版本 3"}); await expect(cin.getByLabel(label.photo)).toHaveValue(/.+:.+/);
    await cout.getByLabel(label.photo).selectOption({label:"out.png"}); await expect(cout.getByRole("img")).toHaveAttribute("alt",/out\.png/); const beforeIn=await cin.getByRole("img").getAttribute("src"); await cout.getByLabel(label.photo).selectOption({label:"out-later.png"}); await expect(cout.getByRole("img")).toHaveAttribute("alt",/out-later\.png/); await expect(cin.getByRole("img")).toHaveAttribute("src",beforeIn!);
    await cout.getByLabel(label.version).selectOption({label:locale==="en"?"Version 2":"版本 2"}); await expect(cout.getByRole("img")).toHaveAttribute("alt",/out\.png/); await page.reload(); await expect(cin.getByRole("img")).toBeVisible();
    // Protected image GETs legitimately add attachment-read audit rows; they are not included here.
    expect(await sourceState(lease)).toEqual(state);
    for (const photo of [cin.getByRole("img"),cout.getByRole("img")]) { await expect.poll(()=>photo.evaluate((image:HTMLImageElement)=>image.complete && image.naturalWidth>0 && image.naturalHeight>0)).toBe(true); } await expect(cin.getByRole("alert")).toHaveCount(0); await expect(cout.getByRole("alert")).toHaveCount(0); await expect(comparison.getByRole("status")).toHaveCount(0);
    const staffIn=await cin.boundingBox(),staffOut=await cout.boundingBox(); expect(staffIn).not.toBeNull();expect(staffOut).not.toBeNull(); if(width===390)expect(staffOut!.y).toBeGreaterThanOrEqual(staffIn!.y+staffIn!.height-1); else {expect(Math.abs(staffIn!.y-staffOut!.y)).toBeLessThanOrEqual(2);expect(staffOut!.x).toBeGreaterThanOrEqual(staffIn!.x+staffIn!.width-1);}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true); await page.screenshot({path:info.outputPath(`staff-${locale}-${width}.png`),fullPage:true});
    phase="tenant"; await signIn(page,ACCOUNTS.tenant); await page.context().addCookies([{name:"condola_lease",value:lease,url:origin}]); await page.goto(`/api/demo/locale?set=${locale}&next=/t/handover/${lease}`); await expect(page.getByTestId("handover-comparison").getByRole("img")).toHaveCount(2);
    const tenantIn=page.getByRole("region",{name:label.in,exact:true}); await tenantIn.getByLabel(label.choose).setInputFiles({name:"tenant-in.png",mimeType:"image/png",buffer:image2}); await tenantIn.getByRole("button",{name:label.upload}).click(); await expect(cin.getByLabel(label.photo).locator("option")).toHaveCount(2); await cin.getByLabel(label.photo).selectOption({label:"tenant-in.png"}); await expect(cin.getByRole("img")).toHaveAttribute("alt",/tenant-in\.png/); await expect(cin).toContainText(label.uploaded); await expect(cin).toContainText(label.published);
    const names=await db(async c=>(await c.query<{id:string;display_name:string}>(`SELECT id,display_name FROM profiles WHERE id=ANY($1::uuid[])`,[[USERS.admin,USERS.tenant]])).rows); const admin=names.find(n=>n.id===USERS.admin)?.display_name, tenant=names.find(n=>n.id===USERS.tenant)?.display_name; expect(admin).toBeTruthy();expect(tenant).toBeTruthy();await cin.getByLabel(label.photo).selectOption({label:"in.png"}); await expect(cin).toContainText(admin!); await expect(cin).toContainText(tenant!); await expect(cin.locator("time")).toHaveCount(2);
    for (const photo of [cin.getByRole("img"),cout.getByRole("img")]) { await expect.poll(()=>photo.evaluate((image:HTMLImageElement)=>image.complete && image.naturalWidth>0 && image.naturalHeight>0)).toBe(true); } await expect(cin.getByRole("alert")).toHaveCount(0); await expect(cout.getByRole("alert")).toHaveCount(0); await expect(comparison.getByRole("status")).toHaveCount(0);
    const tenantInBox=await cin.boundingBox(),tenantOutBox=await cout.boundingBox(); expect(tenantInBox).not.toBeNull();expect(tenantOutBox).not.toBeNull();expect(tenantOutBox!.y).toBeGreaterThanOrEqual(tenantInBox!.y+tenantInBox!.height-1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true); await comparison.evaluate(node=>node.scrollIntoView({block:"start"})); await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))); await page.screenshot({path:info.outputPath(`tenant-${locale}-${width}.png`),fullPage:true}); await cout.evaluate(node=>node.scrollIntoView({block:"center"})); await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))); await page.screenshot({path:info.outputPath(`tenant-moveout-viewport-${locale}-${width}.png`),fullPage:false});
    phase="denial"; await signIn(page,ACCOUNTS.tenant2); await page.context().addCookies([{name:"condola_lease",value:lease,url:origin}]); expect((await page.request.get(photoUrl!)).status()).toBe(404);
    phase="off"; await signIn(page,ACCOUNTS.admin); await db(c=>c.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb) WHERE key='handover_records'`)); expect((await page.request.get(photoUrl!)).status()).toBe(404); expectedOffUrl=new URL(`/m/handover/${lease}`,origin).href; offNavigation=true; const off=await page.goto(expectedOffUrl); expect(off?.status()).toBe(404); expect(off?.url()).toBe(expectedOffUrl); expect(off?.request().method()).toBe("GET"); expect(off?.request().resourceType()).toBe("document"); expect(off?.request().frame()).toBe(page.mainFrame()); await expect(page.getByTestId("handover-comparison")).toHaveCount(0); await expect.poll(()=>offResponseCount).toBe(1); await expect.poll(()=>offConsoleCount).toBe(1); offNavigation=false; expect(offResponseCount).toBe(1); expect(offConsoleCount).toBe(1);
    expect(errors).toEqual([]);
  } finally { console.log("B011_COMPARISON_CATEGORIES",JSON.stringify({console:consoleCategories,response404:responseCategories})); await db(async c=>{await c.query(`UPDATE platform_settings SET value=$1,description=$2,updated_at=$3 WHERE key='handover_records'`,[before.setting.value,before.setting.description,before.setting.updated_at]);await c.query(`UPDATE organizations SET feature_flags=$2 WHERE id=$1`,[ORG_ID,before.flags]);}); }
});
