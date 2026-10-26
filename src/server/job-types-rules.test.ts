import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJobTypeLineItem,
  computeMaterialLaborSplitTotals,
  DEFAULT_JOB_TYPES,
  deriveTicketDocumentItems,
  getJobTypeByCode,
  prefixItemNameWithJobType,
  validateCompletionPhotos,
  validateJobTypeFields,
  validatePhasePhotoCounts,
  validatePricingMode,
  type JobTypeLineItem,
  type PricingMode,
} from "./job-types-rules";

test("DEFAULT_JOB_TYPES seeds all 10 job types from job_types_v1 §2", () => {
  assert.deepEqual(DEFAULT_JOB_TYPES.map((j) => j.code), [
    "cleaning", "plumbing", "painting", "aircon", "moving",
    "pest_control", "locksmith", "masonry", "appliance_repair", "leak_repair",
  ]);
});

test("validateJobTypeFields enforces required fields and numeric constraints", () => {
  const cleaning = getJobTypeByCode("cleaning");
  assert.ok(cleaning);
  const missing = validateJobTypeFields(cleaning.required_fields, { cleaning_scope: "   " });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingKeys, ["cleaning_scope", "area_ping_or_rooms"]);
  assert.equal(validateJobTypeFields(cleaning.required_fields, {
    cleaning_scope: "室內與陽台", area_ping_or_rooms: 15,
  }).ok, true);
  const painting = getJobTypeByCode("painting");
  assert.ok(painting);
  assert.deepEqual(validateJobTypeFields(painting.required_fields, {
    area_ping: -3, wall_or_room_location: "主臥牆面",
  }).invalidKeys, ["area_ping"]);
});

test("validatePhasePhotoCounts checks min/max per phase", () => {
  const cleaning = getJobTypeByCode("cleaning");
  assert.ok(cleaning);
  assert.equal(validatePhasePhotoCounts(cleaning.photo_rules, {
    before: 1, during: 0, after: 2,
  }).ok, true);
  assert.ok(validatePhasePhotoCounts(cleaning.photo_rules, {
    before: 1, during: 1, after: 1,
  }).violations.includes("during"));
  assert.ok(validatePhasePhotoCounts(cleaning.photo_rules, {
    before: 6, during: 0, after: 1,
  }).violations.includes("before"));
});

test("completion photos enforce during photos and allow an after-photo reason", () => {
  const masonry = getJobTypeByCode("masonry");
  assert.ok(masonry);
  assert.ok(validateCompletionPhotos(masonry.photo_rules, {
    before: 1, during: 0, after: 1,
  }).violations.includes("during"));
  assert.ok(validateCompletionPhotos(masonry.photo_rules, {
    before: 1, during: 1, after: 0, missing_photo_reason: "   ",
  }).violations.includes("after"));
  assert.equal(validateCompletionPhotos(masonry.photo_rules, {
    before: 1, during: 1, after: 0, missing_photo_reason: "現場停電",
  }).ok, true);
});

test("validatePricingMode accepts lump_sum and configured modes", () => {
  const plumbing = getJobTypeByCode("plumbing");
  assert.ok(plumbing);
  for (const mode of ["per_hour", "material_and_labor", "lump_sum"]) {
    assert.equal(validatePricingMode(plumbing, mode), true);
  }
  assert.equal(validatePricingMode(plumbing, "per_ping"), false);
});

test("item name prefix is idempotent", () => {
  assert.equal(prefixItemNameWithJobType("水電", "檢修"), "水電 - 檢修");
  assert.equal(prefixItemNameWithJobType("水電", "水電 - 檢修"), "水電 - 檢修");
});

test("explicit row amounts win and unit prices are rounded display values", () => {
  for (const [quantity, amount, expected] of [[3, 100, 33], [3, 101, 34], [3, 1, 0]]) {
    const result = buildJobTypeLineItem({
      jobTypeNameZh: "水電",
      name: "檢修",
      pricingMode: "per_hour",
      quantity,
      unit_price_minor: 999,
      amount_minor: amount,
    });
    assert.ok(result.ok);
    assert.equal(result.item.amount_minor, amount);
    assert.equal(result.item.unit_price_minor, expected);
    assert.equal(result.item.quantity, quantity);
    assert.equal(result.item.unit, "小時");
    const totals = computeMaterialLaborSplitTotals([result.item]);
    assert.ok(totals.ok);
    assert.equal(totals.total_minor, amount);
  }
  const lump = buildJobTypeLineItem({
    jobTypeNameZh: "清潔", name: "清潔", pricingMode: "lump_sum",
    quantity: 5, unit: "坪", amount_minor: 100,
  });
  assert.ok(lump.ok);
  assert.equal(lump.item.quantity, 1);
  assert.equal(lump.item.unit, "式");
  assert.equal(lump.item.unit_price_minor, 100);
});

test("legacy unit-price-only input is supported with safe integer validation", () => {
  const legacy = buildJobTypeLineItem({
    jobTypeNameZh: "油漆", name: "粉刷", pricingMode: "per_ping",
    quantity: 6, unit_price_minor: 800,
  });
  assert.ok(legacy.ok);
  assert.equal(legacy.item.amount_minor, 4800);
  assert.equal(legacy.item.unit, "坪");
  for (const amount of [0, -1, 0.5, NaN, Infinity, 2 ** 53]) {
    assert.equal(buildJobTypeLineItem({
      jobTypeNameZh: "", name: "服務", pricingMode: "per_visit", amount_minor: amount,
    }).ok, false);
  }
  assert.equal(buildJobTypeLineItem({
    jobTypeNameZh: "", name: "服務", pricingMode: "per_hour",
    quantity: 2, unit_price_minor: 1000.5,
  }).ok, false);
});

const item: JobTypeLineItem = {
  name: "檢修", quantity: 99, unit: "錯誤單位",
  unit_price_minor: 999, amount_minor: 100, category: "service",
};

test("persisted pricing overrides caller quantity/unit in every pricing mode", () => {
  const cases: [PricingMode, string][] = [
    ["lump_sum", "式"], ["per_visit", "次"], ["per_ping", "坪"],
    ["per_hour", "小時"], ["per_item", "件"],
    ["material_and_labor", "項"], ["quote_then_approve", "式"],
  ];
  for (const [mode, unit] of cases) {
    const [derived] = deriveTicketDocumentItems([item], {
      pricing: { mode, quantity: 3 },
    });
    assert.equal(derived.quantity, mode === "lump_sum" ? 1 : 3);
    assert.equal(derived.unit, unit);
    assert.equal(derived.amount_minor, 100);
    assert.equal(derived.unit_price_minor, mode === "lump_sum" ? 100 : 33);
  }
  assert.equal(item.quantity, 99);
});

test("persisted pricing supports ordered material/labor rows and custom units", () => {
  const derived = deriveTicketDocumentItems(
    [{ ...item, category: "material" }, { ...item, category: "labor", amount_minor: 101 }],
    { pricing: { mode: "material_and_labor", items: [
      { quantity: 3, unit: "件" }, { quantity: 2, unit: "小時" },
    ] } },
  );
  assert.deepEqual(derived.map((row) => [row.quantity, row.unit, row.unit_price_minor]), [
    [3, "件", 33], [2, "小時", 51],
  ]);
  const split = computeMaterialLaborSplitTotals(derived);
  assert.ok(split.ok);
  assert.equal(split.material_total_minor, 100);
  assert.equal(split.labor_total_minor, 101);
  assert.equal(split.total_minor, 201);
});

test("absent pricing preserves legacy quantities; malformed persisted pricing fails closed", () => {
  const [legacy] = deriveTicketDocumentItems([item], {});
  assert.equal(legacy.quantity, 99);
  assert.equal(legacy.unit_price_minor, 1);
  for (const pricing of [
    [], "bad", {}, { mode: "unknown", quantity: 3 },
    { mode: "per_hour" }, { mode: "per_hour", quantity: 0 },
    { mode: "per_hour", quantity: 1.5 }, { mode: "per_hour", quantity: "3" },
    { mode: "per_hour", quantity: 3, unit: "" },
    { mode: "per_hour", items: [] },
  ]) {
    assert.throws(() => deriveTicketDocumentItems([item], { pricing }), /invalid_ticket_pricing/);
  }
});

test("split totals sum row amounts and reject unsafe totals", () => {
  const rows = [
    { ...item, quantity: 3, unit_price_minor: 33, category: "material" as const },
    { ...item, quantity: 3, unit_price_minor: 33, category: "labor" as const },
    { ...item, quantity: 3, unit_price_minor: 33 },
  ];
  assert.deepEqual(computeMaterialLaborSplitTotals(rows), {
    ok: true, material_total_minor: 100, labor_total_minor: 100,
    service_total_minor: 100, total_minor: 300,
  });
  const large = {
    ...item, quantity: 1, amount_minor: Number.MAX_SAFE_INTEGER,
    unit_price_minor: Number.MAX_SAFE_INTEGER,
  };
  assert.equal(computeMaterialLaborSplitTotals([large, large]).ok, false);
  assert.equal(computeMaterialLaborSplitTotals([]).ok, false);
});
