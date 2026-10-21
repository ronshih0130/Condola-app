import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FlowError, mapDbError } from "../server/errors";
import { expiredAuthCookies } from "../server/sign-out";
import { ERRORS, errorText } from "./errors";
import { makeT } from "./index";

const zh = JSON.parse(readFileSync(new URL("./zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
const en = JSON.parse(readFileSync(new URL("./en.json", import.meta.url), "utf8")) as Record<string, string>;

test("every error key has a translation, and an empty amount uses the amount sentence", () => {
  for (const key of Object.values(ERRORS)) {
    assert.equal(typeof zh[key], "string", key);
    assert.equal(typeof en[key], "string", key);
    assert.notEqual(zh[key], key);
    assert.notEqual(en[key], key);
  }
  assert.equal(zh.i_amount, "請輸入金額（數字，可填 0）");
  assert.equal(zh.i_field_incomplete, "{field}未完成，請確認後再送出。");
  assert.equal(zh.i_lease_failed, "租約沒有儲存成功，請稍後再試；若持續發生請聯絡 service@condola.app");
  assert.equal(zh.i_lease_whole_unit, "此戶為整層出租，請選擇整層而不是房間。");
  assert.match(zh.i_charged_total, /^向租客收取 /);
  assert.equal(zh.i_rooms_hint, "請填寫每間的房號與月租（可新增或刪除房間）");
  assert.equal(zh.i_task1, "任務一：新增一間物件，新增一個物件，依實際情況設定房間（整層或分租皆可），並加入一位屋主。");
  assert.equal(makeT("zh-TW")("i_field_incomplete", { field: zh.i_address }), "地址未完成，請確認後再送出。");
  for (const key of ["i_footer", "i_positioning", "i_pending_reports", "i_money_note"]) {
    assert.equal(zh[key].includes("房客"), false, key);
    assert.equal(zh[key].includes("租客"), true, key);
  }
  assert.equal(errorText(makeT("zh-TW"), "errors.amount"), "請輸入金額（數字，可填 0）");
  assert.equal(errorText(makeT("zh-TW"), "errors.leaseFailed"), zh.i_lease_failed);
  assert.equal(errorText(makeT("zh-TW"), "errors.notAKey"), "沒有完成。請檢查欄位後再試一次。");
  const mapped = mapDbError(new Error('invalid input syntax for type numeric: "NaN"'));
  assert.ok(mapped instanceof FlowError);
  assert.equal(mapped.key, "errors.amount");
  const guard = mapDbError(new Error("unit 3F is rented as whole_unit; switch it to by_room before leasing a room"));
  assert.ok(guard instanceof FlowError);
  assert.equal(guard.key, "errors.wholeUnit");
});

test("confirmation mail uses the locked button and body", () => {
  const html = readFileSync(new URL("../../supabase/templates/confirmation.html", import.meta.url), "utf8");
  const patch = readFileSync(new URL("../../supabase/templates/confirmation.patch.json", import.meta.url), "utf8");
  for (const file of [html, patch]) {
    assert.match(file, /確認電子郵件/);
    assert.match(file, /請點下方按鈕確認您的電子郵件，完成租多啦帳號註冊。/);
    assert.match(file, /\{\{ \.SiteURL \}\}\/signup\/confirm\?token_hash=\{\{ \.TokenHash \}\}&type=signup/);
    assert.equal(file.includes("確認 email"), false);
  }
});

test("sign-out expires every auth cookie variant and the wizard keeps amount errors inline", () => {
  const lines = expiredAuthCookies(["sb-example-auth-token"]);
  assert.ok(lines.some((line) => line.startsWith("condola_session=") && line.includes("Domain=.condola.app") && line.includes("Secure")));
  assert.ok(lines.some((line) => line.startsWith("sb-example-auth-token=") && line.includes("Domain=staging.condola.app")));
  assert.ok(lines.some((line) => line.startsWith("condola_org=") && line.includes("Max-Age=0")));
  const wizard = readFileSync(new URL("../components/lease-wizard.tsx", import.meta.url), "utf8");
  assert.match(wizard, /data-testid="rent-error"/);
  assert.match(wizard, /i_field_incomplete/);
  assert.match(wizard, /split === "sub_meter" && bill\.trim\(\) === ""/);
  assert.doesNotMatch(wizard, /t\("i_amount"\)/);
  assert.match(wizard, /useActionState/);
  const property = readFileSync(new URL("../components/property-wizard.tsx", import.meta.url), "utf8");
  assert.match(property, /rentalMode === "whole_unit" \? null : rooms\.map/);
  assert.match(property, /data-testid="add-room"/);
  assert.match(property, /type="button"/);
  assert.match(property, /submitter\.dataset\.testid !== "submit-property"/);
  assert.match(property, /event\.key !== "Enter"/);
  assert.match(property, /useActionState/);
  assert.match(property, /i_field_incomplete/);
  assert.match(property, /data-testid="property-address-error"/);
  assert.match(property, /split === "sub" && bill\.trim\(\) === ""/);
  const leases = readFileSync(new URL("../app/m/leases/page.tsx", import.meta.url), "utf8");
  assert.match(leases, /row\.electricity === "even"[\s\S]*i_split_even/);
  assert.match(leases, /row\.electricity === "sub_meter"[\s\S]*i_split_sub/);
  assert.doesNotMatch(leases, /i_elec_shared"\) : row\.electricity/);
  const signIn = readFileSync(new URL("../server/auth-actions.ts", import.meta.url), "utf8");
  assert.match(signIn, /clearStoredEnvChoice\(jar\)/);
  assert.doesNotMatch(signIn, /ENV_COOKIE,\s*"sandbox"/);
  const firm = readFileSync(new URL("../components/firm-steps.tsx", import.meta.url), "utf8");
  assert.match(firm, /noValidate/);
  assert.match(firm, /data-testid="firm-contact-error"/);
  assert.match(firm, /i_field_incomplete/);
  assert.doesNotMatch(firm, /\srequired(?:\s|=|{|>)/);
  const envRoute = readFileSync(new URL("../app/api/env/route.ts", import.meta.url), "utf8");
  assert.match(envRoute, /set === "live"/);
  assert.match(envRoute, /ENV_COOKIE_MAX_AGE/);
  assert.match(envRoute, /jar\.set\(ENV_COOKIE, set,/);
});
