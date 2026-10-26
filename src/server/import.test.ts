import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { buildXlsx, csvDocument, decodeBytes, readSpreadsheet, SpreadsheetError } from "../lib/spreadsheet";
import { FlowError } from "./errors";
import { readdirSync, readFileSync } from "node:fs";
import { HMAC_KEY_REF, hashIdNumber, parseIdHmacKey } from "./id-hash";
import { ORG2_ID, ORG_ID } from "./ids";
import { IMPORT_BODY_MAX_BYTES, IMPORT_WRITE_CHUNK, commitImportBatch, dryRunImport, previewImport, readImportBody } from "./import-batch";
import {
  IMPORT_DRY_BATCH,
  IMPORT_FIELDS,
  IMPORT_FIELD_MAX,
  IMPORT_MAX_ROWS,
  IMPORT_MONEY_MAX,
  IMPORT_PREVIEW_BATCH,
  coerceImportRows,
  emptyIndex,
  ignoredNationalIdHeaders,
  indexTenantPhone,
  issuePreviewColumns,
  matchColumns,
  phoneMatchKeys,
  planOne,
  planRows,
  previewBadColumns,
  totalsFromPlans,
  rowHasError,
  tableToRows,
  templateHeaders,
  validateImportRows,
  type ImportRequestRow,
} from "./owner-import";
import type { Session } from "./types";

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
  assert.equal(templateHeaders("zh-TW").some((header) => header.includes("身分證")), false);
  assert.equal(templateHeaders("en").some((header) => /national id|tenant id/i.test(header)), false);
  assert.equal(IMPORT_FIELDS.includes("tenantId" as (typeof IMPORT_FIELDS)[number]), false);

  const coerced = coerceImportRows([{ orgId: ORG2_ID, propertyName: "只此欄", line: 9, extra: "nope" }]);
  assert.equal(coerced.length, 1);
  assert.equal(coerced[0].propertyName, "只此欄");
  assert.equal(coerced[0].line, 9);
  assert.equal(Object.prototype.hasOwnProperty.call(coerced[0], "orgId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(coerced[0], "extra"), false);
  assert.equal(IMPORT_MAX_ROWS, 2000);
  assert.equal(IMPORT_DRY_BATCH, 25);
  const withId = coerceImportRows([{ line: 4, propertyName: "甲", tenantId: "A123456789", "租客身分證字號": "B123456789" }]);
  assert.equal(JSON.stringify(withId).includes("A123456789"), false);
  assert.equal(JSON.stringify(withId).includes("B123456789"), false);

  const idHeaders = ["物件名稱", "租客身分證字號", "月租", "National ID"];
  assert.deepEqual(ignoredNationalIdHeaders(idHeaders), ["租客身分證字號", "National ID"]);
  assert.deepEqual(ignoredNationalIdHeaders(["租客姓名", "屋主姓名"]), []);
  const dropped = tableToRows([idHeaders, ["甲", "A123456789", "10000", "Z999"]], matchColumns(idHeaders));
  assert.equal(JSON.stringify(dropped).includes("A123456789"), false);
  assert.equal(JSON.stringify(dropped).includes("Z999"), false);
  assert.equal(dropped[0].propertyName, "甲");
  assert.equal(dropped[0].rent, "10000");
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

test("an existing unit, tenant, and lease are reused and counted as already present", () => {
  const [parsed] = validateImportRows([lease()], "2026-10-21");
  const index = emptyIndex();
  index.properties.set(parsed.propertyName, { id: "prop-1", addressKey: parsed.addressKey });
  index.units.set(`${parsed.addressKey}\n${parsed.unitLabel}`, { id: "unit-1", propertyId: "prop-1", mode: "whole_unit" });
  index.ownersByEmail.set(parsed.ownerEmail ?? "", "owner-1");
  index.tenantsByPhone.set(parsed.phoneE164 ?? "", [{ id: "tenant-1", name: parsed.tenantName ?? "" }]);
  index.leases.push({
    spaceKey: "unit:unit-1",
    start: "2026-11-01",
    end: "2027-10-31",
    phone: parsed.phoneE164,
    idHash: null,
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
  const totals = totalsFromPlans([plan], "again.xlsx", false);
  assert.equal(totals.duplicateRows, 1);
  assert.equal(totals.created.leases, 0);
  assert.ok(plan.issues.some((issue) => issue.key === "im_row_exists" && issue.severity === "warn"));
  assert.equal(plan.blocked, false);

  const changed = planOne({ ...parsed, rentMinor: parsed.rentMinor + 100 }, index);
  assert.equal(changed.blocked, true);
  assert.equal(changed.reuseLease, false);
  assert.ok(changed.issues.some((issue) => issue.key === "im_e_terms"));

  const other = planOne({ ...parsed, phoneE164: "+886912000333" }, index);
  assert.equal(other.blocked, true);
  assert.ok(other.issues.some((issue) => issue.key === "im_e_occupied"));
});

test("a shared phone is not reused, and full-width numbers, ROC dates, and Excel phones are accepted", () => {
  const [parsed] = validateImportRows([lease()], "2026-10-21");
  const index = emptyIndex();
  const phoneOnly = parsed;
  index.tenantsByPhone.set(parsed.phoneE164 ?? "", [
    { id: "tenant-a", name: "甲" },
    { id: "tenant-b", name: "乙" },
  ]);
  const dup = planOne(phoneOnly, index);
  assert.equal(dup.blocked, true);
  assert.ok(dup.issues.some((issue) => issue.key === "im_e_phone_dup"));

  index.tenantsByPhone.set(parsed.phoneE164 ?? "", [{ id: "tenant-only", name: parsed.tenantName ?? "" }]);
  const unique = planOne(phoneOnly, index);
  assert.equal(unique.blocked, false);
  assert.equal(unique.reuseTenant, true);
  assert.equal(unique.tenantId, "tenant-only");

  index.tenantsByPhone.set(parsed.phoneE164 ?? "", [{ id: "tenant-other", name: "別的租客" }]);
  const wrongName = planOne(phoneOnly, index);
  assert.equal(wrongName.blocked, true);
  assert.equal(wrongName.reuseTenant, false);
  assert.equal(wrongName.createTenant, false);
  const phoneIssue = wrongName.issues.find((issue) => issue.key === "im_e_phone_name");
  assert.ok(phoneIssue);
  assert.equal(phoneIssue?.vars?.n, phoneOnly.line);
  assert.equal(phoneIssue?.vars?.name, "別的租客");

  const trunk = emptyIndex();
  indexTenantPhone(trunk.tenantsByPhone, "+8860912000111", { id: "tenant-trunk", name: "陳美玲" });
  const [trunkRow] = validateImportRows([lease({ tenantName: "別人", tenantPhone: "0912000111", unitLabel: "21F" })], "2026-10-21");
  const trunkPlan = planOne(trunkRow, trunk);
  const trunkIssue = trunkPlan.issues.find((issue) => issue.key === "im_e_phone_name");
  assert.equal(trunkPlan.blocked, true);
  assert.equal(trunkIssue?.vars?.n, trunkRow.line);
  assert.equal(trunkIssue?.vars?.name, "陳美玲");
  assert.deepEqual(phoneMatchKeys("+886912000111").sort(), ["+8860912000111", "+886912000111", "912000111"].sort());
  assert.deepEqual(phoneMatchKeys("+8860912000111").sort(), phoneMatchKeys("+886912000111").sort());
  assert.deepEqual(phoneMatchKeys("+14155552671"), ["+14155552671"]);

  const wide = validateImportRows(
    [lease({ rent: "１２，０００", deposit: "２４，０００", dueDay: "５", startDate: "115/01/05", endDate: "民國116年1月5日", tenantPhone: "９１２０００２２２", unitLabel: "11F" })],
    "2026-10-21",
  )[0];
  assert.equal(wide.issues.some((issue) => issue.severity === "error"), false);
  assert.equal(wide.rentMajor, 12000);
  assert.equal(wide.depositMajor, 24000);
  assert.equal(wide.dueDay, 5);
  assert.equal(wide.startDate, "2026-01-05");
  assert.equal(wide.endDate, "2027-01-05");
  assert.equal(wide.phoneE164, "+886912000222");

  const scientific = validateImportRows([lease({ tenantPhone: "9.12000333E8", unitLabel: "12F" })], "2026-10-21")[0];
  assert.equal(scientific.phoneE164, "+886912000333");
});

test("ROC year 115 is 2026-01-05 for era text, separators, and full-width digits", () => {
  const forms = ["民國115年1月5日", "115年1月5日", "115.01.05", "115-1-5", "民國１１５年１月５日"];
  for (const [index, form] of forms.entries()) {
    const row = validateImportRows([lease({ startDate: form, unitLabel: `R${index}` })], "2026-10-21")[0];
    assert.equal(row.issues.some((issue) => issue.key === "im_e_date"), false, form);
    assert.equal(row.startDate, "2026-01-05", form);
  }
});

test("one blocked row zeroes the commit totals and a dry run still counts the valid rows", () => {
  const rows = validateImportRows(
    [lease({ unitLabel: "1F" }), lease({ line: 3, unitLabel: "2F", deposit: "90000" })],
    "2026-10-21",
  );
  const plans = planRows(rows, emptyIndex());
  const commit = totalsFromPlans(plans, "mix.csv", false);
  assert.equal(plans.some((plan) => plan.blocked), true);
  assert.equal(commit.created.properties, 0);
  assert.equal(commit.created.leases, 0);
  assert.equal(commit.duplicateRows, 0);
  assert.ok(commit.errors.some((issue) => issue.key === "im_e_dep"));
  const dry = totalsFromPlans(plans, "mix.csv", true);
  assert.equal(dry.created.leases, 1);
  assert.ok(dry.errors.some((issue) => issue.key === "im_e_dep"));
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

test("ID hashes match the uploader HMAC and fail closed without a key", () => {
  const number = "A123456789";
  const saved = {
    key: process.env.ID_DOC_HMAC_KEY,
    phase: process.env.NEXT_PHASE,
    demo: process.env.DEMO_MODE,
    nodeEnv: process.env.NODE_ENV,
    condola: process.env.CONDOLA_ENV,
  };
  const restore = () => {
    restoreEnv("ID_DOC_HMAC_KEY", saved.key);
    restoreEnv("NEXT_PHASE", saved.phase);
    restoreEnv("DEMO_MODE", saved.demo);
    restoreEnv("NODE_ENV", saved.nodeEnv);
    restoreEnv("CONDOLA_ENV", saved.condola);
  };
  try {
    process.env.ID_DOC_HMAC_KEY = "22".repeat(32);
    delete process.env.NEXT_PHASE;
    const key = parseIdHmacKey(process.env.ID_DOC_HMAC_KEY);
    assert.ok(key);
    const expected = createHmac("sha256", key).update(`${HMAC_KEY_REF}\n${ORG_ID}\n${number}`).digest("hex");
    assert.equal(hashIdNumber(`  ${number.toLowerCase()} `, ORG_ID), expected);
    assert.notEqual(hashIdNumber(number, ORG_ID), hashIdNumber(number, ORG2_ID));
    assert.notEqual(expected, createHmac("sha256", key).update(`${ORG_ID}\n${number}`).digest("hex"));
    assert.notEqual(expected, createHash("sha256").update(`${HMAC_KEY_REF}\n${ORG_ID}\n${number}`).digest("hex"));

    delete process.env.ID_DOC_HMAC_KEY;
    restoreEnv("NODE_ENV", "production");
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.DEMO_MODE = "true";
    assert.throws(() => hashIdNumber(number, ORG_ID), /ID_DOC_HMAC_KEY is required/);

    restoreEnv("NODE_ENV", "test");
    delete process.env.NEXT_PHASE;
    delete process.env.CONDOLA_ENV;
    process.env.DEMO_MODE = "true";
    const demoKey = createHash("sha256").update("condola-demo-id-hmac").digest();
    const demoExpected = createHmac("sha256", demoKey).update(`${HMAC_KEY_REF}\n${ORG_ID}\n${number}`).digest("hex");
    assert.equal(hashIdNumber(number, ORG_ID), demoExpected);
  } finally {
    restore();
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function adminSession(): Session {
  return {
    userId: "20000000-0000-4000-8000-000000000001",
    sessionId: "import-unit",
    email: "admin@example.com",
    name: "Admin",
    kind: "staff",
    role: "admin",
    orgId: ORG_ID,
    liveOrgId: ORG_ID,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

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
  const payload = JSON.stringify({ mode: "dry", fileName: "a.csv", rows: [] });
  const lyingLarge = {
    headers: new Headers({ "content-length": String(IMPORT_BODY_MAX_BYTES + 50) }),
    body: streamOf(new TextEncoder().encode(payload)),
  } as Request;
  const accepted = await readImportBody(lyingLarge);
  assert.equal(accepted.mode, "dry");
  assert.equal(accepted.fileName, "a.csv");

  const chunk = new Uint8Array(64 * 1024);
  const parts: Uint8Array[] = [];
  let sent = 0;
  while (sent <= IMPORT_BODY_MAX_BYTES) {
    parts.push(chunk);
    sent += chunk.byteLength;
  }
  const lyingSmall = {
    headers: new Headers({ "content-length": "16" }),
    body: streamOf(...parts),
  } as Request;
  await assert.rejects(
    () => readImportBody(lyingSmall),
    (error: unknown) => error instanceof FlowError && error.key === "im_body",
  );
});

function streamOf(...parts: Uint8Array[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[index]);
      index += 1;
    },
  });
}

test("the 2000-row cap counts parsed rows for csv and xlsx names", async () => {
  const session = adminSession();
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ line: index + 2, propertyName: "x" }));
  await assert.rejects(
    () => dryRunImport(session, { fileName: "too-many.csv", rows: many(IMPORT_MAX_ROWS + 1) }),
    (error: unknown) => error instanceof FlowError && error.key === "im_too_many" && error.vars?.max === IMPORT_MAX_ROWS,
  );
  await assert.rejects(
    () => commitImportBatch(session, { fileName: "too-many.xlsx", rows: many(IMPORT_MAX_ROWS + 1) }),
    (error: unknown) => error instanceof FlowError && error.key === "im_too_many" && error.vars?.max === IMPORT_MAX_ROWS,
  );
  await assert.rejects(
    () => dryRunImport(session, { fileName: "batch.csv", rows: many(IMPORT_DRY_BATCH + 1) }),
    (error: unknown) => error instanceof FlowError && error.key === "im_too_many" && error.vars?.max === IMPORT_DRY_BATCH,
  );
  await assert.rejects(
    () => previewImport(session, { fileName: "preview.csv", rows: many(IMPORT_PREVIEW_BATCH + 1) }),
    (error: unknown) => error instanceof FlowError && error.key === "im_too_many" && error.vars?.max === IMPORT_PREVIEW_BATCH,
  );
  const previewBody = await readImportBody(
    new Request("http://local/api/import", { method: "POST", body: JSON.stringify({ mode: "preview", fileName: "a.csv", rows: [] }) }),
  );
  assert.equal(previewBody.mode, "preview");
  assert.equal(coerceImportRows(many(500), IMPORT_MAX_ROWS).length, 500);
  assert.equal(IMPORT_WRITE_CHUNK, 100);
});

test("a confirmed import is one transaction and the screen posts it once", () => {
  const source = readFileSync(new URL("./import-batch.ts", import.meta.url), "utf8");
  const wizard = readFileSync(new URL("../components/import-wizard.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(source.match(/await tx\(/g)?.length, 3);
  const commitStart = source.indexOf("export async function commitImportBatch");
  const commitFn = source.slice(commitStart);
  assert.equal(commitFn.match(/await tx\(/g)?.length, 1);
  assert.match(source, /IMPORT_WRITE_CHUNK/);
  assert.match(source, /statement_timeout/);
  assert.match(source, /relaxStatementTimeout/);
  assert.match(source, /phoneMatchKeys/);
  assert.doesNotMatch(source, /normalize\(coalesce/);
  assert.doesNotMatch(source, /NFKC\)/);
  assert.doesNotMatch(source, /SAVEPOINT/i);
  assert.doesNotMatch(source, /IMPORT_COMMIT_BATCH/);
  assert.equal(wizard.match(/postImport\("commit"/g)?.length, 1);
  assert.match(wizard, /import-ignored-id/);
  assert.match(wizard, /im_progress_n/);
  assert.match(wizard, /previewDone/);
  assert.match(wizard, /im_checking/);
  assert.match(wizard, /importableCount > 0/);
  assert.match(wizard, /previewDone && importableCount === 0/);
  assert.match(wizard, /t\("im_nothing"\)/);
  assert.match(wizard, /importableCount > 0 \? t\("im_run", \{ n: importableCount \}\) : t\("im_run_empty"\)/);
  assert.doesNotMatch(wizard, /t\("im_run", \{ n: 0 \}\)/);
  assert.doesNotMatch(wizard, /匯入 0 筆/);
  assert.match(wizard, /im_none/);
  assert.match(wizard, /import-retry/);
  assert.match(wizard, /claimFormSubmit\(submitGuard\)/);
  assert.match(wizard, /releaseFormSubmit\(submitGuard\)/);
  assert.match(wizard, /disabled=\{busy/);
  assert.match(route, /console\.error\("import failed"/);
  assert.match(route, /application\/x-ndjson/);
  assert.equal(zh.im_progress_n, "已處理 {done}／{total} 筆");
  assert.equal(zh.im_none, "沒有任何資料匯入");
  assert.equal(zh.im_nothing, "沒有可匯入的資料");
  assert.equal(zh.im_run_empty, "匯入");
  assert.equal(zh.im_run, "匯入 {n} 筆");
  assert.equal(zh.im_run_empty.includes("0"), false);
  assert.equal(zh.im_retry, "再試一次");
  assert.match(zh.im_e_phone_name, /\{n\}/);
  assert.match(zh.im_e_phone_name, /\{name\}/);
});

test("active-unit billing counts include imported leases", () => {
  const sandbox = readFileSync(new URL("./sandbox.ts", import.meta.url), "utf8");
  const partners = readFileSync(new URL("./partners.ts", import.meta.url), "utf8");
  assert.match(sandbox, /countActiveUnits[\s\S]*BILLABLE_ACTIVE_LEASE/);
  assert.match(partners, /requestUpgrade[\s\S]*BILLABLE_ACTIVE_LEASE/);
  const billing = readFileSync(new URL("./billing.ts", import.meta.url), "utf8");
  assert.match(billing, /esign_status = 'imported'/);
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

test("confirm preview highlights the blank rent cell and keeps valid rows", () => {
  const rows = validateImportRows([
    lease({ line: 2, rent: "" }),
    lease({ line: 3, unitLabel: "6F", tenantName: "另一租客", tenantPhone: "0912000333", tenantEmail: "b@example.com" }),
  ]);
  assert.equal(rowHasError(rows[0]), true);
  assert.equal(rowHasError(rows[1]), false);
  assert.equal(previewBadColumns(rows[0]).has("rent"), true);
  assert.equal(previewBadColumns(rows[1]).size, 0);
  const rentIssue = rows[0].issues.find((issue) => issue.key === "im_e_req" && issue.vars?.f === "月租");
  assert.ok(rentIssue);
  assert.deepEqual(issuePreviewColumns(rentIssue), ["rent"]);
});

test("bulk import migration is additive and idempotent", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261026130000_bulk_import.sql", import.meta.url), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  assert.match(sql, /20261026130000/);
  const names = readdirSync(new URL("../../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const bulk = names.find((name) => name.includes("bulk_import"));
  assert.equal(bulk, "20261026130000_bulk_import.sql");
  assert.ok(names.includes("20261026120000_email_log.sql"));
  assert.ok(names.includes("20261026100000_country_room_door.sql"));
  assert.ok(bulk && bulk > "20261026120000_email_log.sql");
  assert.match(code, /ADD COLUMN IF NOT EXISTS address_key/);
  assert.match(code, /ADD COLUMN IF NOT EXISTS import_address_key/);
  assert.match(code, /ADD COLUMN IF NOT EXISTS id_number_hash/);
  assert.match(code, /ADD COLUMN IF NOT EXISTS electricity_included/);
  assert.match(code, /ADD VALUE IF NOT EXISTS 'imported'/);
  assert.match(code, /CREATE OR REPLACE FUNCTION/);
  assert.match(code, /IF NOT EXISTS \(/);
  assert.equal(code.match(/SECURITY DEFINER/g)?.length, 1);
  assert.match(code, /FUNCTION public\.condola_sync_unit_address_keys\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
  assert.match(code, /FUNCTION public\.condola_property_address_key\(display text\)\s+RETURNS text\s+LANGUAGE sql\s+IMMUTABLE\s+SET search_path = pg_catalog/);
  assert.match(code, /FUNCTION public\.condola_set_property_address_key\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SET search_path = pg_catalog, public/);
  assert.match(code, /FUNCTION public\.condola_set_unit_import_address_key\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SET search_path = pg_catalog, public/);
  assert.match(code, /REVOKE EXECUTE ON FUNCTION public\.condola_sync_unit_address_keys\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(code, /REVOKE EXECUTE ON FUNCTION public\.condola_set_property_address_key\(\), public\.condola_set_unit_import_address_key\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(code, /REVOKE EXECUTE ON FUNCTION public\.condola_property_address_key\(text\) FROM PUBLIC, anon/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.condola_property_address_key\(text\) TO authenticated, service_role/);
  const keyRevokeAt = code.indexOf("REVOKE EXECUTE ON FUNCTION public.condola_property_address_key(text) FROM PUBLIC, anon");
  const keyGrantAt = code.indexOf("GRANT EXECUTE ON FUNCTION public.condola_property_address_key(text) TO authenticated, service_role");
  assert.ok(keyGrantAt > keyRevokeAt);
  const functions = [
    "public.condola_property_address_key(text)",
    "public.condola_set_property_address_key()",
    "public.condola_set_unit_import_address_key()",
    "public.condola_sync_unit_address_keys()",
  ];
  const execute = new Map(functions.map((fn) => [fn, new Set(["public", "anon", "authenticated", "service_role"])]));
  for (const match of code.matchAll(/\b(REVOKE|GRANT) EXECUTE ON FUNCTION\s+([\s\S]*?)\s+(FROM|TO)\s+([^;]+)/g)) {
    const names = match[2].split(",").map((name) => name.trim());
    const roles = match[4].split(",").map((role) => role.trim().toLowerCase());
    for (const name of names) {
      const held = execute.get(name);
      assert.ok(held, name);
      for (const role of roles) {
        if (match[1] === "REVOKE") held.delete(role);
        else held.add(role);
      }
    }
  }
  for (const fn of functions) {
    const held = execute.get(fn);
    assert.ok(held);
    for (const role of ["public", "anon"]) {
      assert.equal(held.has(role), false, `has_function_privilege('${role}', '${fn}', 'EXECUTE')`);
    }
    assert.equal(
      held.has("authenticated"),
      fn === "public.condola_property_address_key(text)",
      `has_function_privilege('authenticated', '${fn}', 'EXECUTE')`,
    );
  }
  assert.equal(execute.get("public.condola_property_address_key(text)")?.has("service_role"), true);
  assert.match(code, /WHERE p\.id = NEW\.property_id\s+AND p\.org_id = NEW\.org_id/);
  assert.match(code, /WHERE property_id = NEW\.id\s+AND org_id = NEW\.org_id/);
  assert.match(code, /SET address_key = public\.condola_property_address_key\(address_display\)/);
  assert.match(code, /SET import_address_key = coalesce\(p\.address_key, public\.condola_property_address_key\(p\.address_display\)\)/);
  assert.match(code, /DISABLE TRIGGER trg_properties_updated_at/);
  assert.match(code, /ENABLE TRIGGER trg_properties_updated_at/);
  assert.match(code, /DISABLE TRIGGER trg_units_updated_at/);
  assert.match(code, /ENABLE TRIGGER trg_units_updated_at/);
  assert.doesNotMatch(code, /\bDROP\b/i);
  assert.doesNotMatch(code, /\bUNIQUE\b/i);
  assert.doesNotMatch(code, /SET NOT NULL/i);
  assert.doesNotMatch(code, /ADD COLUMN[^;]*\bNOT NULL\b/i);
  assert.doesNotMatch(code, /ADD CONSTRAINT/i);
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
