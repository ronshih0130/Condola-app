import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

test("sign-up, pricing, and go-live copy stay on the handoff wording", () => {
  assert.equal(zh.i_signup_dup, "這個 Email 已經註冊過了");
  assert.equal(zh.i_signup_code_bad, "代碼無效，可先完成註冊，之後再聯絡我們");
  assert.equal(zh.i_signup_kind_firm, "管理公司");
  assert.equal(zh.i_signup_kind_self, "自己管房的屋主");
  assert.equal(
    zh.i_golive_ready,
    "準備好了嗎？按下『開始正式使用』即可切換到正式環境，可選擇複製您的設定（物件、屋主、費用範本）。測試資料不會帶過去，租客、租約與帳務都從零開始。",
  );
  assert.equal(zh.i_live_locked, "正式資料啟用前，請先與我們確認");
  assert.equal(zh.i_golive_start, "開始正式使用");
  assert.equal(zh.i_price_headline, "依實際出租戶數計費，前 4 戶永遠免費");
  assert.equal(zh.i_price_sub, "只計算有生效租約的戶／房。空房、測試模式資料都不收費。");
  assert.equal(zh.i_price_note, "超過 500 戶的部分每戶 NT$25（夥伴價較低時以夥伴價計）。年繳享 2 個月免費。");
  assert.equal(zh.i_price_receipt, "目前提供收據，暫無法開立統一發票");
  assert.equal(zh.i_price_a5, "目前提供收據，暫無法開立統一發票");
  assert.equal(zh.i_login_signup, "免費註冊");
  assert.equal(zh.i_login_invite_tail, "（前 4 戶免費，先在測試模式試用全部功能）");
  assert.equal(zh.i_admin_pause, "緊急暫停正式使用");
  assert.equal(zh.i_price_footer, "本服務為軟體工具，不代為管理物業、收取租金或保證法規遵循。");
});

test("the emergency pause defaults off and the go-live button stays solid when disabled", () => {
  const migration = readFileSync(new URL("../../supabase/migrations/20261022120000_self_serve_signup.sql", import.meta.url), "utf8");
  assert.match(migration, /'go_live_lock'/);
  assert.match(migration, /'false'::jsonb/);
  assert.match(migration, /ANJU2026/);
  assert.match(migration, /7 days is deferred/);
  const button = readFileSync(new URL("../components/env-mode.tsx", import.meta.url), "utf8");
  assert.match(button, /opacity:\s*1/);
  assert.match(button, /i_live_locked/);
  const env = readFileSync(new URL("../app/m/env/page.tsx", import.meta.url), "utf8");
  assert.match(env, /i_golive_ready/);
});
