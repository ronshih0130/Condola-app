import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inviteTokenBytes, mintedLoginEmail, newInviteToken, portalInviteOrigin, portalInviteUrl } from "./portal-invite";

const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

test("invite links use the request host for this app and the site URL otherwise", () => {
  const previous = process.env.CONDOLA_SITE_URL;
  const previousEnv = process.env.CONDOLA_ENV;
  try {
    process.env.CONDOLA_SITE_URL = "https://staging.condola.app";
    delete process.env.CONDOLA_ENV;
    assert.equal(portalInviteOrigin("https://condola-staging.condola.workers.dev"), "https://condola-staging.condola.workers.dev");
    assert.equal(portalInviteOrigin("https://app.condola.app/m/leases"), "https://app.condola.app");
    assert.equal(portalInviteOrigin("https://staging.condola.app"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin("http://127.0.0.1:43123"), "http://127.0.0.1:43123");
    assert.equal(portalInviteOrigin("https://evil.example"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin(""), "https://staging.condola.app");
    const url = portalInviteUrl("https://app.condola.app", "abc");
    assert.equal(url, "https://app.condola.app/accept/abc");
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
  assert.equal(mintedLoginEmail("tenant@example.com"), false);
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
    "i_portal_login_email",
    "i_portal_minted_email",
    "i_portal_set_password",
  ];
  assert.equal(zh.i_portal_copy, "複製邀請連結");
  assert.equal(zh.i_portal_copied, "已複製，7 天內有效，只能使用一次");
  assert.equal(zh.i_portal_regenerate, "重新產生");
  assert.equal(zh.i_portal_activated, "已啟用");
  assert.equal(zh.i_portal_hand_tenant, "傳給租客");
  assert.equal(zh.i_portal_hand_owner, "傳給屋主");
  assert.equal(zh.i_portal_invite_title, "{firm} 邀請你使用租多啦");
  assert.equal(zh.i_portal_invite_invalid, "這個連結已失效，請向管理公司索取新的連結");
  for (const key of keys) {
    assert.equal(zh[key].includes("房東"), false, key);
    assert.equal(zh[key].includes("房客"), false, key);
    assert.equal(zh[key].includes("LINE"), false, key);
    assert.equal(zh[key].includes("即將推出"), false, key);
    assert.equal(zh[key].includes("寄"), false, key);
  }
});
