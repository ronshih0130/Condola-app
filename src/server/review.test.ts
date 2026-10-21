import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backupDisplay } from "./backup";
import { PERMS } from "./perms";
import { formatTaipei, formatTaipeiDate } from "./time";

const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

const SPEC_LABELS = [
  "View dashboard (with money totals)",
  "View properties, rooms, tenants, leases",
  "Add or edit properties; import data",
  "Create, renew and end leases; send for signing",
  "See tenant phone numbers",
  "Record, confirm or return payments; add charges",
  "Reverse or correct ledger entries",
  "Bank reconciliation",
  "View rent roll and owner statements",
  "Generate or reissue owner statements",
  "Add expenses (with receipt)",
  "Month-close",
  "Update repair tickets",
  "Message tenants",
  "Export reports (CSV)",
  "Invite members, change roles, deactivate",
  "Rules, notifications and owner-portal privacy",
  "Export all data",
];

const ZH_LABELS = [
  "查看總覽（含收款金額）",
  "查看物件、房間、租客、租約",
  "新增／編輯物件與匯入資料",
  "建立、續約、終止租約與送簽",
  "查看租客電話",
  "登錄、確認、退回收款；新增費用",
  "沖銷與更正帳務分錄",
  "銀行對帳",
  "查看租金總覽與屋主報表",
  "產生／重新發行屋主報表",
  "新增代墊費用（含收據）",
  "月結",
  "更新報修狀態",
  "傳訊息給租客",
  "匯出報表（CSV）",
  "邀請成員、變更角色、停用帳號",
  "規則、通知與屋主入口隱私設定",
  "匯出全部資料",
];

const ERROR_KEYS = [
  "i_forbidden",
  "i_required",
  "i_generic",
  "i_not_found",
  "i_email_taken",
  "i_reset_expired",
  "i_auth_invalid",
  "i_auth_disabled",
  "i_pw_mismatch",
  "i_pw_weak",
  "i_mfa_required_err",
  "i_invite_used",
  "i_invite_revoked",
  "i_invite_expired",
  "i_invite_invalid",
  "i_last_admin",
  "i_own_role",
  "i_confirm_needed",
  "i_month_locked",
  "i_expense_void_done",
  "i_expense_locked",
  "i_expense_amount",
  "i_expense_state",
  "i_report_range",
];

test("sign-in times render in Asia/Taipei", () => {
  assert.equal(formatTaipei("2026-10-20T00:30:00Z"), "2026-10-20 08:30");
  assert.equal(formatTaipei(new Date("2026-10-20T16:00:00Z")), "2026-10-21 00:00");
  assert.equal(formatTaipei("not-a-date"), "");
  assert.equal(formatTaipeiDate("2026-10-20T16:30:00Z"), "2026-10-21");
  assert.equal(formatTaipeiDate("2026-10-20T00:30:00Z"), "2026-10-20");
});

test("showing backup codes asks the caller to clear the cookie", () => {
  const shown = backupDisplay("ABCD EFGH");
  assert.deepEqual(shown.codes, ["ABCD", "EFGH"]);
  assert.equal(shown.clearCookie, true);
  assert.deepEqual(backupDisplay(undefined).codes, []);
  assert.equal(backupDisplay("").clearCookie, true);
});

test("permission labels match the prototype wording", () => {
  assert.deepEqual(
    PERMS.map(([, label]) => en[label]),
    SPEC_LABELS,
  );
  assert.deepEqual(
    PERMS.map(([, label]) => zh[label]),
    ZH_LABELS,
  );
});

test("invite expiry, lockout, reset, and no-access copy match the prototype", () => {
  assert.equal(zh.i_invite_expiry, "{d} 到期");
  assert.equal(en.i_invite_expiry, "Expires {d}");
  assert.equal(zh.i_auth_locked, "嘗試次數過多，請 15 分鐘後再試或重設密碼");
  assert.equal(en.i_auth_locked, "Too many attempts. Try again in 15 minutes or reset your password");
  assert.equal(zh.i_forgot_sent, "如果這個 Email 有租多啦帳號，重設連結已寄出，請於 60 分鐘內使用。沒收到請檢查垃圾郵件。");
  assert.equal(en.i_forgot_sent, "If this email has a 租多啦 account, a reset link has been sent. Use it within 60 minutes. If it doesn’t arrive, check your spam folder.");
  assert.equal(zh.i_forgot_sent.includes("{email}"), false);
  assert.equal(zh.i_reset_expired, "這個連結已失效或已使用，請重新申請重設密碼。");
  assert.equal(zh.i_reset_resend, "重新寄送重設信");
  assert.equal(en.i_reset_resend, "Resend the reset email");
  assert.equal(zh.i_reset_save, "儲存新密碼");
  assert.equal(zh.i_password_updated, "密碼已更新，請重新登入");
  assert.match(zh.i_auth_invalid, /^Email /);
  assert.doesNotMatch(zh.i_auth_invalid, /帳號/);
  assert.match(en.i_auth_invalid, /^Email /);
  assert.equal(zh.i_noperm_body, "需要以下角色：{roles}");
  assert.equal(zh.i_ask_admin, "如需此權限，請聯絡公司管理員變更您的角色。");
  assert.equal(en.i_noperm_body, "Needs one of these roles: {roles}");
  assert.equal(en.i_ask_admin, "To get access, ask your company admin to change your role.");
  assert.equal(zh.i_noperm_title, "您沒有這個頁面的權限");
  assert.equal(en.i_noperm_title, "You don’t have access to this page");
});

test("error messages include a next step", () => {
  for (const key of ERROR_KEYS) {
    assert.match(en[key], /Please /);
    assert.match(zh[key], /請/);
  }
});
