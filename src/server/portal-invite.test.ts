import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inviteStoredEmail,
  inviteTokenBytes,
  mintedLoginEmail,
  newInviteToken,
  portalInviteDisplayEmail,
  portalInviteOrigin,
  portalInviteUrl,
  portalShownEmail,
} from "./portal-invite";

const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

test("invite links use the request host for this app and the site URL otherwise", () => {
  const previous = process.env.CONDOLA_SITE_URL;
  const previousEnv = process.env.CONDOLA_ENV;
  try {
    process.env.CONDOLA_SITE_URL = "https://staging.condola.app";
    delete process.env.CONDOLA_ENV;
    assert.equal(portalInviteOrigin("https://condola-staging.condola.workers.dev"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin("https://app.condola.app/m/leases"), "https://app.condola.app");
    assert.equal(portalInviteOrigin("https://staging.condola.app"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin("http://127.0.0.1:43123"), "http://127.0.0.1:43123");
    assert.equal(portalInviteOrigin("https://evil.example"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin(""), "https://staging.condola.app");
    const stagingUrl = portalInviteUrl("https://condola-staging.condola.workers.dev", "abc");
    assert.equal(stagingUrl, "https://staging.condola.app/accept/abc");
    assert.equal(stagingUrl.includes("workers.dev"), false);
    process.env.CONDOLA_SITE_URL = "https://app.condola.app";
    const productionUrl = portalInviteUrl("https://condola-staging.condola.workers.dev", "abc");
    assert.equal(productionUrl, "https://app.condola.app/accept/abc");
    assert.equal(productionUrl.includes("workers.dev"), false);
  } finally {
    if (previous === undefined) delete process.env.CONDOLA_SITE_URL;
    else process.env.CONDOLA_SITE_URL = previous;
    if (previousEnv === undefined) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = previousEnv;
  }
});

test("portal tokens are at least 32 bytes and minted logins stay recognizable", () => {
  const token = newInviteToken();
  assert.ok(inviteTokenBytes(token) >= 32);
  assert.equal(token.includes("/"), false);
  assert.equal(mintedLoginEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local"), true);
  assert.equal(mintedLoginEmail("owner1.demo@example.com"), false);
  assert.equal(mintedLoginEmail("someone@demo.condola.local"), false);
  assert.equal(mintedLoginEmail("tenant@example.com"), false);
  assert.equal(portalInviteDisplayEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local"), "");
  assert.equal(portalInviteDisplayEmail("owner1.demo@example.com"), "owner1.demo@example.com");
  assert.equal(portalInviteDisplayEmail("tenant@example.com"), "tenant@example.com");
  assert.equal(inviteStoredEmail("owner1.demo@example.com"), "owner1.demo@example.com");
  assert.equal(inviteStoredEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local"), null);
  assert.equal(inviteStoredEmail(null), null);
  assert.equal(
    portalShownEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local", "owner1.demo@example.com"),
    "owner1.demo@example.com",
  );
  assert.equal(portalShownEmail("morgan.lee@owner.demo", "other@example.com"), "morgan.lee@owner.demo");
  assert.equal(portalShownEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local", null), "");
});

test("portal invite copy hands the link over and stays on the locked wording", () => {
  const keys = [
    "i_portal_copy",
    "i_portal_copied",
    "i_portal_regenerate",
    "i_portal_activated",
    "i_portal_hand_tenant",
    "i_portal_hand_owner",
    "i_portal_invite_title",
    "i_portal_invite_invalid",
    "i_portal_invite_locked",
    "i_portal_login_email",
    "i_portal_choose_email",
    "i_portal_email_unusable",
    "i_portal_set_password",
    "i_portal_working",
  ];
  assert.equal(zh.i_portal_copy, "複製邀請連結");
  assert.equal(zh.i_portal_copied, "已複製，7 天內有效，只能使用一次");
  assert.equal(zh.i_portal_regenerate, "重新產生");
  assert.equal(zh.i_portal_activated, "已啟用");
  assert.equal(zh.i_portal_hand_tenant, "傳給租客");
  assert.equal(zh.i_portal_hand_owner, "傳給屋主");
  assert.equal(zh.i_portal_invite_title, "{firm} 邀請你使用租多啦");
  assert.equal(zh.i_portal_invite_invalid, "這個連結已失效，請向管理公司索取新的連結");
  assert.equal(zh.i_portal_invite_locked, "嘗試次數過多，請 15 分鐘後再試");
  assert.equal(zh.i_portal_choose_email, "請填寫你的 Email。設定密碼後，用它和密碼登入。");
  assert.equal(zh.i_portal_email_unusable, "無法使用這個 email，請改用其他 email，或聯絡管理公司");
  assert.equal(zh.i_portal_working, "處理中…");
  assert.equal(zh.i_portal_choose_email.includes("demo.condola.local"), false);
  assert.equal(zh.i_portal_choose_email.includes("portal-"), false);
  assert.equal(zh.i_portal_email_unusable.includes("已經用過"), false);
  for (const key of keys) {
    assert.equal(zh[key].includes("房東"), false, key);
    assert.equal(zh[key].includes("房客"), false, key);
    assert.equal(zh[key].includes("LINE"), false, key);
    assert.equal(zh[key].includes("即將推出"), false, key);
    assert.equal(zh[key].includes("寄"), false, key);
  }
});
