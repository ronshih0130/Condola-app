import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FlowError } from "./errors";
import {
  resolveJurisdictionRule,
  resolveLocalizationContext,
  type DbClient,
} from "./localization";

const orgId = "10000000-0000-4000-8000-000000000001";
const propertyId = "20000000-0000-4000-8000-000000000001";
const source = readFileSync(new URL("./localization.ts", import.meta.url), "utf8");
const base = {
  property_id: null,
  property_currency: null,
  property_timezone: null,
  org_currency: "TWD",
  org_locale: "zh-TW",
  org_timezone: "Asia/Taipei",
  jurisdiction_currency: "USD",
  jurisdiction_locale: "en-US",
  jurisdiction_timezone: "America/New_York",
  jurisdiction_code: "TW",
};

function fakeDb(...responses: object[][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const rows = responses.shift();
      assert.ok(rows, "unexpected database query");
      return { rows };
    },
  } as unknown as DbClient;
  return { db, calls };
}

function hasKey(key: string) {
  return (error: unknown) => error instanceof FlowError && error.key === key;
}

test("org defaults win jurisdiction defaults and currency scales come from currencies", async () => {
  for (const currency of ["TWD", "USD"]) {
    const usd = currency === "USD";
    const row = {
      ...base, org_currency: currency,
      org_locale: usd ? "en-US" : "zh-TW",
      org_timezone: usd ? "America/New_York" : "Asia/Taipei",
      jurisdiction_code: usd ? "US" : "TW",
    };
    const { db, calls } = fakeDb([row], [{ minor_unit: 2, display_decimals: usd ? 2 : 0 }]);
    assert.deepEqual(await resolveLocalizationContext(db, orgId), {
      currency, minorUnit: 2, displayDecimals: usd ? 2 : 0,
      locale: row.org_locale, timezone: row.org_timezone,
      jurisdictionCode: row.jurisdiction_code,
    });
    assert.deepEqual(calls.map(call => call.params), [[orgId, null], [currency]]);
    assert.match(calls[0].sql, /WHERE o\.id = \$1::uuid/);
    assert.match(calls[1].sql, /FROM currencies WHERE code = \$1/);
  }
});

test("storage exponent stays independent of display precision", async () => {
  const { db } = fakeDb([base], [{ minor_unit: 2, display_decimals: 0 }]);
  const context = await resolveLocalizationContext(db, orgId);
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency", currency: context.currency,
    minimumFractionDigits: context.displayDecimals,
    maximumFractionDigits: context.displayDecimals,
  });
  for (const [minor, major, rendered] of [
    [280000, 2800, "NT$2,800"], [5000, 50, "NT$50"], [0, 0, "NT$0"],
  ] as const) {
    assert.equal(minor / 10 ** context.minorUnit, major);
    assert.equal(formatter.format(major), rendered);
  }
  assert.equal(formatter.format(280000 / 10 ** context.displayDecimals), "NT$280,000");
  const usd = fakeDb([{ ...base, org_currency: "USD" }], [{ minor_unit: 2, display_decimals: 2 }]);
  const usdContext = await resolveLocalizationContext(usd.db, orgId);
  assert.equal((12345 / 10 ** usdContext.minorUnit).toFixed(usdContext.displayDecimals), "123.45");
});

test("property currency/timezone win; locale remains org-owned; jurisdiction follows property", async () => {
  const { db, calls } = fakeDb([{
    ...base, property_id: propertyId, property_currency: "USD",
    property_timezone: "America/Los_Angeles", jurisdiction_code: "US-CA",
  }], [{ minor_unit: 2, display_decimals: 2 }]);
  assert.deepEqual(await resolveLocalizationContext(db, orgId, { propertyId }), {
    currency: "USD", minorUnit: 2, displayDecimals: 2, locale: "zh-TW",
    timezone: "America/Los_Angeles", jurisdictionCode: "US-CA",
  });
  assert.deepEqual(calls[0].params, [orgId, propertyId]);
  assert.match(calls[0].sql, /p\.org_id = o\.id AND p\.id = \$2::uuid/);
  assert.match(calls[0].sql, /COALESCE\(p\.jurisdiction_id, o\.jurisdiction_id\)/);
  assert.deepEqual(calls[1].params, ["USD"]);
});

test("null property overrides fall through to org defaults", async () => {
  const { db } = fakeDb([{ ...base, property_id: propertyId }], [{ minor_unit: 2, display_decimals: 0 }]);
  const context = await resolveLocalizationContext(db, orgId, { propertyId });
  assert.equal(context.currency, "TWD");
  assert.equal(context.timezone, "Asia/Taipei");
});

test("jurisdiction defaults are last; no jurisdiction is also valid with org defaults", async () => {
  const fallback = fakeDb([{
    ...base, org_currency: null, org_locale: null, org_timezone: null,
  }], [{ minor_unit: 2, display_decimals: 2 }]);
  assert.deepEqual(await resolveLocalizationContext(fallback.db, orgId), {
    currency: "USD", minorUnit: 2, displayDecimals: 2,
    locale: "en-US", timezone: "America/New_York", jurisdictionCode: "TW",
  });
  const noJurisdiction = fakeDb([{
    ...base, jurisdiction_code: null, jurisdiction_currency: null,
    jurisdiction_locale: null, jurisdiction_timezone: null,
  }], [{ minor_unit: 2, display_decimals: 0 }]);
  assert.equal((await resolveLocalizationContext(noJurisdiction.db, orgId)).jurisdictionCode, null);
});

test("zero storage/display exponents are retained from reference data", async () => {
  const { db } = fakeDb([{ ...base, org_currency: "JPY" }], [{ minor_unit: 0, display_decimals: 0 }]);
  const context = await resolveLocalizationContext(db, orgId);
  assert.equal(context.minorUnit, 0);
  assert.equal(context.displayDecimals, 0);
});

test("missing org and missing or foreign property fail without a currency lookup", async () => {
  for (const rows of [[], [base]]) {
    const { db, calls } = fakeDb(rows);
    await assert.rejects(resolveLocalizationContext(db, orgId, { propertyId }), hasKey("errors.notFound"));
    assert.equal(calls.length, 1);
  }
  const { db } = fakeDb([]);
  await assert.rejects(resolveLocalizationContext(db, orgId), hasKey("errors.notFound"));
});

test("incomplete defaults and missing currency rows fail without invented defaults", async () => {
  for (const [orgField, jurisdictionField] of [
    ["org_currency", "jurisdiction_currency"],
    ["org_locale", "jurisdiction_locale"],
    ["org_timezone", "jurisdiction_timezone"],
  ]) {
    const { db, calls } = fakeDb([{ ...base, [orgField]: null, [jurisdictionField]: null }]);
    await assert.rejects(resolveLocalizationContext(db, orgId), hasKey("errors.generic"));
    assert.equal(calls.length, 1);
  }
  const { db } = fakeDb([base], []);
  await assert.rejects(resolveLocalizationContext(db, orgId), hasKey("errors.generic"));
});

test("invalid org scopes fail before any resolver query", async () => {
  for (const invalid of ["", " ", null, undefined, 42, {}]) {
    const { db, calls } = fakeDb();
    await assert.rejects(resolveLocalizationContext(db, invalid as string), hasKey("errors.forbidden"));
    await assert.rejects(resolveJurisdictionRule(db, invalid as string, "US", "test.rule", "2026-01-01"),
      hasKey("errors.forbidden"));
    assert.equal(calls.length, 0);
  }
  const { db, calls } = fakeDb();
  await assert.rejects(resolveLocalizationContext(db, orgId, { propertyId: "" }), hasKey("errors.notFound"));
  assert.equal(calls.length, 0);
});

test("rule query binds org/key/date and retains isolation, precedence and half-open windows", async () => {
  const rule = { value: { max_months: 2 }, enforcement: "warn", legalStatus: "unverified" };
  const { db, calls } = fakeDb([rule]);
  assert.deepEqual(await resolveJurisdictionRule(db, orgId, "US-CA", "deposit.max_months", "2026-01-01"), rule);
  assert.deepEqual(calls[0].params, [orgId, "US-CA", "deposit.max_months", "2026-01-01"]);
  const sql = calls[0].sql;
  assert.match(sql, /\(r\.org_id = \$1::uuid OR r\.org_id IS NULL\)/);
  assert.match(sql, /WHERE code = \$2/);
  assert.match(sql, /r\.rule_key = \$3/);
  assert.match(sql, /r\.effective_from <= \$4::date/);
  assert.match(sql, /\(r\.effective_to IS NULL OR r\.effective_to > \$4::date\)/);
  assert.match(sql, /ORDER BY \(r\.org_id IS NOT NULL\) DESC, c\.depth, r\.effective_from DESC/);
  assert.match(sql, /JOIN chain c ON j\.id = c\.parent_id/);
  assert.match(sql, /WHERE NOT \(j\.id = ANY\(c\.path\)\)/);
  const absent = fakeDb([]);
  assert.equal(await resolveJurisdictionRule(absent.db, orgId, "US", "missing", "2026-01-01"), null);
});

test("resolver source contains no Taiwan literals or global threshold defaults", () => {
  assert.doesNotMatch(source, /["'`](?:TWD|Asia\/Taipei|zh-TW)["'`]|\b5_?000\b/);
});
