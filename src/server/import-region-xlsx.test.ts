import assert from "node:assert/strict";
import test from "node:test";
import { readSpreadsheet, SpreadsheetError } from "../lib/spreadsheet";

/** Small stored ZIP with an actual workbook and sparse numeric worksheet. */
function workbook(epoch: string | null, prefix = "", propertyTag?: string): Uint8Array {
  const entries = [
    ["xl/workbook.xml", `<workbook>${prefix}${propertyTag ?? `<workbookPr${epoch === null ? "" : ` date1904="${epoch}"`}/>`}</workbook>`],
    ["xl/worksheets/sheet1.xml", '<worksheet><row r="1"><c r="A1" t="inlineStr"><is><t>Start</t></is></c></row><row r="7"><c r="A7"><v>46327</v></c></row></worksheet>'],
  ];
  const locals: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const name = Buffer.from(path), data = Buffer.from(content), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50,0); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42);
    locals.push(local,name,data); directory.push(central,name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(central.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,central,end]);
}

test("actual XLSX reader rejects 1904 epoch only on guarded path and keeps sparse row numbers", async () => {
  for (const value of ["true","1","\ntrue\n"," 1 "]) {
    const bytes = workbook(value);
    await assert.rejects(readSpreadsheet("source.xlsx",bytes,undefined,{reject1904:true}),
      (error: unknown) => error instanceof SpreadsheetError && error.code === "epoch");
    const legacy = await readSpreadsheet("source.xlsx",bytes);
    assert.deepEqual(legacy.rowNumbers,[1,7]);
    assert.equal(legacy.rows[1][0],"46327");
  }
  await assert.rejects(readSpreadsheet("source.xlsx",workbook("true",'<!-- <workbookPr date1904="false"/> -->'),undefined,{reject1904:true}),
    (error: unknown) => error instanceof SpreadsheetError && error.code === "epoch");
  for (const bytes of [workbook("unknown"),workbook('false" date1904="true'),workbook("false",'<workbookPr date1904="true"/>'),
    workbook("true",'<![CDATA[<workbookPr date1904="false"/>]]>')]) {
    await assert.rejects(readSpreadsheet("source.xlsx",bytes,undefined,{reject1904:true}),
      (error: unknown) => error instanceof SpreadsheetError && error.code === "epoch");
  }
  for (const value of ["false","0","\nfalse\n",null]) {
    const sheet = await readSpreadsheet("source.xlsx",workbook(value),undefined,{reject1904:true});
    assert.deepEqual(sheet.rowNumbers,[1,7]);
    assert.equal(sheet.rows[1][0],"46327");
  }
  for (const tag of ['<workbookPr codeName="a>b" date1904="true"/>',
    "<workbookPr codeName='a>b' date1904='1'/>",
    '<workbookPr codeName="unterminated date1904="true"/>']) {
    const bytes = workbook(null,"",tag);
    await assert.rejects(readSpreadsheet("source.xlsx",bytes,undefined,{reject1904:true}),
      (error: unknown) => error instanceof SpreadsheetError && error.code === "epoch");
    const legacy = await readSpreadsheet("source.xlsx",bytes);
    assert.deepEqual(legacy.rowNumbers,[1,7]);
    assert.equal(legacy.rows[1][0],"46327");
  }
  for (const tag of ['<workbookPr codeName="a>b" date1904="false"/>',
    "<workbookPr codeName='a>b' date1904='0'/>"]) {
    const sheet = await readSpreadsheet("source.xlsx",workbook(null,"",tag),undefined,{reject1904:true});
    assert.deepEqual(sheet.rowNumbers,[1,7]);
    assert.equal(sheet.rows[1][0],"46327");
  }
});
