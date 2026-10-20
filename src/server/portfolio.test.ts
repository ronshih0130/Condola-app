import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PortfolioError, parsePortfolioCsv } from "./portfolio";

const sample = readFileSync(new URL("./fixtures/portfolio-sample.csv", import.meta.url), "utf8");

test("sample CSV becomes buildings, 屋主, and room or whole-unit spaces", () => {
  const plan = parsePortfolioCsv(sample);
  assert.equal(plan.rows.length, 38);
  assert.deepEqual(
    plan.owners.map((owner) => owner.email),
    ["owner1.demo@example.com", "owner2.demo@example.com", "owner3.demo@example.com"],
  );
  assert.deepEqual(
    plan.properties.map((property) => [property.name, property.spaces.length, property.defaultKind]),
    [
      ["中壢範例分租公寓", 16, "room"],
      ["桃園區範例學舍", 15, "room"],
      ["青埔範例住宅大樓", 7, "whole_unit"],
    ],
  );

  const room = plan.rows[0];
  assert.equal(room.kind, "room");
  assert.equal(room.floor, "2F");
  assert.equal(room.roomLabel, "A");
  assert.equal(room.roomType, "suite");
  assert.equal(room.areaPing, 8);
  assert.equal(room.rentMinor, 1_050_000);
  assert.equal(room.tenantName, "測測二一（範例）");
  assert.equal(room.tenantPhone, "0900-000-101");
  assert.equal(room.tenantEmail, "tenant1.demo@example.com");
  assert.equal(room.leaseStart, "2026-03-01");
  assert.equal(room.leaseEnd, "2027-02-28");
  assert.equal(room.depositMinor, 2_100_000);
  assert.equal(room.rentDueDay, 5);
  assert.equal(room.electricityMethod, "submeter");
  assert.equal(room.ratePerKwh, 4);
  assert.equal(room.openingArrearsMinor, 0);
  assert.equal(room.notes, "範例資料");
  assert.equal(plan.rows[2].roomType, "shared_bath");
  assert.equal(plan.rows[4].tenantName, null);
  assert.equal(plan.rows[4].depositMinor, null);

  const whole = plan.properties[2].spaces[0];
  assert.equal(whole.kind, "whole_unit");
  assert.equal(whole.floor, "3F");
  assert.equal(whole.roomLabel, null);
  assert.equal(whole.roomType, null);
  assert.equal(whole.areaPing, 25);
  assert.equal(whole.rentMinor, 1_890_000);
  assert.equal(whole.electricityMethod, "tenant_direct");
  assert.equal(whole.ratePerKwh, null);
  assert.equal(whole.taipowerKwh, null);
  assert.equal(whole.taipowerAmountMinor, null);
});

test("portfolio CSV rejects a room without a number and a whole unit with one", () => {
  const header = sample.split(/\r?\n/)[0];
  assert.throws(
    () => parsePortfolioCsv(`${header}\n大樓,地址一號,屋主,owner@example.com,分租,2F,,套房,8,1000,,,,,,,,,分表,4,,,,,,,,`),
    (error: unknown) => error instanceof PortfolioError && /房號/.test(error.message),
  );
  assert.throws(
    () => parsePortfolioCsv(`${header}\n大樓,地址一號,屋主,owner@example.com,整層,2F,A,,8,1000,,,,,,,,,租客自繳,,,,,,,,,`),
    (error: unknown) => error instanceof PortfolioError && /整層/.test(error.message),
  );
});

test("the Traditional Chinese UI does not call an owner 房東", () => {
  const zh = readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8");
  assert.equal(zh.includes("房東"), false);
  assert.equal(zh.includes("屋主"), true);
});
