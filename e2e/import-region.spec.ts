import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true" || process.env.IMPORT_ERROR_DETAILS_ENABLED !== "true") throw new Error("Disposable regional import mode required");

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

for (const width of [390,1280]) test(`regional import through manager UI and API at ${width}px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:844});
  const errors: string[] = []; const commits: number[][] = [];
  page.on("pageerror",e=>errors.push(`pageerror ${e.message}`));
  page.on("console",m=>{if(m.type()==="error") errors.push(`console ${m.text()}`);});
  page.on("response",r=>{if(r.status()>=500) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
  page.on("request",r=>{if(new URL(r.url()).pathname==="/api/import" && r.method()==="POST") {const body=r.postDataJSON();if(body.mode==="commit") commits.push(body.rows.map((row:{line:number})=>row.line));}});
  await page.route("**/*",async route=>{const host=new URL(route.request().url()).hostname;if(host==="127.0.0.1"||host==="localhost") await route.continue();else {errors.push("unexpected external request");await route.abort();}});
  await resetDemo(page); await signIn(page,ACCOUNTS.manager);
  const db=new Client({connectionString:databaseUrl}); await db.connect();
  const original=(await db.query(`SELECT country_code,jurisdiction_id,default_currency,timezone,feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows[0];
  const tw=(await db.query<{id:string}>(`SELECT id::text FROM jurisdictions WHERE code='TW'`)).rows[0].id;
  const ca=(await db.query<{id:string}>(`SELECT id::text FROM jurisdictions WHERE code='US-CA'`)).rows[0].id;
  const id=randomUUID().slice(0,8), names=[`Region whole ${id}`,`Region room ${id}`,`Region fixed ${id}`];
  const phone=(n:number)=>`09${10000000+(parseInt(id,16)%89999995)+n}`;
  const header="物件名稱,地址,屋主姓名,出租型態,戶別／樓層,房號,房型,月租,租客姓名,租客電話,起租日,到期日,押金,繳租日";
  const row=(name:string,mode:string,unit:string,room:string,type:string,rent:string,tenant:string,n:number,start:string)=>[name,`新北市測試街${id}${n}號`,`Owner ${id} ${n}`,mode,unit,room,type,rent,tenant,phone(n),start,"2028-01-01","12000","5"].join(",");
  const csv=(fixed:boolean)=>[header,"",row(names[0],"整層","1F","","","6000","Tenant A",1,"2027-01-01"),"",row(names[1],"分租","2F","A","套房","6000","Tenant B",2,"2027-01-01"),"",row(names[2],"整層","3F","","","6000","Tenant C",3,fixed?"2027-01-01":"bad-date")].join("\n");
  const counts=async()=> (await db.query(`WITH p AS (SELECT id FROM properties WHERE org_id=$1 AND name=ANY($2::text[])), u AS (SELECT id FROM units WHERE org_id=$1 AND property_id IN (SELECT id FROM p)) SELECT (SELECT count(*)::int FROM p) properties,(SELECT count(*)::int FROM u) units,(SELECT count(*)::int FROM rooms WHERE org_id=$1 AND unit_id IN (SELECT id FROM u)) rooms,(SELECT count(*)::int FROM leases WHERE org_id=$1 AND property_id IN (SELECT id FROM p)) leases`,[ORG_ID,names])).rows[0];
  const upload=async(data:Buffer,name:string,mime:string)=>{await page.getByTestId("import-to-upload").click();await page.getByTestId("import-file").setInputFiles({name,mimeType:mime,buffer:data});};
  try {
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
    const response=await page.request.post("/api/import",{data:blocked}); expect(response.status()).toBe(400); expect((await response.json()).error).toBe("im_region_unavailable");
    const commit=await page.request.post("/api/import",{data:{...blocked,mode:"commit"}}); expect(commit.status()).toBe(200); expect(await commit.text()).toContain('"type":"error"');
    expect(await counts()).toEqual({properties:3,units:3,rooms:1,leases:3});
    expect((await db.query(`SELECT count(*)::int AS n FROM properties WHERE org_id=$1 AND name=$2`,[ORG_ID,`Blocked ${id}`])).rows[0].n).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await db.query(`UPDATE organizations SET country_code=$2,jurisdiction_id=$3,default_currency=$4,timezone=$5,feature_flags=$6 WHERE id=$1`,[ORG_ID,original.country_code,original.jurisdiction_id,original.default_currency,original.timezone,original.feature_flags]);
    await db.end();
  }
});
