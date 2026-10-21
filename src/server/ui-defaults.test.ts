import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countryByCode, withOrgCountry } from "@/countries";
import { exampleRoomCharges } from "@/electric-example";
import { typedAddressDisplay, typedStreet } from "@/property-address";
import { phoneInputInvalid } from "./lease-rules";

const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

test("example electricity rounds per room and the last room absorbs the remainder", () => {
  const even = exampleRoomCharges(5, [30, 50], true);
  assert.deepEqual(even?.lines, [150, 250]);
  assert.equal(even?.total, 400);
  const odd = exampleRoomCharges(5.4, [1, 1], true);
  assert.deepEqual(odd?.lines, [5, 6]);
  assert.equal(odd?.total, 11);
  assert.equal(odd && odd.lines.reduce((sum, line) => sum + line, 0), odd?.total);
});

test("country defaults stay on Taiwan and do not overwrite an explicit setting", () => {
  assert.equal(countryByCode(null).code, "TW");
  assert.equal(countryByCode("TW").currency, "TWD");
  assert.equal(countryByCode("TW").callingCode, "+886");
  assert.equal(countryByCode("US").code, "TW");
  assert.deepEqual(withOrgCountry({ plan: "free" }, "TW"), { plan: "free", country: "TW" });
  assert.deepEqual(withOrgCountry({ country: "TW", plan: "free" }, "TW").country, "TW");
});

test("a partial Taiwan mobile is invalid and an empty phone is allowed", () => {
  assert.equal(phoneInputInvalid("", "+886"), false);
  assert.equal(phoneInputInvalid("0912", "+886"), true);
  assert.equal(phoneInputInvalid("0912 345 678", "+886"), false);
});

test("staff copy names the payments queue 待確認繳款", () => {
  assert.equal(zh.i_nav_inbox, "待確認繳款");
  assert.equal(zh.i_nav_inbox.includes("收款"), false);
  assert.equal(zh.i_example_calc, "範例試算");
  assert.equal(zh.i_sandbox_back, "回到正式公司");
  assert.equal(zh.i_dash_first, "建立第一個物件");
  assert.equal(zh.i_dash_sample, "先看範例");
  assert.equal(zh.i_dash_free, "前 4 戶永遠免費・第 5 戶起每戶每月 NT$30 起・付費方案前 3 個月免費");
  assert.equal(zh.i_outstanding, "未繳清租客");
  assert.equal(zh.i_none_pending, "沒有待確認的繳款。");
  assert.equal(zh.i_sandbox_plan, "範例公司：資料僅供練習，不會出現在正式公司。範例公司不會實際寄出任何通知。");
  assert.equal(zh.i_whole_home_hint, "整層住家預設僅一間，代表整戶出租。");
  assert.equal(zh.i_sec_property, "物件資料");
  assert.equal(zh.i_sec_rooms, "戶別與房間");
  assert.equal(zh.i_sec_meter, "公用電表與分攤");
  assert.equal(typedStreet("府後街", "38號"), "府後街38號");
  assert.equal(typedAddressDisplay("台北市", "中正區", typedStreet("府後街", "38號")), "台北市中正區府後街38號");
  assert.equal(zh.i_created_prop.includes("物件已建立"), true);
  for (const key of ["i_example_calc", "i_dash_import", "i_sandbox_banner", "i_elec_monthly_note", "i_nav_inbox"]) {
    assert.equal(zh[key].includes("收款"), false, key);
  }
});
