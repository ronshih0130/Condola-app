import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MANAGER_NAV } from "@/server/perms";

const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("manager lease and statement pages use the sidebar label 繳款紀錄", () => {
  assert.equal(zh.i_nav_inbox, "繳款紀錄");
  assert.equal(zh.i_nav_inbox.includes("待確認收款"), false);
  const inbox = MANAGER_NAV.flatMap((section) => [...section.links]).find((link) => link.href === "/m/payments");
  assert.equal(inbox?.key, "i_nav_inbox");

  const layout = source("app/m/layout.tsx");
  assert.match(layout, /Sidebar/);
  for (const page of ["app/m/leases/[id]/page.tsx", "app/m/statements/[id]/page.tsx"]) {
    const text = source(page);
    assert.equal(text.includes("待確認收款"), false, page);
    assert.equal(text.includes("已確認收款"), false, page);
  }

  const pay = source("app/t/pay/page.tsx");
  assert.match(pay, /i_pay_confirmed/);
  assert.equal(pay.includes("i_nav_inbox"), false);
  assert.equal(pay.includes("待確認繳款"), false);
  assert.equal(pay.includes("待確認收款"), false);
});
