import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJobTypeLineItem,
  computeMaterialLaborSplitTotals,
  DEFAULT_JOB_TYPES,
  getJobTypeByCode,
  prefixItemNameWithJobType,
  validateCompletionPhotos,
  validateJobTypeFields,
  validatePhasePhotoCounts,
  validatePricingMode,
} from "./job-types-rules";

test("DEFAULT_JOB_TYPES seeds all 10 job types from job_types_v1 §2", () => {
  assert.equal(DEFAULT_JOB_TYPES.length, 10);
  const codes = DEFAULT_JOB_TYPES.map((j) => j.code);
  assert.deepEqual(codes, [
    "cleaning",
    "plumbing",
    "painting",
    "aircon",
    "moving",
    "pest_control",
    "locksmith",
    "masonry",
    "appliance_repair",
    "leak_repair",
  ]);
});

test("validateJobTypeFields enforces required fields and numeric constraints", () => {
  const cleaning = getJobTypeByCode("cleaning");
  assert.ok(cleaning);

  const missing = validateJobTypeFields(cleaning.required_fields, {
    cleaning_scope: "   ",
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingKeys, ["cleaning_scope", "area_ping_or_rooms"]);

  const valid = validateJobTypeFields(cleaning.required_fields, {
    cleaning_scope: "室內與陽台",
    area_ping_or_rooms: 15,
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.missingKeys, []);

  const painting = getJobTypeByCode("painting");
  assert.ok(painting);
  const badNumber = validateJobTypeFields(painting.required_fields, {
    area_ping: -3,
    wall_or_room_location: "主臥牆面",
  });
  assert.equal(badNumber.ok, false);
  assert.deepEqual(badNumber.invalidKeys, ["area_ping"]);
});

test("validatePhasePhotoCounts checks min/max per phase", () => {
  const cleaning = getJobTypeByCode("cleaning");
  assert.ok(cleaning);

  const validCleaning = validatePhasePhotoCounts(cleaning.photo_rules, {
    before: 1,
    during: 0,
    after: 2,
  });
  assert.equal(validCleaning.ok, true);

  const duringNotApplicable = validatePhasePhotoCounts(cleaning.photo_rules, {
    before: 1,
    during: 1,
    after: 1,
  });
  assert.equal(duringNotApplicable.ok, false);
  assert.ok(duringNotApplicable.violations.includes("during"));

  const tooManyBefore = validatePhasePhotoCounts(cleaning.photo_rules, {
    before: 6,
    during: 0,
    after: 1,
  });
  assert.equal(tooManyBefore.ok, false);
  assert.ok(tooManyBefore.violations.includes("before"));
});

test("validateCompletionPhotos enforces during photos when required and allows missing after-photos only with missing_photo_reason (flow_spec §9 over J03)", () => {
  const masonry = getJobTypeByCode("masonry");
  assert.ok(masonry);

  const missingDuring = validateCompletionPhotos(masonry.photo_rules, {
    before: 1,
    during: 0,
    after: 1,
  });
  assert.equal(missingDuring.ok, false);
  assert.ok(missingDuring.violations.includes("during"));

  const missingAfterNoReason = validateCompletionPhotos(masonry.photo_rules, {
    before: 1,
    during: 1,
    after: 0,
    missing_photo_reason: "   ",
  });
  assert.equal(missingAfterNoReason.ok, false);
  assert.ok(missingAfterNoReason.violations.includes("after"));

  const missingAfterWithReason = validateCompletionPhotos(masonry.photo_rules, {
    before: 1,
    during: 1,
    after: 0,
    missing_photo_reason: "現場停電無法拍攝完工後照片",
  });
  assert.equal(missingAfterWithReason.ok, true);
});

test("validatePricingMode accepts lump_sum and job-type-configured modes", () => {
  const plumbing = getJobTypeByCode("plumbing");
  assert.ok(plumbing);

  assert.equal(validatePricingMode(plumbing, "per_hour"), true);
  assert.equal(validatePricingMode(plumbing, "material_and_labor"), true);
  assert.equal(validatePricingMode(plumbing, "lump_sum"), true);
  assert.equal(validatePricingMode(plumbing, "per_ping"), false);
});

test("prefixItemNameWithJobType prefixes item name with job_type zh name idempotently", () => {
  assert.equal(
    prefixItemNameWithJobType("水電", "更換浴室水龍頭"),
    "水電 - 更換浴室水龍頭",
  );
  assert.equal(
    prefixItemNameWithJobType("水電", "水電 - 更換浴室水龍頭"),
    "水電 - 更換浴室水龍頭",
  );
});

test("buildJobTypeLineItem enforces amount = quantity * unit_price and lump_sum quantity=1 unit='式'", () => {
  const lumpSum = buildJobTypeLineItem({
    jobTypeNameZh: "清潔",
    name: "退租全室清潔",
    pricingMode: "lump_sum",
    quantity: 5,
    unit: "坪",
    unit_price_minor: 3500,
    amount_minor: 3500,
  });
  assert.equal(lumpSum.ok, true);
  if (lumpSum.ok) {
    assert.equal(lumpSum.item.name, "清潔 - 退租全室清潔");
    assert.equal(lumpSum.item.quantity, 1);
    assert.equal(lumpSum.item.unit, "式");
    assert.equal(lumpSum.item.unit_price_minor, 3500);
    assert.equal(lumpSum.item.amount_minor, 3500);
  }

  const perPing = buildJobTypeLineItem({
    jobTypeNameZh: "油漆",
    name: "主臥粉刷",
    pricingMode: "per_ping",
    quantity: 6,
    unit_price_minor: 800,
  });
  assert.equal(perPing.ok, true);
  if (perPing.ok) {
    assert.equal(perPing.item.name, "油漆 - 主臥粉刷");
    assert.equal(perPing.item.quantity, 6);
    assert.equal(perPing.item.unit, "坪");
    assert.equal(perPing.item.unit_price_minor, 800);
    assert.equal(perPing.item.amount_minor, 4800);
  }

  const mismatchedAmount = buildJobTypeLineItem({
    jobTypeNameZh: "水電",
    name: "配電檢修",
    pricingMode: "per_hour",
    quantity: 2,
    unit_price_minor: 1000,
    amount_minor: 2500,
  });
  assert.equal(mismatchedAmount.ok, false);

  const nonInteger = buildJobTypeLineItem({
    jobTypeNameZh: "水電",
    name: "配電檢修",
    pricingMode: "per_hour",
    quantity: 2,
    unit_price_minor: 1000.5,
  });
  assert.equal(nonInteger.ok, false);
});

test("computeMaterialLaborSplitTotals calculates material, labor, service, and grand totals", () => {
  const materialItem = buildJobTypeLineItem({
    jobTypeNameZh: "水電",
    name: "材料",
    pricingMode: "material_and_labor",
    category: "material",
    quantity: 1,
    unit: "項",
    unit_price_minor: 1200,
  });
  const laborItem = buildJobTypeLineItem({
    jobTypeNameZh: "水電",
    name: "工資",
    pricingMode: "material_and_labor",
    category: "labor",
    quantity: 2,
    unit: "小時",
    unit_price_minor: 900,
  });
  assert.ok(materialItem.ok && laborItem.ok);

  const split = computeMaterialLaborSplitTotals([
    materialItem.item,
    laborItem.item,
  ]);
  assert.equal(split.ok, true);
  if (split.ok) {
    assert.equal(split.material_total_minor, 1200);
    assert.equal(split.labor_total_minor, 1800);
    assert.equal(split.service_total_minor, 0);
    assert.equal(split.total_minor, 3000);
  }
});
