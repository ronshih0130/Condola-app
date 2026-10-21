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
  assert.equal(errorText(makeT("zh-TW"), "errors.amount"), "請輸入金額（數字，可填 0）");
  assert.equal(errorText(makeT("zh-TW"), "errors.notAKey"), "沒有完成。請檢查欄位後再試一次。");
  const mapped = mapDbError(new Error('invalid input syntax for type numeric: "NaN"'));
  assert.ok(mapped instanceof FlowError);
  assert.equal(mapped.key, "errors.amount");
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
  assert.match(wizard, /t\("i_amount"\)/);
  assert.match(wizard, /useActionState/);
  const property = readFileSync(new URL("../components/property-wizard.tsx", import.meta.url), "utf8");
  assert.match(property, /rentalMode === "whole_unit" \? null : \[0, 1, 2\]/);
  const firm = readFileSync(new URL("../components/firm-steps.tsx", import.meta.url), "utf8");
  assert.match(firm, /noValidate/);
  assert.match(firm, /data-testid="firm-contact-error"/);
  assert.doesNotMatch(firm, /\srequired(?:\s|=|{|>)/);
});
