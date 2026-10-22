import assert from "node:assert/strict";
import test from "node:test";
import {
  leaseAdminMail,
  leaseTenantMail,
  overdueAdminMail,
  overdueTenantMail,
  passwordResetMail,
} from "./mail-copy";
import {
  BREVO_FROM_EMAIL,
  BREVO_FROM_NAME,
  CLOUDFLARE_FROM,
  MAIL_FROM,
  mailProviderName,
  sendMail,
  useEmailBinding,
  type EmailSender,
} from "./mail";

const FORBIDDEN = ["房東", "房客", "LINE", "即將推出", "驗證", "代收", "保證", "催繳", "違約", "收款"];

function assertClean(text: string) {
  for (const word of FORBIDDEN) assert.equal(text.includes(word), false, word);
}

function providerEnv(value?: string): NodeJS.ProcessEnv {
  return (value === undefined ? {} : { MAIL_PROVIDER: value }) as unknown as NodeJS.ProcessEnv;
}

test("mail provider defaults to Cloudflare and backups are explicit", () => {
  assert.equal(mailProviderName(providerEnv()), "cloudflare");
  assert.equal(mailProviderName(providerEnv("cloudflare")), "cloudflare");
  assert.equal(mailProviderName(providerEnv(" Brevo ")), "brevo");
  assert.equal(mailProviderName(providerEnv("resend")), "resend");
  assert.equal(mailProviderName(providerEnv("smtp")), "cloudflare");
});

test("Cloudflare send uses the binding shape and skips when it is missing", async () => {
  const calls: unknown[] = [];
  const binding: EmailSender = {
    async send(message) {
      calls.push(message);
      return { messageId: "msg_cf" };
    },
  };
  useEmailBinding(binding);
  const saved = process.env.MAIL_PROVIDER;
  delete process.env.MAIL_PROVIDER;
  try {
    const sent = await sendMail({
      to: "a@example.com",
      subject: "主旨",
      html: "<p>hi</p>",
      text: "hi",
      replyTo: "firm@example.com",
    });
    assert.deepEqual(sent, { ok: true, messageId: "msg_cf", provider: "cloudflare" });
    assert.deepEqual(calls, [
      {
        to: "a@example.com",
        from: CLOUDFLARE_FROM,
        subject: "主旨",
        html: "<p>hi</p>",
        text: "hi",
        replyTo: "firm@example.com",
      },
    ]);
    assert.deepEqual(CLOUDFLARE_FROM, { email: "noreply@send.condola.app", name: "租多啦 Condola" });
    assert.equal(MAIL_FROM, "\"租多啦 Condola\" <noreply@send.condola.app>");
    useEmailBinding(null);
    const skipped = await sendMail({ to: "a@example.com", subject: "主旨", html: "", text: "hi" });
    assert.deepEqual(skipped, { ok: false, skipped: true, reason: "EMAIL binding missing" });
  } finally {
    useEmailBinding(undefined);
    if (saved === undefined) delete process.env.MAIL_PROVIDER;
    else process.env.MAIL_PROVIDER = saved;
  }
});

test("Brevo is the fallback and skips without an API key", async () => {
  const saved = { provider: process.env.MAIL_PROVIDER, key: process.env.BREVO_API_KEY, fetch: global.fetch };
  process.env.MAIL_PROVIDER = "brevo";
  delete process.env.BREVO_API_KEY;
  try {
    const skipped = await sendMail({ to: "a@example.com", subject: "主旨", html: "", text: "hi" });
    assert.deepEqual(skipped, { ok: false, skipped: true, reason: "BREVO_API_KEY missing" });
    process.env.BREVO_API_KEY = "xkeysib-test";
    let url = "";
    let apiKey = "";
    let body = "";
    global.fetch = async (input, init) => {
      url = String(input);
      apiKey = new Headers(init?.headers).get("api-key") || "";
      body = String(init?.body ?? "");
      return Response.json({ messageId: "<msg_brevo@smtp-relay.brevo.com>" });
    };
    const sent = await sendMail({
      to: "a@example.com",
      subject: "主旨",
      html: "<p>hi</p>",
      text: "hi",
      replyTo: "firm@example.com",
    });
    assert.deepEqual(sent, { ok: true, messageId: "<msg_brevo@smtp-relay.brevo.com>", provider: "brevo" });
    assert.equal(url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(apiKey, "xkeysib-test");
    const parsed = JSON.parse(body) as {
      sender: { name: string; email: string };
      to: { email: string }[];
      replyTo: { email: string };
      htmlContent: string;
      textContent: string;
    };
    assert.deepEqual(parsed.sender, { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL });
    assert.equal(BREVO_FROM_EMAIL, "no-reply@condola.app");
    assert.deepEqual(parsed.to, [{ email: "a@example.com" }]);
    assert.deepEqual(parsed.replyTo, { email: "firm@example.com" });
    assert.equal(parsed.htmlContent, "<p>hi</p>");
    assert.equal(parsed.textContent, "hi");
  } finally {
    global.fetch = saved.fetch;
    if (saved.provider === undefined) delete process.env.MAIL_PROVIDER;
    else process.env.MAIL_PROVIDER = saved.provider;
    if (saved.key === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = saved.key;
  }
});

test("Resend is the backup and skips without an API key", async () => {
  const saved = { provider: process.env.MAIL_PROVIDER, key: process.env.RESEND_API_KEY, fetch: global.fetch };
  process.env.MAIL_PROVIDER = "resend";
  delete process.env.RESEND_API_KEY;
  try {
    const skipped = await sendMail({ to: "a@example.com", subject: "主旨", html: "", text: "hi" });
    assert.deepEqual(skipped, { ok: false, skipped: true, reason: "RESEND_API_KEY missing" });
    process.env.RESEND_API_KEY = "re_test";
    let body = "";
    global.fetch = async (_input, init) => {
      body = String(init?.body ?? "");
      return Response.json({ id: "msg_re" });
    };
    const sent = await sendMail({
      to: "a@example.com",
      subject: "主旨",
      html: "<p>hi</p>",
      text: "hi",
      replyTo: "firm@example.com",
    });
    assert.deepEqual(sent, { ok: true, messageId: "msg_re", provider: "resend" });
    assert.equal(JSON.parse(body).from, MAIL_FROM);
    assert.equal(JSON.parse(body).reply_to, "firm@example.com");
  } finally {
    global.fetch = saved.fetch;
    if (saved.provider === undefined) delete process.env.MAIL_PROVIDER;
    else process.env.MAIL_PROVIDER = saved.provider;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.key;
  }
});

test("overdue and reset copy matches the revised file and never says 收款", () => {
  const admin = overdueAdminMail({
    name: "林雅婷",
    property: "府後街",
    space: "3F A",
    tenant: "周美玲",
    month: "2026年11月",
    amount: "18,000",
    due: "2026年11月5日",
    days: 1,
    url: "https://app.condola.app/m/rent",
  });
  const tenant = overdueTenantMail({
    name: "周美玲",
    address: "台中市西區府後街38號",
    space: "3F A",
    month: "2026年11月",
    due: "2026年11月5日",
    amount: "18,000",
    company: "松信管理",
    contact: "04-2222-3333，firm@example.com",
    url: "https://app.condola.app/t/pay",
  });
  const reset = passwordResetMail("https://app.condola.app/reset?token_hash=abc&type=recovery");
  assert.equal(admin.subject, "【繳款提醒】府後街 3F A 本期租金尚未繳清");
  assert.equal(admin.subject.startsWith("【繳款提醒】"), true);
  assert.equal(tenant.subject, "2026年11月 租金繳費提醒");
  assert.match(admin.text, /系統尚未有繳款紀錄/);
  assert.match(admin.text, /請到「租金總覽」新增繳款紀錄，就不會再提醒。/);
  assert.equal(admin.text.includes("待確認收款"), false);
  assert.equal(admin.text.includes("登記收款"), false);
  assert.match(tenant.text, /目前尚未有繳款紀錄/);
  assert.match(tenant.text, /請與管理公司確認繳款：松信管理，04-2222-3333，firm@example.com。/);
  assert.match(tenant.text, /不經手租金與押金/);
  assert.equal(reset.subject, "重設您的租多啦密碼");
  assert.match(reset.text, /請在 60 分鐘內點下方連結設定新密碼/);
  assert.match(reset.text, /\[設定新密碼\]\(https:\/\/app\.condola\.app\/reset\?token_hash=abc&type=recovery\)/);
  for (const text of [admin.text, admin.subject, tenant.text, tenant.subject, reset.text, reset.subject]) assertClean(text);
  assert.match(admin.html, /<a href="https:\/\/app\.condola\.app\/m\/rent">查看帳單<\/a>/);
});

test("lease expiry copy keeps the footer, reply facts, and thousands separators", () => {
  const admin = leaseAdminMail({
    name: "林雅婷",
    days: 60,
    property: "府後街",
    space: "3F A",
    tenant: "周美玲",
    owner: "陳屋主",
    start: "2025年11月1日",
    end: "2026年10月31日",
    rent: "18,000",
    url: "https://staging.condola.app/m/leases/lease-1",
  });
  const tenant = leaseTenantMail({
    name: "周美玲",
    address: "台中市西區府後街38號",
    space: "3F A",
    end: "2026年10月31日",
    company: "松信管理",
    contact: "firm@example.com",
    url: "https://staging.condola.app/t/lease",
  });
  assert.equal(admin.subject, "【租約到期提醒】府後街 3F A 將於 2026年10月31日 到期");
  assert.match(admin.text, /以下租約將於 60 天後到期/);
  assert.match(admin.text, /月租：NT\$18,000/);
  assert.match(admin.text, /403 台中市西區府後街38號｜service@condola\.app/);
  assert.match(tenant.text, /租多啦是管理公司使用的租賃管理軟體，不經手租金與押金；相關問題請洽 松信管理。/);
  assert.match(tenant.text, /403 台中市西區府後街38號/);
  assert.equal(tenant.subject, "您的租約將於 2026年10月31日 到期");
  for (const text of [admin.text, tenant.text]) assertClean(text);
});
