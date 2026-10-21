import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

test("sign-up, pricing, and go-live copy stay on the handoff wording", () => {
  assert.equal(zh.i_signup_dup, "這個電子郵件已經註冊過了");
  assert.equal(zh.i_signup_verify_title, "請到信箱確認電子郵件");
  assert.equal(zh.i_signup_change_email, "更換電子郵件");
  assert.equal(zh.i_signup_kind_title, "您的身分");
  assert.equal(zh.i_signup_firm_details, "事務所資料");
  assert.equal(zh.i_field_required, "請填寫此欄位");
  assert.equal(zh.i_signup_submitting, "建立中…");
  assert.equal(zh.i_golive_pending, "正在切換到正式環境…");
  assert.equal(zh.i_env_banner_title, "測試模式");
  assert.equal(zh.i_signup_confirm_email, "確認我的電子郵件");
  assert.equal(zh.i_login_unconfirmed, "請先到信箱確認電子郵件");
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
  assert.equal(zh.i_price_note, "年繳享 1 個月免費。");
  assert.equal(zh.i_price_year, "年繳 {money}（送 1 個月）");
  assert.equal(zh.i_price_cycle_y, "年繳送 1 個月");
  assert.equal(zh.i_price_receipt, "目前提供收據，暫無法開立統一發票");
  assert.equal(zh.i_price_a5, "目前提供收據，暫無法開立統一發票");
  assert.equal(zh.i_login_signup, "免費註冊");
  assert.equal(zh.i_login_invite_tail, "（前 4 戶免費，先在測試模式試用全部功能）");
  assert.equal(zh.i_admin_pause, "緊急暫停正式使用");
  assert.equal(zh.i_price_footer, "本服務為軟體工具，不代為管理物業、收取租金或保證法規遵循。");
  assert.equal(zh.i_price_fit_pro, "多據點、人數較多的團隊");
  assert.equal(zh.i_price_seat_free, "1 個席次（待接受的邀請也計入）");
  assert.equal(zh.i_price_seat_std, "5 個席次");
  assert.equal(zh.i_price_seat_pro, "不限席次");
  assert.equal(zh.i_price_free_amt, "NT$0");
  assert.equal(zh.i_price_std_amt, "第 5 戶起每戶每月 NT$30");
  assert.equal(zh.i_price_pro_amt, "第 5 戶起每戶每月 NT$40");
  assert.equal(zh.i_price_trial, "前 3 個月免費");
  assert.equal(zh.s_de922fa, "匯出物件（CSV）");
  assert.equal("i_price_free_feat" in zh, false);
  const planCopy = [
    zh.i_price_fit_free,
    zh.i_price_fit_std,
    zh.i_price_fit_pro,
    zh.i_price_seat_free,
    zh.i_price_seat_std,
    zh.i_price_seat_pro,
    zh.i_price_trial,
    zh.i_price_note,
    zh.i_price_year,
    zh.i_price_cycle_y,
    zh.s_de922fa,
  ].join("\n");
  for (const banned of ["LINE 官方", "品牌報表", "優先支援", "進階報表", "即將推出", "Excel", "房東", "房客", "CSV/ZIP", "500", "NT$25", "2 個月"]) {
    assert.equal(planCopy.includes(banned), false, banned);
  }
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
