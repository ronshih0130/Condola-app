import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;

test("sign-up and pricing copy stay on the handoff wording", () => {
  assert.equal(zh.i_signup_dup, "這個電子郵件已經註冊過了");
  assert.equal(zh.i_signup_verify_title, "請到信箱確認電子郵件");
  assert.equal(zh.i_signup_verify_body, "我們已寄出確認信到 {email}。連結 60 分鐘內有效。");
  assert.equal(en.i_signup_verify_body, "We sent a confirmation link to {email}. It works for 60 minutes.");
  assert.equal(zh.i_signup_mail_failed, "驗證信暫時無法寄出，請稍後按「重寄驗證信」。");
  assert.equal(zh.i_signup_mail_wait, "請稍候再重寄驗證信。");
  assert.equal(en.i_signup_mail_failed, "We couldn't send the confirmation email. Please use Resend confirmation in a moment.");
  assert.equal(en.i_signup_mail_wait, "Please wait before resending the confirmation email.");
  assert.equal(zh.i_signup_change_email, "更換電子郵件");
  assert.equal(zh.i_signup_kind_title, "你的身分");
  assert.equal(zh.i_signup_admin_note, "註冊者會成為這個帳號的管理員");
  assert.equal(zh.i_signup_dup_firm, "已有同名的公司。你仍可完成註冊，我們會再確認。若你已是其中一員，請向管理員索取邀請。");
  assert.equal(zh.i_signup_dup_firm.includes("您"), false);
  assert.equal(zh.i_signup_firm_details, "建立你的公司");
  assert.equal(zh.i_signup_name_firm, "公司名稱");
  assert.equal(zh.i_signup_name_hint, "個人屋主可填自己的名字");
  assert.equal(zh.i_signup_create, "建立公司");
  assert.equal(
    `${zh.i_signup_consent_lead}${zh.i_signup_consent_terms}${zh.i_signup_consent_and}${zh.i_signup_consent_privacy}`,
    "我已閱讀並同意《服務條款》與《隱私權政策》",
  );
  assert.equal(
    `${zh.i_portal_consent_lead}${zh.i_portal_consent_terms}${zh.i_portal_consent_and}${zh.i_portal_consent_privacy}`,
    "我已閱讀並同意《服務條款》與《隱私權政策》",
  );
  assert.equal(zh.i_portal_consent_error, "請先同意《服務條款》與《隱私權政策》，才能繼續。");
  assert.equal(zh.i_portal_consent_terms, zh.i_signup_consent_terms);
  assert.equal(en.i_signup_firm_details, "Create your company");
  assert.equal(en.i_signup_name_firm, "Company name");
  assert.equal(en.i_signup_name_hint, "Individual owners can enter their own name");
  assert.equal(en.i_signup_create, "Create company");
  assert.equal(
    `${en.i_signup_consent_lead}${en.i_signup_consent_terms}${en.i_signup_consent_and}${en.i_signup_consent_privacy}`,
    "I have read and agree to the Terms of Service and Privacy Policy",
  );
  for (const key of Object.keys(zh)) {
    if (!key.startsWith("i_signup_")) continue;
    assert.equal(zh[key].includes("事務所"), false, key);
  }
  assert.equal(zh.i_field_required, "請填寫此欄位");
  assert.equal(zh.i_signup_submitting, "建立中…");
  assert.equal(zh.i_env_banner_title, "範例公司");
  assert.equal(zh.i_env_switch_company, "切換到正式公司");
  assert.equal(zh.i_env_return_company, "回到正式公司");
  assert.equal(zh.i_signup_confirm_email, "確認我的電子郵件");
  assert.equal(zh.i_login_unconfirmed, "請先到信箱確認電子郵件");
  assert.equal(zh.i_signup_code_bad, "代碼無效，可先完成註冊，之後再聯絡我們");
  assert.equal(zh.i_signup_kind_firm, "管理公司");
  assert.equal(zh.i_signup_kind_self, "自己管房的屋主");
  assert.equal(zh.i_live_locked, "正式資料啟用前，請先與我們確認");
  assert.equal(zh.i_price_headline, "依實際出租戶數計費，免費方案依官網公告");
  assert.equal(zh.i_price_sub, "只計算有生效租約的戶／房。空房、範例公司資料都不收費。");
  assert.equal(zh.i_price_note, "年繳享 1 個月免費。");
  assert.equal(zh.i_price_year, "年繳 {money}（送 1 個月）");
  assert.equal(zh.i_price_cycle_y, "年繳送 1 個月");
  assert.equal(zh.i_price_receipt, "目前提供收據，暫無法開立統一發票");
  assert.equal(zh.i_price_a5, "目前提供收據，暫無法開立統一發票");
  assert.equal(zh.i_login_signup, "免費註冊");
  assert.equal(zh.i_login_invite_tail, "（免費方案依官網公告，可先看範例公司）");
  assert.equal(zh.i_price_footer, "本服務為軟體工具，不代為管理物業或收取租金，也不保證法規遵循。");
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

test("the go_live_lock row stays in the existing migration and the go-live screen is gone", () => {
  const migration = readFileSync(new URL("../../supabase/migrations/20261022120000_self_serve_signup.sql", import.meta.url), "utf8");
  assert.match(migration, /'go_live_lock'/);
  assert.match(migration, /'false'::jsonb/);
  assert.match(migration, /ANJU2026/);
  assert.match(migration, /7 days is deferred/);
  assert.equal(existsSync(new URL("../app/m/env/page.tsx", import.meta.url)), false);
  const banner = readFileSync(new URL("../components/env-mode.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(banner, /GoLiveForm|actionGoLive|i_golive_/);
  assert.equal("i_golive_start" in zh, false);
  assert.equal("i_golive_ready" in zh, false);
  assert.equal("i_admin_pause" in zh, false);
  assert.equal("i_admin_pause_hint" in zh, false);
  assert.equal(zh.i_audit_ev_go_live, "開始正式使用");
});
