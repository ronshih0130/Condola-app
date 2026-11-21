import assert from "node:assert/strict";
import test from "node:test";
import zh from "./zh-TW.json";
import en from "./en.json";
import { EMPTY_PAGES } from "@/lib/empty-cta";

test("MGT-56-AC5: empty-state locale parity, approved vocabulary and complete page copy", () => {
  const keys = Object.keys(zh).filter(key => key.startsWith("es_"));
  assert.deepEqual(keys.sort(), Object.keys(en).filter(key => key.startsWith("es_")).sort());
  for (const key of keys) {
    const z = (zh as Record<string, string>)[key], e = (en as Record<string, string>)[key];
    assert.ok(z && e, key);
    assert.doesNotMatch(z, /目前沒有資料。|NT\$0|系統代發|代收|轉付|欠租|入帳|已收|金流|代管|包租|本公司|事務所|已驗證|保證|統一編號|含稅/);
    assert.doesNotMatch(e, /verified tenant|guarantee|registered company/i);
  }
  for (const page of EMPTY_PAGES) for (const suffix of ["title", "reason", "action"]) assert.ok(keys.includes(`es_${page}_${suffix}`));
});
test("MGT-56-AC11: both approved copy deltas are verbatim", () => {
  assert.equal(zh.es_LEASE_reason, "建租約時租客可以先略過，送簽前再加入並確認。");
  assert.equal(zh.es_DASH_pay_reason, "還沒有租約，所以還沒有人要繳租。租約生效後就會開始記錄。");
});
