import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { paymentRecordedMail } from "./mail-copy";
import {
  LINE_REPLIES,
  lineApiOrigin,
  lineBasicId,
  lineCopyAllowed,
  linePushTextOk,
  lineSignatureValid,
  linkCodeFromText,
  LINE_SENTENCES,
  lineLive,
  payLink,
  paymentRecordedText,
  pushLineText,
  replyLineText,
  showLine,
  staffLineText,
  verifyLineWebhook,
} from "./line";

const user = `U${"a".repeat(32)}`;
const payUrl = "https://app.condola.app/t/pay";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

const creds = env({
  LINE_CHANNEL_SECRET: "test-secret",
  LINE_CHANNEL_ACCESS_TOKEN: "test-token",
});

const banned = ["入帳", "欠租", "代收", "本公司", "收" + "租", "收" + "款", "已收", "房" + "東", "房" + "客", "644odqoe", "NT$", "LINE"];

function assertClean(text: string) {
  for (const word of banned) assert.equal(text.includes(word), false, word);
}

test("lineLive stays off until the flag is explicitly on", () => {
  assert.equal(lineLive(null), false);
  assert.equal(lineLive({}), false);
  assert.equal(lineLive({ line_alerts: true }), false);
  assert.equal(lineLive('{"line_alerts":true}'), false);
  assert.equal(lineLive({ line_live: false }), false);
  assert.equal(lineLive({ line_live: "false" }), false);
  assert.equal(lineLive({ line_live: true }), true);
  assert.equal(lineLive({ line_live: "true" }), true);
});

test("showLine is on for the sample company and beta orgs only", () => {
  assert.equal(showLine({ environment: "sandbox", planTier: "free" }), true);
  assert.equal(showLine({ environment: "sandbox", planTier: "free", featureFlags: { line_alerts: false } }), false);
  assert.equal(showLine({ environment: "sandbox", featureFlags: { line_alerts: "false" } }), false);
  assert.equal(showLine({ environment: "live", planTier: "beta" }), true);
  assert.equal(showLine({ environment: "live", planTier: "beta", featureFlags: null }), true);
  assert.equal(showLine({ environment: "live", planTier: "beta", featureFlags: '{"line_alerts":false}' }), false);
  for (const planTier of ["free", "pro", "business"]) {
    assert.equal(showLine({ environment: "live", planTier, featureFlags: { line_alerts: true } }), false, planTier);
  }
});

test("a push is refused when either credential is missing and fetch is not called", async () => {
  let called = 0;
  const fetchImpl: typeof fetch = async () => {
    called += 1;
    throw new Error("fetch should not run");
  };
  const text = staffLineText("rent_due", "https://app.condola.app");
  const missingSecret = await pushLineText(user, text, fetchImpl, env({ LINE_CHANNEL_ACCESS_TOKEN: "token" }));
  const missingToken = await pushLineText(user, text, fetchImpl, env({ LINE_CHANNEL_SECRET: "secret" }));
  assert.equal(missingSecret.ok, false);
  assert.equal(missingToken.ok, false);
  if (!missingSecret.ok) assert.match(missingSecret.reason, /LINE_CHANNEL_SECRET missing/);
  if (!missingToken.ok) assert.match(missingToken.reason, /LINE_CHANNEL_ACCESS_TOKEN missing/);
  assert.equal(called, 0);
});

test("webhook signatures use the raw body and reject a bad or short header", () => {
  const body = '{"events":[]}';
  const good = createHmac("sha256", "test-secret").update(body).digest("base64");
  assert.equal(lineSignatureValid("test-secret", body, good), true);
  assert.equal(lineSignatureValid("test-secret", body, "bm8="), false);
  assert.equal(lineSignatureValid("test-secret", body, ""), false);
  assert.equal(verifyLineWebhook(body, good, creds), "ok");
  assert.equal(verifyLineWebhook(body, "bm9=", creds), "bad_signature");
  assert.equal(verifyLineWebhook(body, good, env({})), "missing_secret");
});

test("the access token stays on api.line.me unless the origin is loopback", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response("{}", { status: 200, headers: { "x-line-request-id": "req-1" } });
  };
  const text = paymentRecordedText(payUrl);
  const evil = await pushLineText(user, text, fetchImpl, env({ ...creds, LINE_API_ORIGIN: "https://evil.example" }));
  assert.equal(evil.ok, true);
  assert.equal(calls[0], "https://api.line.me/v2/bot/message/push");
  const local = await pushLineText(user, text, fetchImpl, env({ ...creds, LINE_API_ORIGIN: "http://127.0.0.1:4601" }));
  assert.equal(local.ok, true);
  assert.equal(calls[1], "http://127.0.0.1:4601/v2/bot/message/push");
  assert.equal(lineApiOrigin(env({ LINE_API_ORIGIN: "https://api.line.me/v2" })), "https://api.line.me");
  assert.equal(lineApiOrigin(env({ LINE_API_ORIGIN: "not a url" })), "https://api.line.me");
});

test("link codes are 6 digits and pushes are a sentence plus a link", () => {
  assert.equal(linkCodeFromText(" 綁定 012345 "), "012345");
  assert.equal(linkCodeFromText("綁定碼 123456"), "123456");
  assert.equal(linkCodeFromText("123456"), "123456");
  assert.equal(linkCodeFromText("綁定 12345"), null);
  assert.equal(linkCodeFromText("綁定 1234567"), null);
  assert.equal(linkCodeFromText("ABCD2345"), null);
  assert.equal(lineBasicId(env({ LINE_OA_BASIC_ID: "@644odqoe" })), null);
  assert.equal(lineBasicId(env({ LINE_OA_BASIC_ID: "prefix-644odqoe" })), null);
  assert.equal(lineBasicId(env({ LINE_OA_BASIC_ID: "condola-qa" })), "@condola-qa");
  assert.equal(lineBasicId(env({ LINE_OA_BASIC_ID: "@condola-qa" })), "@condola-qa");
  const reminder = staffLineText("rent_due", "https://app.condola.app/");
  const overdue = staffLineText("rent_overdue", "https://app.condola.app");
  const lease = staffLineText("lease_expiry", "https://app.condola.app");
  const notice = paymentRecordedText(payLink("https://app.condola.app"));
  assert.equal(reminder, `${LINE_SENTENCES.rent_due} https://app.condola.app/m/rent`);
  assert.equal(overdue, `${LINE_SENTENCES.rent_overdue} https://app.condola.app/m/rent`);
  assert.equal(lease, `${LINE_SENTENCES.lease_expiry} https://app.condola.app/m/leases`);
  assert.equal(notice, "款項到帳。請查看：https://app.condola.app/t/pay");
  assert.equal(linePushTextOk(reminder), true);
  assert.equal(linePushTextOk(`${reminder}?invoice=1`), false);
  assert.equal(linePushTextOk("有一筆租金快到期了，請登入查看。 https://app.condola.app/t/pay"), false);
  assert.equal(linePushTextOk("款項到帳。請查看：https://app.condola.app/t/lease"), false);
  assert.equal(linePushTextOk("【繳款提醒】周美玲 未繳 NT$1"), false);
  for (const text of [reminder, overdue, lease, notice, staffLineText("repair", "https://app.condola.app"), staffLineText("statement", "https://app.condola.app")]) {
    assertClean(text);
  }
});

test("reply copy and the payment email avoid banned words", () => {
  for (const text of Object.values(LINE_REPLIES)) {
    assert.equal(lineCopyAllowed(text), true);
    assertClean(text);
  }
  const mail = paymentRecordedMail({
    name: "王小美",
    company: "松信住宅管理",
    url: payUrl,
  });
  assert.equal(mail.subject, "款項到帳");
  assert.match(mail.text, /王小美 您好：/);
  assert.match(mail.text, /款項到帳。請到下面的連結查看。/);
  assert.match(mail.text, /https:\/\/app\.condola\.app\/t\/pay/);
  assert.match(mail.text, /此信由租多啦代 松信住宅管理 寄出/);
  for (const word of banned.filter((item) => item !== "LINE")) assert.equal(`${mail.subject}\n${mail.text}`.includes(word), false, word);
});

test("replies are refused without credentials and are not sent to a foreign origin", async () => {
  let called = 0;
  const fetchImpl: typeof fetch = async (input) => {
    called += 1;
    assert.equal(String(input), "https://api.line.me/v2/bot/message/reply");
    return new Response("{}", { status: 200, headers: { "x-line-request-id": "reply-1" } });
  };
  const missing = await replyLineText("reply-token", LINE_REPLIES.linked, fetchImpl, env({}));
  assert.equal(missing.ok, false);
  assert.equal(called, 0);
  const sent = await replyLineText("reply-token", LINE_REPLIES.linked, fetchImpl, env({
    ...creds,
    LINE_API_ORIGIN: "https://evil.example",
  }));
  assert.equal(sent.ok, true);
  assert.equal(called, 1);
  const rejected = await replyLineText("reply-token", "請看 LINE", fetchImpl, creds);
  assert.equal(rejected.ok, false);
  assert.equal(called, 1);
});

test("tenant pages and the notify screen never name the support account", () => {
  const files = [
    new URL("../app/t/page.tsx", import.meta.url),
    new URL("../app/t/pay/page.tsx", import.meta.url),
    new URL("../app/t/lease/page.tsx", import.meta.url),
    new URL("../app/t/messages/page.tsx", import.meta.url),
    new URL("../app/t/layout.tsx", import.meta.url),
    new URL("../components/line-notify.tsx", import.meta.url),
    new URL("../app/m/notify/page.tsx", import.meta.url),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("644odqoe"), false, String(file));
    assert.equal(source.includes("LINE_SUPPORT_CONTACT"), false, String(file));
    assert.equal(source.includes("驗證碼"), false, String(file));
  }
  const panel = readFileSync(new URL("../components/line-notify.tsx", import.meta.url), "utf8");
  assert.match(panel, /if \(!showLine\) return null/);
  assert.equal(panel.includes("王小美"), false);
  assert.equal(panel.includes("NT$"), false);
});

test("the line migration is additive, later than 20261029130000, and creates no function", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261030120000_line_notify.sql", import.meta.url), "utf8");
  assert.match(sql, /Version 20261030120000/);
  assert.doesNotMatch(sql, /CREATE\s+(OR REPLACE\s+)?FUNCTION/i);
  assert.match(sql, /REVOKE ALL ON TABLE line_link_codes FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON TABLE line_link_codes FROM anon/);
  assert.match(sql, /REVOKE ALL ON TABLE line_link_codes FROM authenticated/);
  assert.match(sql, /REVOKE ALL ON TABLE line_user_links FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON TABLE line_notify_prefs FROM authenticated/);
  assert.match(sql, /REVOKE ALL ON TABLE line_delivery_log FROM anon/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|ALTER COLUMN|驗證碼/i);
  assert.match(sql, /code ~ '\^\[0-9\]\{6\}\$'/);
});
