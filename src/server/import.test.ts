import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildXlsx, csvDocument, decodeBytes, readSpreadsheet, SpreadsheetError } from "../lib/spreadsheet";
import { FlowError } from "./errors";
import { hashIdNumber, parseIdHmacKey } from "./id-hash";
import { ORG2_ID, ORG_ID } from "./ids";
import { IMPORT_BODY_MAX_BYTES, readImportBody } from "./import-batch";
import {
  IMPORT_COMMIT_BATCH,
  IMPORT_FIELDS,
  IMPORT_FIELD_MAX,
  IMPORT_MAX_ROWS,
  IMPORT_MONEY_MAX,
  coerceImportRows,
  emptyIndex,
  matchColumns,
  planOne,
  templateHeaders,
  validateImportRows,
  type ImportRequestRow,
} from "./owner-import";

const BIG5_CSV = Buffer.from(
  "qqul86ZXutkspmGnfSyrzqVEqW2mVyyrzqVEIEVtYWlsLKVYr7KrrLpBLKThp0+h/rzTvGgsqdC4uSyp0KusLKlXvMYspOuvsiyvsqvIqW2mVyyvsqvIuXG43CyvsqvIIEVtYWlsLK+yq8ioraTAw9Kmcri5LLBfr7Kk6Syo7LTBpOksqeOq9yzDuq+ypOksuXG2T6TopqEsqEOr17lxu/kspXi5cbFis+ar17zGLKV4uXGxYrPmqvfDQiy0warspO202iyp46r3tle5TKRXra2t7KZdLLlxu/m2V7lMpFetra3spl0ss8a1+Qq216RKpL20SiyleKVfpaukaqZ3sM+216RKuPQ4uLkstPq41avOpUQsb3duZXIuYmlnNUBleGFtcGxlLmNvbSykwK+yLDJGLEEsLCwxMDAwMCyp46r3r7KryCwwOTEyMDAwMTExLGRlcC5iaWc1QGV4YW1wbGUuY29tLEExMjM0NTY3ODksMjAyNi0xMS0wMSwyMDI3LTEwLTMxLDMwMDAwLDUspMCq7Sw2LDEwMCw0MDAsLCy5cbv5reymXSwKttekSqS9tEospXilX6WrpGqmd7DPttekSrj0OLi5LLT6uNWrzqVELG93bmVyLmJpZzVAZXhhbXBsZS5jb20spMCvsiwyRixCLCwsMTAwMDAsqOy0wa+yq8gsMDkxMjAwMDMzMyxlbmQuYmlnNUBleGFtcGxlLmNvbSxCMTIzNDU2NzgwLDIwMjQtMDEtMDEsMjAyNS0wMS0wMSwyMDAwMCw1LKTAqu0sLCwsLCwsCrbXpEqkvbRKLKV4pV+lq6Rqpnewz7bXpEq49Di4uSy0+rjVq86lRCxvd25lci5iaWc1QGV4YW1wbGUuY29tLKTAr7IsM0YsQSwsLDEwMDAwLKazrsSvsqvILDA5MTIwMDAyMjIsb2suYmlnNUBleGFtcGxlLmNvbSxDMTIzNDU2NzgxLDIwMjYtMTEtMDEsMjAyNy0xMC0zMSwyMDAwMCw1LCwsLCwsLCwK",
  "base64",
);

function blank(line = 2): ImportRequestRow {
  return {
    line,
    propertyName: "",
    address: "",
    ownerName: "",
    ownerEmail: "",
    rentalMode: "",
    unitLabel: "",
    roomLabel: "",
    roomType: "",
    area: "",
    rent: "",
    tenantName: "",
    tenantPhone: "",
    tenantEmail: "",
    tenantId: "",
    startDate: "",
    endDate: "",
    deposit: "",
    dueDay: "",
    electricity: "",
    rate: "",
    billKwh: "",
    billAmount: "",
    opening: "",
    depositReason: "",
    rateReason: "",
    notes: "",
  };
}

function lease(overrides: Partial<ImportRequestRow> = {}): ImportRequestRow {
  return {
    ...blank(),
    propertyName: "匯入公寓",
    address: "台北市大安區匯入路8號",
    ownerName: "測試屋主",
    ownerEmail: "owner@example.com",
    rentalMode: "整層",
    unitLabel: "5F",
    rent: "10000",
    tenantName: "有效租客",
    tenantPhone: "0912000222",
    tenantEmail: "ok@example.com",
    startDate: "2026-11-01",
    endDate: "2027-10-31",
    deposit: "20000",
    dueDay: "5",
    ...overrides,
  };
}

test("spreadsheet auto-detects Big5 and round-trips xlsx text", async () => {
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(BIG5_CSV));
  const decoded = decodeBytes(Uint8Array.from(BIG5_CSV));
  assert.equal(decoded.encoding, "big5");
  assert.match(decoded.text, /屋主姓名/);
  assert.match(decoded.text, /匯入公寓/);
  assert.equal(decoded.text.includes("\u623f\u6771"), false);

  const sheet = await readSpreadsheet("big5.csv", Uint8Array.from(BIG5_CSV));
  assert.equal(sheet.encoding, "big5");
  assert.equal(sheet.rows.length, 4);
  assert.equal(sheet.rows[3][10], "有效租客");

  const utf8 = new TextEncoder().encode("\uFEFF物件名稱,地址\n匯入,台北\n");
  assert.equal(decodeBytes(utf8).encoding, "utf-8");

  await assert.rejects(() => readSpreadsheet("old.xls", Uint8Array.from([0xd0, 0xcf])), (error: unknown) => error instanceof SpreadsheetError && error.code === "xls");

  const source = [templateHeaders("zh-TW"), ["匯入公寓", "台北市大安區匯入路8號", "測試屋主"]];
  const xlsx = await buildXlsx(source);
  const back = await readSpreadsheet("sample.xlsx", xlsx);
  assert.equal(back.encoding, "xlsx");
  assert.deepEqual(back.rows, source);

  const wide = [templateHeaders("zh-TW")];
  for (let i = 1; i <= 500; i += 1) wide.push([`物件${i}`, `地址${i}`, "屋主", "a@example.com", "整層", `U${String(i).padStart(4, "0")}`]);
  const fiveHundred = await readSpreadsheet("five.xlsx", await buildXlsx(wide));
  assert.equal(fiveHundred.rows.length, 501);
  assert.equal(fiveHundred.rows[500][5], "U0500");
  assert.equal(fiveHundred.rows[250][0], "物件250");
});

test("column match accepts legacy owner headers and ignores a client org id", () => {
  const headers = templateHeaders("zh-TW");
  const mapped = matchColumns(headers);
  for (const field of IMPORT_FIELDS) assert.equal(mapped[field], IMPORT_FIELDS.indexOf(field), field);
  const legacy = matchColumns(["\u623f\u6771\u59d3\u540d", "\u623f\u6771email", "月租金", "戶別"]);
  assert.equal(legacy.ownerName, 0);
  assert.equal(legacy.ownerEmail, 1);
  assert.equal(legacy.rent, 2);
  assert.equal(legacy.unitLabel, 3);
  assert.equal(templateHeaders("zh-TW").join(",").includes("\u623f\u6771"), false);
  assert.equal(templateHeaders("zh-TW").join(",").includes("房客"), false);
  assert.match(templateHeaders("zh-TW").join(","), /屋主姓名/);
  assert.match(templateHeaders("zh-TW").join(","), /租客姓名/);

  const coerced = coerceImportRows([{ orgId: ORG2_ID, propertyName: "只此欄", line: 9, extra: "nope" }]);
  assert.equal(coerced.length, 1);
  assert.equal(coerced[0].propertyName, "只此欄");
  assert.equal(coerced[0].line, 9);
  assert.equal(Object.prototype.hasOwnProperty.call(coerced[0], "orgId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(coerced[0], "extra"), false);
  assert.equal(IMPORT_MAX_ROWS, 2000);
  assert.equal(IMPORT_COMMIT_BATCH, 50);
});

test("row checks cover deposit cap, ended leases, duplicates, due day, and phone", () => {
  const today = "2026-10-21";
  const over = validateImportRows([lease({ deposit: "30000" })], today)[0];
  assert.ok(over.issues.some((issue) => issue.severity === "error" && issue.key === "im_e_dep" && issue.vars?.v === 3 && issue.vars?.cap === 2));

  const explained = validateImportRows([lease({ deposit: "30000", depositReason: "屋主同意" })], today)[0];
  assert.equal(explained.issues.some((issue) => issue.severity === "error"), false);
  assert.ok(explained.issues.some((issue) => issue.key === "im_w_dep"));

  const ended = validateImportRows([lease({ startDate: "2024-01-01", endDate: "2025-01-01", unitLabel: "6F" })], today)[0];
  assert.ok(ended.issues.some((issue) => issue.key === "im_e_ended"));

  const due = validateImportRows([lease({ dueDay: "31", unitLabel: "7F" })], today)[0];
  assert.ok(due.issues.some((issue) => issue.key === "im_e_due"));

  const phone = validateImportRows([lease({ tenantPhone: "123", unitLabel: "8F" })], today)[0];
  assert.ok(phone.issues.some((issue) => issue.key === "im_e_phone"));

  const serial = String(Math.round((Date.UTC(2026, 10, 1) - Date.UTC(1899, 11, 30)) / 86400000));
  const dated = validateImportRows([lease({ startDate: serial, unitLabel: "9F" })], today)[0];
  assert.equal(dated.startDate, "2026-11-01");

  const dup = validateImportRows(
    [lease({ unitLabel: "2F", rentalMode: "分租", roomLabel: "A" }), lease({ line: 3, unitLabel: "2F", rentalMode: "分租", roomLabel: "A" })],
    today,
  );
  assert.ok(dup[1].issues.some((issue) => issue.key === "im_e_dup" && issue.vars?.n === 2));

  const clash = validateImportRows(
    [lease({ propertyName: "同名", address: "台北市甲路1號" }), lease({ line: 3, propertyName: "同名", address: "台北市乙路2號", unitLabel: "6F" })],
    today,
  );
  assert.ok(clash[1].issues.some((issue) => issue.key === "im_e_exists"));

  const whole = validateImportRows([lease({ rentalMode: "整層", roomLabel: "A", unitLabel: "10F" })], today)[0];
  assert.ok(whole.issues.some((issue) => issue.key === "im_e_whole_room"));
});

test("an existing unit, tenant, and lease are reused", () => {
  const [parsed] = validateImportRows([lease()], "2026-10-21");
  parsed.tenantIdHash = "abc";
  const index = emptyIndex();
  index.properties.set(parsed.propertyName, { id: "prop-1", addressKey: parsed.addressKey });
  index.units.set(`${parsed.addressKey}\n${parsed.unitLabel}`, { id: "unit-1", propertyId: "prop-1", mode: "whole_unit" });
  index.ownersByEmail.set(parsed.ownerEmail ?? "", "owner-1");
  index.tenantsByPhone.set(parsed.phoneE164 ?? "", ["tenant-1"]);
  index.tenantsByHash.set("abc", ["tenant-1"]);
  index.leases.push({
    spaceKey: "unit:unit-1",
    start: "2026-11-01",
    end: "2027-10-31",
    phone: parsed.phoneE164,
    idHash: "abc",
    tenantId: "tenant-1",
    rentMinor: parsed.rentMinor,
    depositMinor: parsed.depositMinor,
    dueDay: parsed.dueDay ?? -1,
  });
  const plan = planOne(parsed, index);
  assert.equal(plan.blocked, false);
  assert.equal(plan.reuseUnit, true);
  assert.equal(plan.reuseTenant, true);
  assert.equal(plan.reuseLease, true);
  assert.equal(plan.createLease, false);

  const changed = planOne({ ...parsed, rentMinor: parsed.rentMinor + 100 }, index);
  assert.equal(changed.blocked, true);
  assert.equal(changed.reuseLease, false);
  assert.ok(changed.issues.some((issue) => issue.key === "im_e_terms"));

  const other = planOne({ ...parsed, phoneE164: "+886912000333", tenantIdHash: "other" }, index);
  assert.equal(other.blocked, true);
  assert.ok(other.issues.some((issue) => issue.key === "im_e_occupied"));
});

test("an ID that misses does not fall back to the phone, and a shared phone is not reused", () => {
  const [parsed] = validateImportRows([lease({ tenantId: "A123456789" })], "2026-10-21");
  parsed.tenantId = null;
  parsed.tenantIdHash = "hash-new";
  const index = emptyIndex();
  index.tenantsByPhone.set(parsed.phoneE164 ?? "", ["tenant-phone"]);
  const mismatch = planOne(parsed, index);
  assert.equal(mismatch.blocked, true);
  assert.equal(mismatch.reuseTenant, false);
  assert.ok(mismatch.issues.some((issue) => issue.key === "im_e_tenant"));

  const phoneOnly = { ...parsed, tenantId: null, tenantIdHash: null };
  index.tenantsByPhone.set(parsed.phoneE164 ?? "", ["tenant-a", "tenant-b"]);
  const dup = planOne(phoneOnly, index);
  assert.equal(dup.blocked, true);
  assert.ok(dup.issues.some((issue) => issue.key === "im_e_phone_dup"));

  index.tenantsByPhone.set(parsed.phoneE164 ?? "", ["tenant-only"]);
  const unique = planOne(phoneOnly, index);
  assert.equal(unique.blocked, false);
  assert.equal(unique.reuseTenant, true);
  assert.equal(unique.tenantId, "tenant-only");
});

test("over-long fields and out-of-range amounts are rejected", () => {
  assert.throws(
    () => coerceImportRows([{ propertyName: "x".repeat(IMPORT_FIELD_MAX + 1) }]),
    (error: unknown) => error instanceof FlowError && error.key === "im_e_len",
  );
  const huge = validateImportRows([lease({ rent: String(IMPORT_MONEY_MAX + 1) })], "2026-10-21")[0];
  assert.ok(huge.issues.some((issue) => issue.key === "im_e_bound"));
  assert.equal(huge.issues.some((issue) => issue.key === "im_e_len"), false);
});

test("ID hashes are org-bound HMAC values, not plain SHA-256", () => {
  const number = "A123456789";
  const raw = process.env.ID_DOC_HMAC_KEY?.trim();
  const key = raw ? parseIdHmacKey(raw) : createHash("sha256").update("condola-demo-id-hmac").digest();
  assert.ok(key);
  const expected = createHmac("sha256", key).update(`${ORG_ID}\n${number}`).digest("hex");
  assert.equal(hashIdNumber(`  ${number.toLowerCase()} `, ORG_ID), expected);
  assert.notEqual(hashIdNumber(number, ORG_ID), hashIdNumber(number, ORG2_ID));
  assert.notEqual(expected, createHash("sha256").update(number).digest("hex"));
  assert.notEqual(expected, createHash("sha256").update(`${ORG_ID}\n${number}`).digest("hex"));
});

test("import requests reject a null body, an unknown mode, and a body over the byte cap", async () => {
  const url = "http://local/api/import";
  await assert.rejects(
    () => readImportBody(new Request(url, { method: "POST", body: "null" })),
    (error: unknown) => error instanceof FlowError && error.key === "im_body",
  );
  await assert.rejects(
    () => readImportBody(new Request(url, { method: "POST", body: JSON.stringify({ mode: "wipe", rows: [] }) })),
    (error: unknown) => error instanceof FlowError && error.key === "im_bad_mode",
  );
  const oversized = {
    headers: new Headers({ "content-length": String(IMPORT_BODY_MAX_BYTES + 1) }),
    text: async () => "{}",
  } as Request;
  await assert.rejects(
    () => readImportBody(oversized),
    (error: unknown) => error instanceof FlowError && error.key === "im_body",
  );
});

test("error CSV cells neutralize formula injection", () => {
  const csv = csvDocument([["=cmd", "+1", "-2", "@x", "\tok", "safe"]]);
  assert.match(csv, /'=cmd/);
  assert.match(csv, /'\+1/);
  assert.match(csv, /'-2/);
  assert.match(csv, /'@x/);
  assert.match(csv, /'\tok/);
  assert.equal(/^[=+\-@\t\r]/m.test(csv.replace(/^\uFEFF/, "")), false);
});

test("zh-TW import copy uses 屋主 and 租客", () => {
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const keys = Object.keys(zh).filter((key) => key.startsWith("im_"));
  assert.ok(keys.length > 40);
  for (const key of keys) {
    assert.equal(zh[key].includes("\u623f\u6771"), false, key);
    assert.equal(zh[key].includes("房客"), false, key);
  }
  assert.match(zh.im_title, /匯入/);
  assert.match(zh.im_e_dep, /押金/);
  assert.match(zh.im_dry_h, /尚未寫入/);
});
