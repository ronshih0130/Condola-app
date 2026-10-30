import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, signIn } from "./session";

const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true" || process.env.IMPORT_ERROR_DETAILS_ENABLED !== "true" || process.env.B006_PRIVATE_HTTP_CONFIG !== "1" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") throw new Error("Disposable regional import mode required");

function epochWorkbook(): Buffer {
  const files = [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr codeName="a>b" date1904="true"/><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c></row><row r="7"><c r="A7"><v>46327</v></c></row></sheetData></worksheet>'],
  ];
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [path, text] of files) {
    const name=Buffer.from(path),data=Buffer.from(text),header=Buffer.alloc(30),entry=Buffer.alloc(46);
    let crc=0xffffffff;
    for(const byte of data) {crc^=byte;for(let bit=0;bit<8;bit++) crc=(crc>>>1)^(0xedb88320 & -(crc&1));}
    crc=(~crc)>>>0;
    header.writeUInt32LE(0x04034b50,0);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
    header.writeUInt32LE(crc,14);
    entry.writeUInt32LE(0x02014b50,0);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    entry.writeUInt32LE(crc,16);
    local.push(header,name,data);central.push(entry,name);offset+=header.length+name.length+data.length;
  }
  const index=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,index,end]);
}

const origin = "http://127.0.0.1:43137";
type Org = { country_code: string; jurisdiction_id: string | null; default_currency: string; timezone: string; feature_flags: unknown };
function guard(info: TestInfo) {
  if (!info.config.configFile?.endsWith("/e2e/b006-import-private-playwright.config.ts") || info.project.use.trace !== "off" || info.project.use.video !== "off" || info.project.use.screenshot !== "off" || info.config.reporter.length !== 1 || info.config.reporter[0][0] !== "line" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") throw new Error("B006 private configuration required");
}
async function post(page: Page, path: string, data: object) {
  let target: URL;
  try { target = new URL(path, origin); } catch { throw new Error("B006 request rejected"); }
  if (!path.startsWith("/") || path.startsWith("//") || target.origin !== origin) throw new Error("B006 request rejected");
  try {
    const response = await page.request.post(target.href, { data, maxRedirects: 0 });
    if (new URL(response.url()).origin !== origin) throw new Error("invalid origin");
    return response;
  } catch { throw new Error("B006 local HTTP request failed"); }
}
function safeFailure(phase: string, error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as {code?:unknown}).code : null;
  return `${phase}${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : ""}`;
}
async function restore(db: Client, original: Org) {
  await db.query("BEGIN");
  try {
    await db.query(`UPDATE organizations SET country_code=$2,jurisdiction_id=$3,default_currency=$4,timezone=$5,feature_flags=$6::jsonb WHERE id=$1`,[ORG_ID,original.country_code,original.jurisdiction_id,original.default_currency,original.timezone,JSON.stringify(original.feature_flags)]);
    const rows=(await db.query<Org>(`SELECT country_code,jurisdiction_id::text,default_currency,timezone,feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows;
    expect(rows.length === 1 && JSON.stringify(rows[0]) === JSON.stringify(original)).toBe(true);
    await db.query("COMMIT");
  } catch (error) { try { await db.query("ROLLBACK"); } catch { /* retain failure */ } throw error; }
}
test("regional import through manager UI and API",async({page},testInfo)=>{
  guard(testInfo);
  const width = testInfo.project.use.viewport?.width;
  if (width !== 390 && width !== 1280) throw new Error("B006 invalid viewport");
  const errors: string[] = []; const commits: number[][] = [];
  page.on("pageerror",()=>errors.push("page error"));
  page.on("console",m=>{if(m.type()==="error") errors.push("console error");});
  page.on("response",r=>{if(r.status()>=500) errors.push("server error");});
  page.on("request",r=>{
    try {
      const target = new URL(r.url());
      if (target.origin === origin && target.pathname === "/api/import" && r.method() === "POST") {
        const body = r.postDataJSON();
        if (body.mode === "commit") {
          if (!Array.isArray(body.rows) || !body.rows.every((row: {line: unknown}) => Number.isInteger(row.line))) { errors.push("invalid commit metadata"); return; }
          commits.push(body.rows.map((row: {line:number})=>row.line));
        }
      }
    } catch { errors.push("invalid request metadata"); }
  });
  await page.context().route("**/*",async route=>{
    try { if(new URL(route.request().url()).origin === origin) { await route.continue(); return; } } catch { /* reject invalid URL */ }
    errors.push("off-origin request"); await route.abort();
  });
  let db: Client | undefined, original: Org | undefined;
  let primary: string | undefined, restoration: string | undefined;
  try {
    await signIn(page,ACCOUNTS.admin); expect((await post(page,"/api/demo/reset",{})).status()).toBe(200);
    await signIn(page,ACCOUNTS.admin); await signIn(page,ACCOUNTS.manager);
    db=new Client({connectionString:databaseUrl}); await db.connect();
    const originals=(await db.query<Org>(`SELECT country_code,jurisdiction_id::text,default_currency,timezone,feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows;
    expect(originals.length === 1).toBe(true); original=originals[0];
  const tw=(await db.query<{id:string}>(`SELECT id::text FROM jurisdictions WHERE code='TW'`)).rows[0].id;
  const ca=(await db.query<{id:string}>(`SELECT id::text FROM jurisdictions WHERE code='US-CA'`)).rows[0].id;
  const id=randomUUID().slice(0,8), names=[`Region whole ${id}`,`Region room ${id}`,`Region fixed ${id}`];
  const phone=(n:number)=>`09${10000000+(parseInt(id,16)%89999995)+n}`;
  const header="物件名稱,地址,屋主姓名,出租型態,戶別／樓層,房號,房型,月租,租客姓名,租客電話,起租日,到期日,押金,繳租日";
  const row=(name:string,mode:string,unit:string,room:string,type:string,rent:string,tenant:string,n:number,start:string)=>[name,`新北市測試街${id}${n}號`,`Owner ${id} ${n}`,mode,unit,room,type,rent,tenant,phone(n),start,"2028-01-01","12000","5"].join(",");
  const csv=(fixed:boolean)=>[header,"",row(names[0],"整層","1F","","","6000","Tenant A",1,"2027-01-01"),"",row(names[1],"分租","2F","A","套房","6000","Tenant B",2,"2027-01-01"),"",row(names[2],"整層","3F","","","6000","Tenant C",3,fixed?"2027-01-01":"bad-date")].join("\n");
  const counts=async()=> (await db!.query(`WITH p AS (SELECT id FROM properties WHERE org_id=$1 AND name=ANY($2::text[])), u AS (SELECT id FROM units WHERE org_id=$1 AND property_id IN (SELECT id FROM p)) SELECT (SELECT count(*)::int FROM p) properties,(SELECT count(*)::int FROM u) units,(SELECT count(*)::int FROM rooms WHERE org_id=$1 AND unit_id IN (SELECT id FROM u)) rooms,(SELECT count(*)::int FROM leases WHERE org_id=$1 AND property_id IN (SELECT id FROM p)) leases`,[ORG_ID,names])).rows[0];
  const upload=async(data:Buffer,name:string,mime:string)=>{await page.getByTestId("import-to-upload").click();await page.getByTestId("import-file").setInputFiles({name,mimeType:mime,buffer:data});};
    await db.query(`UPDATE organizations SET country_code='TW',jurisdiction_id=$2,default_currency='TWD',timezone='America/Los_Angeles',feature_flags=feature_flags || '{"import_error_details":true}'::jsonb WHERE id=$1`,[ORG_ID,tw]);
    await page.goto("/api/demo/locale?set=zh-TW&next=/m/import");
    await upload(epochWorkbook(),"epoch1904.xlsx","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await expect(page.getByText("此活頁簿使用尚未支援的日期系統",{exact:false})).toBeVisible();
    expect(await counts()).toEqual({properties:0,units:0,rooms:0,leases:0});
    await page.goto("/m/import"); await upload(Buffer.from(csv(false)),"regional.csv","text/csv");
    await expect(page.getByTestId("import-preview")).toBeVisible(); await expect(page.getByTestId("import-checking")).toHaveCount(0);
    await expect(page.getByTestId("import-ok-count")).toHaveText("2"); await expect(page.getByTestId("import-err-count")).toHaveText("1");
    await expect(page.locator('[data-testid="import-issue-row"][data-line="7"]')).toContainText("起租日");
    await page.getByTestId("import-run").click(); await expect(page.getByTestId("import-result")).toBeVisible();
    expect(await counts()).toEqual({properties:2,units:2,rooms:1,leases:2});
    const before=(await db.query(`SELECT p.name,p.id::text,l.id::text AS lease_id FROM properties p JOIN leases l ON l.property_id=p.id WHERE p.org_id=$1 AND p.name=ANY($2::text[]) ORDER BY p.name`,[ORG_ID,names])).rows;
    await page.getByRole("button",{name:"再匯入一個檔案"}).click(); await upload(Buffer.from(csv(true)),"regional.csv","text/csv");
    await expect(page.getByTestId("import-checking")).toHaveCount(0); await expect(page.getByTestId("import-ok-count")).toHaveText("1");
    await page.getByTestId("import-run").click(); await expect(page.getByTestId("import-result")).toBeVisible();
    expect(await counts()).toEqual({properties:3,units:3,rooms:1,leases:3});
    const rows=(await db.query(`SELECT p.name,p.id::text,l.id::text AS lease_id,p.country_code,p.jurisdiction_id::text,p.currency,p.timezone,l.currency AS lease_currency FROM properties p JOIN leases l ON l.property_id=p.id WHERE p.org_id=$1 AND p.name=ANY($2::text[]) ORDER BY p.name`,[ORG_ID,names])).rows;
    expect(rows.filter(r=>r.name!==names[2]).map(({name,id,lease_id})=>({name,id,lease_id}))).toEqual(before);
    for(const r of rows) expect([r.country_code,r.jurisdiction_id,r.currency,r.timezone,r.lease_currency]).toEqual(["TW",tw,"TWD","America/Los_Angeles","TWD"]);
    expect(commits).toEqual([[3,5],[7]]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    const card=await page.getByTestId("import-result").boundingBox();
    expect(card).not.toBeNull();
    for (const action of await page.getByTestId("import-result-actions").locator("a,button").all()) {
      const box=await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(card!.x);
      expect(box!.x+box!.width).toBeLessThanOrEqual(card!.x+card!.width);
    }
    await page.screenshot({path:testInfo.outputPath("regional-import.png"),fullPage:true});
    await db.query(`UPDATE organizations SET country_code='US',jurisdiction_id=$2,default_currency='USD' WHERE id=$1`,[ORG_ID,ca]);
    await page.goto("/m/import"); await expect(page.getByTestId("import-region-unavailable")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("unsupported-region.png"),fullPage:true});
    const blocked={mode:"preview",fileName:"blocked.csv",rows:[{line:2,propertyName:`Blocked ${id}`,address:`台北測試路${id}號`,
      ownerName:"Synthetic owner",ownerEmail:"",rentalMode:"整層",unitLabel:"1F",roomLabel:"",roomType:"",area:"",rent:"6000",
      tenantName:"Synthetic tenant",tenantPhone:phone(4),tenantEmail:"",startDate:"2027-01-01",endDate:"2028-01-01",
      deposit:"12000",dueDay:"5",electricity:"",rate:"",billKwh:"",billAmount:"",opening:"",depositReason:"",rateReason:"",notes:""}],
      region:{country:"TW",currency:"TWD"}};
    const response=await post(page,"/api/import",blocked); expect(response.status()).toBe(400); expect((await response.json()).error).toBe("im_region_unavailable");
    const commit=await post(page,"/api/import",{...blocked,mode:"commit"}); expect(commit.status()).toBe(200); const stream=(await commit.text()).trim().split("\n").map(line=>JSON.parse(line) as {type?:unknown;error?:unknown});
    expect(stream.some(event=>event.type === "error" && event.error === "im_none") && !stream.some(event=>event.type === "result")).toBe(true);
    expect(await counts()).toEqual({properties:3,units:3,rooms:1,leases:3});
    expect((await db.query(`SELECT count(*)::int AS n FROM properties WHERE org_id=$1 AND name=$2`,[ORG_ID,`Blocked ${id}`])).rows[0].n).toBe(0);
    expect(errors).toEqual([]);
  } catch (error) { primary = safeFailure("regional import", error); }
  if (db && original) try { await restore(db,original); } catch (error) { restoration = safeFailure("organization restoration", error); }
  if (db) try { await db.end(); } catch { restoration ??= "connection cleanup"; }
  if (primary || restoration) throw new Error([primary,restoration].filter(Boolean).join("; "));
});
