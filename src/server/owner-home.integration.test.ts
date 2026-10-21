import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeT } from "../i18n";
import { ownerPrivacy } from "./auth";
import { ORG2_ID } from "./ids";

test("the owner home names the session firm, not the demo seed", async () => {
  const coast = await ownerPrivacy(ORG2_ID);
  assert.equal(coast.name, "海岸公寓管理");
  assert.equal(coast.name.includes("松信"), false);
  const page = readFileSync(new URL("../app/o/page.tsx", import.meta.url), "utf8");
  assert.equal(page.includes("FIRM_NAME"), false);
  assert.match(page, /data-testid="managed-by"/);
  assert.match(page, /firm: privacy\.name/);
  const line = makeT("zh-TW")("i_managed_by", { firm: coast.name, brand: makeT("zh-TW")("i_brand") });
  assert.equal(line, "由 海岸公寓管理 管理・使用 租多啦");
});
