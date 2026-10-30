import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ORG_ID } from "../src/server/ids";
import { parseCsv } from "../src/lib/spreadsheet";
import { ACCOUNTS, signIn } from "./session";

const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
if(process.env.DEMO_MODE!=="true" || process.env.IMPORT_ERROR_DETAILS_ENABLED!=="true") throw new Error("Synthetic local import mode required");
const header="物件名稱,地址,屋主姓名,出租型態,戶別／樓層,房號,房型,月租,租客姓名,租客電話,起租日,到期日,押金,繳租日";
const row=(items:string[])=>items.join(",");
function data(id:string,corrected:boolean) {
  const whole=`B006 whole ${id}`, rooms=`B006 rooms ${id}`, fixed=`B006 corrected ${id}`;
  const waddr=`新北市板橋區測試街${id}號`, raddr=`新北市板橋區測試路${id}號`, faddr=`新北市板橋區修正路${id}號`;
  const phone=(n:number)=>`09${10000000+(parseInt(id,16)%89999995)+n}`;
  const csv=[header,"",row([whole,waddr,`B006 owner W ${id}`,"整層","1F","","","10000",`B006 tenant W ${id}`,phone(1),"116/01/01","117/01/01","20000","5"]),
    row([rooms,raddr,`B006 owner R ${id}`,"分租","2F","A","套房","6000",`B006 tenant A ${id}`,phone(2),"2027-01-01","2028-01-01","12000","6"]),"",
    row([rooms,raddr,`B006 owner R ${id}`,"分租","2F","B","雅房","7000",`B006 tenant B ${id}`,phone(3),"116/01/01","117/01/01","14000","7"]),"",
    row([fixed,faddr,`B006 owner C ${id}`,"整層","3F","","","9000",`B006 tenant C ${id}`,phone(4),corrected?"116/01/01":"bad-date",corrected?"2028-01-01":"2027-02-30","18000","8"])].join("\n");
  return {csv,whole,rooms,fixed};
}
function observe(page:Page) {
  const errors:string[]=[]; const requests:{mode:string;rows:{line:number}[]}[]=[];
  page.on("pageerror",e=>errors.push(`pageerror ${e.message}`));
  page.on("console",m=>{if(m.type()==="error") errors.push(`console ${m.text()}`);});
  page.on("response",r=>{if(r.status()>=500) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);});
  page.on("request",r=>{if(new URL(r.url()).pathname==="/api/import" && r.method()==="POST") { const body=r.postDataJSON(); requests.push({mode:body.mode,rows:body.rows}); }});
  return {errors,requests};
}
async function localRequestsOnly(page:Page,errors:string[]) {
  await page.route("**/*",async route=>{
    const host=new URL(route.request().url()).hostname;
    if(host==="127.0.0.1" || host==="localhost") await route.continue();
    else {errors.push("unexpected external browser request"); await route.abort();}
  });
}
async function setDetails(db:Client,on:boolean) {
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('import_error_details',$2::boolean) WHERE id=$1`,[ORG_ID,on]);
}
async function upload(page:Page,name:string,buffer:Buffer,mime:string) {
  await page.getByTestId("import-to-upload").click();
  await page.getByTestId("import-file").setInputFiles({name,mimeType:mime,buffer});
  await expect(page.getByTestId("import-preview")).toBeVisible();
  await expect(page.getByTestId("import-checking")).toHaveCount(0);
}
async function records(db:Client,names:string[]) {
  return (await db.query(`SELECT p.name AS property,p.id::text AS property_id,u.id::text AS unit_id,u.label AS unit,r.id::text AS room_id,r.label AS room,
    l.id::text AS lease_id,l.target_unit_id::text AS target_unit,l.target_room_id::text AS target_room,l.start_date::text,l.end_date::text,
    l.rent_amount_minor::text AS rent,l.deposit_amount_minor::text AS deposit,l.status::text,l.esign_status::text
    FROM properties p JOIN units u ON u.org_id=p.org_id AND u.property_id=p.id
    LEFT JOIN rooms r ON r.org_id=u.org_id AND r.unit_id=u.id
    JOIN leases l ON l.org_id=u.org_id AND l.unit_id=u.id AND ((r.id IS NULL AND l.target_unit_id=u.id) OR l.target_room_id=r.id)
    WHERE p.org_id=$1 AND p.name=ANY($2::text[]) ORDER BY p.name,u.label,r.label`,[ORG_ID,names])).rows;
}
async function relationalCounts(db:Client,names:string[]) {
  return (await db.query(`WITH p AS (SELECT id FROM properties WHERE org_id=$1 AND name=ANY($2::text[])),
    u AS (SELECT id FROM units WHERE org_id=$1 AND property_id IN (SELECT id FROM p))
    SELECT (SELECT count(*)::int FROM p) AS properties,(SELECT count(*)::int FROM u) AS units,
      (SELECT count(*)::int FROM rooms WHERE org_id=$1 AND unit_id IN (SELECT id FROM u)) AS rooms,
      (SELECT count(*)::int FROM leases WHERE org_id=$1 AND property_id IN (SELECT id FROM p)) AS leases`,[ORG_ID,names])).rows[0];
}
function instantiateXlsx(id:string) {
  const file=Buffer.from(readFileSync(resolve("e2e/fixtures/b006-sparse-1900.xlsx")));
  const valid=`B006 XLSX ${id}`.padEnd("B006 XLSX Synthetic".length,"_");
  const invalid=`B006 X ${id}`.padEnd("B006 XLSX Invalid".length,"_");
  const target="xl/worksheets/sheet1.xml";
  let local=0, found=false;
  while(local+30<=file.length && file.readUInt32LE(local)===0x04034b50) {
    const size=file.readUInt32LE(local+18), nameLength=file.readUInt16LE(local+26), extraLength=file.readUInt16LE(local+28);
    const name=file.subarray(local+30,local+30+nameLength).toString(), start=local+30+nameLength+extraLength;
    if(name===target) {
      expect(file.readUInt16LE(local+8)).toBe(0);
      const sheet=file.subarray(start,start+size);
      for(const [oldValue,newValue] of [["B006 XLSX Synthetic",valid],["B006 XLSX Invalid",invalid]]) {
        const old=Buffer.from(oldValue), replacement=Buffer.from(newValue), index=sheet.indexOf(old);
        expect(replacement.length).toBe(old.length); expect(index).toBeGreaterThanOrEqual(0); replacement.copy(sheet,index);
      }
      let crc=0xffffffff;
      for(const byte of sheet) {crc^=byte; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^(0xedb88320 & -(crc&1));}
      crc=(~crc)>>>0; file.writeUInt32LE(crc,local+14);
      const eocd=file.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])); expect(eocd).toBeGreaterThanOrEqual(0);
      let central=file.readUInt32LE(eocd+16), centralFound=false;
      while(central+46<=eocd && file.readUInt32LE(central)===0x02014b50) {
        const n=file.readUInt16LE(central+28),x=file.readUInt16LE(central+30),c=file.readUInt16LE(central+32);
        if(file.subarray(central+46,central+46+n).toString()===target) {file.writeUInt32LE(crc,central+16); centralFound=true; break;}
        central+=46+n+x+c;
      }
      expect(centralFound).toBe(true); found=true; break;
    }
    local=start+size;
  }
  expect(found).toBe(true); return {file,valid,invalid};
}
for(const width of [390,1280]) test(`actual CSV correction and resubmission at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:844}); const watch=observe(page); await localRequestsOnly(page,watch.errors); await signIn(page,ACCOUNTS.admin);
  const db=new Client({connectionString:url.href}); await db.connect();
  const original=(await db.query(`SELECT feature_flags ? 'import_error_details' AS present,feature_flags->'import_error_details' AS value FROM organizations WHERE id=$1`,[ORG_ID])).rows[0];
  const id=randomUUID().slice(0,8); const first=data(id,false), corrected=data(id,true);
  try {
    await setDetails(db,true); await page.goto("/api/demo/locale?set=zh-TW&next=/m/import");
    await upload(page,`b006-${id}.csv`,Buffer.from(first.csv),"text/csv");
    await expect(page.getByTestId("import-ok-count")).toHaveText("3"); await expect(page.getByTestId("import-err-count")).toHaveText("1");
    const invalid=page.locator('[data-testid="import-issue-row"][data-line="8"]');
    await expect(invalid).toContainText("起租日"); await expect(invalid).toContainText("到期日"); await expect(invalid).toContainText("YYYY-MM-DD");
    const downloadPromise=page.waitForEvent("download"); await page.getByTestId("import-errors-csv").click(); const dl=await downloadPromise;
    const temp=`../B006-real-evidence/errors-${width}-${id}.csv`; mkdirSync("../B006-real-evidence",{recursive:true}); await dl.saveAs(temp);
    const report=parseCsv(readFileSync(temp,"utf8")); const col=report[0].indexOf("原始列號"); expect(col).toBeGreaterThanOrEqual(0); expect(report.slice(1).map(r=>r[col])).toEqual(["8"]); expect(report[1].at(-1)).toContain("起租日"); expect(report[1].at(-1)).toContain("到期日");
    await page.getByTestId("import-run").click(); await expect(page.getByTestId("import-result")).toBeVisible();
    await expect(page.getByTestId("import-count-properties")).toHaveText("2"); await expect(page.getByTestId("import-count-units")).toHaveText("2"); await expect(page.getByTestId("import-count-leases")).toHaveText("3");
    const before=await records(db,[first.whole,first.rooms]); expect(before).toHaveLength(3);
    expect(await relationalCounts(db,[first.whole,first.rooms,first.fixed])).toEqual({properties:2,units:2,rooms:2,leases:3});
    expect(new Set(before.map(r=>r.property_id)).size).toBe(2); expect(new Set(before.map(r=>r.unit_id)).size).toBe(2); expect(before.filter(r=>r.room_id).length).toBe(2);
    expect(before.map(r=>[r.rent,r.deposit]).sort()).toEqual([["1000000","2000000"],["600000","1200000"],["700000","1400000"]].sort());
    for(const r of before) { expect(r.start_date).toBe("2027-01-01"); expect(r.end_date).toBe("2028-01-01"); expect(r.status).toBe("active"); expect(r.esign_status).toBe("imported"); if(r.room_id) {expect(r.target_room).toBe(r.room_id); expect(r.target_unit).toBeNull();} else {expect(r.target_unit).toBe(r.unit_id); expect(r.target_room).toBeNull();} }
    expect(await records(db,[first.fixed])).toHaveLength(0);
    await page.getByRole("button",{name:"再匯入一個檔案"}).click();
    await upload(page,`b006-${id}.csv`,Buffer.from(corrected.csv),"text/csv");
    await expect(page.getByTestId("import-ok-count")).toHaveText("1"); await expect(page.getByTestId("import-err-count")).toHaveText("0");
    await page.getByTestId("import-run").click(); await expect(page.getByTestId("import-result")).toBeVisible();
    await expect(page.getByTestId("import-count-properties")).toHaveText("1"); await expect(page.getByTestId("import-count-units")).toHaveText("1"); await expect(page.getByTestId("import-count-leases")).toHaveText("1");
    expect(await records(db,[first.whole,first.rooms])).toEqual(before);
    expect(await relationalCounts(db,[first.whole,first.rooms,first.fixed])).toEqual({properties:3,units:3,rooms:2,leases:4});
    const created=await records(db,[first.fixed]); expect(created).toHaveLength(1); expect(created[0].rent).toBe("900000"); expect(created[0].deposit).toBe("1800000"); expect(created[0].start_date).toBe("2027-01-01"); expect(created[0].end_date).toBe("2028-01-01");
    const commits=watch.requests.filter(r=>r.mode==="commit"); expect(commits).toHaveLength(2); expect(commits[0].rows.map(r=>r.line)).toEqual([3,4,6]); expect(commits[1].rows.map(r=>r.line)).toEqual([8]); expect(watch.requests.filter(r=>r.mode==="preview").length).toBeGreaterThanOrEqual(2);
    await page.screenshot({path:`../B006-real-evidence/import-${width}.png`,fullPage:true}); expect(watch.errors).toEqual([]);
    writeFileSync(`../B006-real-evidence/import-${width}.json`,JSON.stringify({width,previewAndCommitReal:true,http5xx:0,consoleErrors:0,pageErrors:0},null,2));
  } finally { await db.query(`UPDATE organizations SET feature_flags=CASE WHEN $2::boolean THEN jsonb_set(feature_flags,'{import_error_details}',$3::jsonb,true) ELSE feature_flags-'import_error_details' END WHERE id=$1`,[ORG_ID,original.present,JSON.stringify(original.value)]); await db.end(); }
});

test("actual sparse XLSX 1900 dates and organization-OFF diagnostics",async({page})=>{
  await page.setViewportSize({width:390,height:844}); const watch=observe(page); await localRequestsOnly(page,watch.errors); await signIn(page,ACCOUNTS.admin);
  const db=new Client({connectionString:url.href}); await db.connect();
  const original=(await db.query(`SELECT feature_flags ? 'import_error_details' AS present,feature_flags->'import_error_details' AS value FROM organizations WHERE id=$1`,[ORG_ID])).rows[0];
  try {
    await setDetails(db,true); await page.goto("/api/demo/locale?set=zh-TW&next=/m/import");
    const {file,valid,invalid}=instantiateXlsx(randomUUID().slice(0,8));
    await upload(page,"b006-sparse-1900.xlsx",file,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await expect(page.getByTestId("import-ok-count")).toHaveText("1"); await expect(page.getByTestId("import-err-count")).toHaveText("1");
    await expect(page.locator('[data-testid="import-issue-row"][data-line="9"]')).toContainText("起租日");
    await page.getByTestId("import-run").click(); await expect(page.getByTestId("import-result")).toBeVisible();
    const found=await records(db,[valid]); expect(found).toHaveLength(1); expect(found[0].start_date).toBe("2027-01-01"); expect(found[0].end_date).toBe("2028-01-01"); expect(found[0].rent).toBe("1250000"); expect(found[0].deposit).toBe("2500000");
    expect(await relationalCounts(db,[valid,invalid])).toEqual({properties:1,units:1,rooms:0,leases:1});
    expect(await records(db,[invalid])).toHaveLength(0);
    expect(watch.requests.filter(r=>r.mode==="commit").at(-1)?.rows.map(r=>r.line)).toEqual([5]);
    await setDetails(db,false); await page.goto("/m/import"); await upload(page,"b006-sparse-1900.xlsx",file,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await expect(page.getByTestId("import-preview-table").locator("thead")).not.toContainText("原始列號");
    await expect(page.getByTestId("import-err-count")).toHaveText("1");
    await expect(page.locator('[data-testid="import-issue-row"][data-line="3"]')).toBeVisible();
    expect(watch.errors).toEqual([]);
  } finally {await db.query(`UPDATE organizations SET feature_flags=CASE WHEN $2::boolean THEN jsonb_set(feature_flags,'{import_error_details}',$3::jsonb,true) ELSE feature_flags-'import_error_details' END WHERE id=$1`,[ORG_ID,original.present,JSON.stringify(original.value)]); await db.end();}
});
