import assert from "node:assert/strict";
import { test } from "node:test";
import { esignCopy } from "./copy";
import { EMAIL_IDENTITY_LABEL } from "./rules";

const banned = [
  "收租", "收款", "欠租", "已收", "入帳", "房東", "代收", "轉付",
  "統一編號", "含稅", "本公司", "事務所", "已驗證",
];

test("both locales cover ES-01 through ES-09 and avoid prohibited copy", () => {
  for (const locale of Object.values(esignCopy)) {
    assert.deepEqual(Object.keys(locale), [
      "ES-01", "ES-02", "ES-03", "ES-04", "ES-05",
      "ES-06", "ES-07", "ES-08", "ES-09",
    ]);
    const serialized = JSON.stringify(locale);
    for (const word of banned) assert.equal(serialized.includes(word), false, word);
    for (const screen of Object.values(locale)) {
      assert.equal(typeof screen.label, "string");
      assert.equal(typeof screen.error, "string");
    }
  }
});

test("identity completion label uses the P1 Email step wording", () => {
  assert.equal(esignCopy["zh-TW"]["ES-03"].completed, EMAIL_IDENTITY_LABEL);
  assert.equal(EMAIL_IDENTITY_LABEL, "已完成 Email 身分確認步驟");
  assert.equal(EMAIL_IDENTITY_LABEL.includes("已驗證"), false);
});
