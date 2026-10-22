import assert from "node:assert/strict";
import test from "node:test";
import { cronAuthorized, REMINDER_CRON } from "./cron-auth";
import { deliverReminders, planLeaseReminders, planOverdueReminders, planStaffLineReminders, taipeiToday, type ReminderPlan } from "./reminders";
import type { MailResult } from "./mail";

const origin = "https://app.condola.app";

function staff(prefs: unknown = {}) {
  return [{ name: "林雅婷", email: "admin@example.com", prefs }];
}

const lease = {
  orgId: "org-1",
  leaseId: "lease-1",
  environment: "live",
  status: "active",
  renewalStatus: "none",
  startDate: "2025-12-31",
  endDate: "2026-12-30",
  rentMinor: 1800000,
  orgName: "松信管理",
  contactEmail: "firm@example.com",
  contactPhone: "04-2222-3333",
  settings: {},
  propertyName: "府後街",
  address: "台中市西區府後街38號",
  unitLabel: "3F",
  roomLabel: "A",
  ownerName: "陳屋主",
  tenants: [{ name: "周美玲", email: "tenant@example.com" }],
  staff: staff(),
  origin,
};

test("Taipei 09:00 is 01:00 UTC", () => {
  assert.equal(REMINDER_CRON, "0 1 * * *");
  assert.equal(taipeiToday(new Date("2026-10-31T16:30:00Z")), "2026-11-01");
  assert.equal(taipeiToday(new Date("2026-10-31T15:59:00Z")), "2026-10-31");
});

test("lease reminders go to admins at 60, 30 and 7 days, and tenants only at 30", () => {
  const at = (end: string, today: string, extra: Partial<typeof lease> = {}) =>
    planLeaseReminders({ ...lease, endDate: end, ...extra }, today);
  assert.deepEqual(
    at("2026-12-30", "2026-10-31").map((plan) => plan.kind + ":" + plan.threshold),
    ["lease_expiry_admin:60"],
  );
  const month = at("2026-11-30", "2026-10-31");
  assert.deepEqual(
    month.map((plan) => plan.kind),
    ["lease_expiry_admin", "lease_expiry_tenant"],
  );
  assert.equal(month[1].messages[0].replyTo, "firm@example.com");
  assert.match(month[1].messages[0].text, /請與管理公司確認繳款|請直接聯絡 松信管理/);
  assert.deepEqual(at("2026-11-07", "2026-10-31").map((plan) => plan.threshold), [7]);
  assert.deepEqual(at("2026-11-30", "2026-10-31", { settings: { email_tenant_lease_expiry: false } }).map((plan) => plan.kind), [
    "lease_expiry_admin",
  ]);
  assert.deepEqual(at("2026-12-30", "2026-10-31", { staff: staff({ lease_expiry: false }) }), []);
  assert.deepEqual(at("2026-12-30", "2026-10-31", { environment: "sandbox" }), []);
  assert.deepEqual(at("2026-12-30", "2026-10-31", { status: "terminated" }), []);
  assert.deepEqual(at("2026-12-30", "2026-10-31", { renewalStatus: "renewed" }), []);
  assert.equal(at("2026-12-30", "2026-10-31")[0].messages[0].text.includes("收款"), false);
});

test("overdue reminders reach admins on day 1 and 7, and tenants only on day 1", () => {
  const row = {
    orgId: "org-1",
    invoiceId: "inv-1",
    environment: "live",
    dueDate: "2026-10-30",
    periodStart: "2026-10-01",
    balanceMinor: 1800000,
    orgName: "松信管理",
    contactEmail: null as string | null,
    contactPhone: null as string | null,
    settings: {},
    propertyName: "府後街",
    address: "台中市西區府後街38號",
    unitLabel: "3F",
    roomLabel: "A",
    tenants: [{ name: "周美玲", email: "tenant@example.com" }],
    staff: staff(),
    origin,
  };
  const day1 = planOverdueReminders(row, "2026-10-31");
  assert.deepEqual(
    day1.map((plan) => `${plan.kind}:${plan.threshold}`),
    ["rent_overdue_admin:1", "rent_overdue_tenant:1"],
  );
  assert.equal(day1[0].messages[0].replyTo, "service@condola.app");
  assert.match(day1[0].messages[0].text, /系統尚未有繳款紀錄/);
  assert.match(day1[0].messages[0].text, /NT\$18,000/);
  assert.match(day1[1].messages[0].text, /請與管理公司確認繳款/);
  assert.equal(day1[1].messages[0].text.includes("收款"), false);
  const day7 = planOverdueReminders({ ...row, dueDate: "2026-10-24" }, "2026-10-31");
  assert.deepEqual(day7.map((plan) => plan.kind), ["rent_overdue_admin"]);
  assert.equal(day7[0].threshold, 7);
  assert.deepEqual(planOverdueReminders({ ...row, settings: { email_tenant_rent_overdue: false } }, "2026-10-31").map((plan) => plan.kind), [
    "rent_overdue_admin",
  ]);
  assert.deepEqual(planOverdueReminders({ ...row, environment: "sandbox" }, "2026-10-31"), []);
  assert.deepEqual(planOverdueReminders({ ...row, dueDate: "2026-10-28" }, "2026-10-31"), []);
});

test("day-1 overdue email stays even when the tenant has a linked account", () => {
  const row = {
    orgId: "org-1",
    invoiceId: "inv-1",
    environment: "live",
    dueDate: "2026-10-30",
    periodStart: "2026-10-01",
    balanceMinor: 1800000,
    orgName: "松信管理",
    contactEmail: null as string | null,
    contactPhone: null as string | null,
    settings: {},
    propertyName: "府後街",
    address: "台中市西區府後街38號",
    unitLabel: "3F",
    roomLabel: "A",
    tenants: [{ name: "周美玲", email: "tenant@example.com", contactId: "contact-1", lineUserId: `U${"a".repeat(32)}`, lineOptOut: false }],
    staff: staff(),
    origin,
  };
  const day1 = planOverdueReminders(row, "2026-10-31");
  const tenant = day1.find((plan) => plan.kind === "rent_overdue_tenant");
  assert.equal(tenant?.messages.length, 1);
  assert.equal(tenant?.linePushes?.length ?? 0, 0);
  assert.match(tenant?.messages[0].text ?? "", /周美玲/);
});

test("staff LINE reminders use the rent and lease schedule and omit personal data", () => {
  const today = "2026-10-31";
  const lineUserId = `U${"a".repeat(32)}`;
  const org = {
    orgId: "org-1",
    environment: "live",
    planTier: "beta",
    featureFlags: { line_alerts: true, line_live: true },
  };
  const recipient = { orgId: "org-1", userId: "user-1", lineUserId, prefs: {} };
  const plans = planStaffLineReminders({
    today,
    origin,
    invoices: [
      { ...org, invoiceId: "due-soon", dueDate: "2026-11-03" },
      { ...org, invoiceId: "due-today", dueDate: "2026-10-31" },
      { ...org, invoiceId: "overdue", dueDate: "2026-10-28" },
      { ...org, invoiceId: "email-day", dueDate: "2026-10-30" },
    ],
    leases: [
      { ...org, leaseId: "lease-60", endDate: "2026-12-30" },
      { ...org, leaseId: "lease-30", endDate: "2026-11-30" },
      { ...org, leaseId: "lease-7", endDate: "2026-11-07" },
    ],
    recipients: [recipient, { ...recipient, orgId: "org-2", userId: "user-2" }],
  });
  const keys = plans.map((plan) => `${plan.kind}:${plan.targetId}:${plan.threshold}`).sort();
  assert.deepEqual(keys, [
    "lease_expiry:lease-30:30",
    "lease_expiry:lease-60:60",
    "rent_due:due-soon:3",
    "rent_due:due-today:0",
    "rent_overdue:overdue:3",
  ]);
  for (const plan of plans) {
    assert.equal(plan.lineUserId, lineUserId);
    assert.equal(plan.text.includes("周美玲"), false);
    assert.equal(plan.text.includes("18,000"), false);
    assert.equal(plan.text.includes("NT$"), false);
    assert.equal(plan.text.includes("入帳"), false);
    assert.equal(plan.text.includes("府後街"), false);
    assert.match(plan.text, /^[^ ]+。 https:\/\/app\.condola\.app\/m\//);
  }
  const quiet = planStaffLineReminders({
    today,
    origin,
    invoices: [{ ...org, invoiceId: "due-soon", dueDate: "2026-11-03", featureFlags: { line_live: false } }],
    leases: [],
    recipients: [{ ...recipient, prefs: { rent_due: false } }],
  });
  assert.deepEqual(quiet, []);
  const free = planStaffLineReminders({
    today,
    origin,
    invoices: [{ ...org, planTier: "free", invoiceId: "due-today", dueDate: "2026-10-31" }],
    leases: [{ ...org, environment: "sandbox", leaseId: "lease-60", endDate: "2026-12-30" }],
    recipients: [recipient],
  });
  assert.deepEqual(free, []);
});

test("a claimed reminder is not sent twice, and a skipped send releases the claim", async () => {
  const plan: ReminderPlan = {
    orgId: "org-1",
    kind: "lease_expiry_admin",
    targetId: "lease-1",
    threshold: 60,
    messages: [{ to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>" }],
  };
  const claimed = new Set<string>();
  const messageIds: string[] = [];
  let sends = 0;
  const io = {
    async claim(item: ReminderPlan) {
      const key = `${item.kind}:${item.targetId}:${item.threshold}`;
      if (claimed.has(key)) return null;
      claimed.add(key);
      return "row-1";
    },
    async complete(_id: string, messageId: string) {
      messageIds.push(messageId);
    },
    async release(id: string) {
      claimed.delete(id);
    },
    async send(): Promise<MailResult> {
      sends += 1;
      return { ok: true, messageId: "msg_1", provider: "cloudflare" };
    },
  };
  assert.equal(await deliverReminders([plan], io), 1);
  assert.equal(await deliverReminders([plan], io), 0);
  assert.equal(sends, 1);
  assert.deepEqual(messageIds, ["msg_1"]);

  const released: string[] = [];
  assert.equal(
    await deliverReminders([plan], {
      async claim() {
        return "row-2";
      },
      async complete() {
        throw new Error("should not complete");
      },
      async release(id) {
        released.push(id);
      },
      async send() {
        return { ok: false, skipped: true, reason: "EMAIL binding missing" };
      },
    }),
    0,
  );
  assert.deepEqual(released, ["row-2"]);
});

test("LINE fallback sends the stored email, and a retry does not", async () => {
  const email = { to: "tenant@example.com", subject: "未繳租金", text: "請查看帳單", html: "<p>請查看帳單</p>" };
  const plan: ReminderPlan = {
    orgId: "org-1",
    kind: "rent_overdue_tenant",
    targetId: "inv-1",
    threshold: 1,
    messages: [],
    linePushes: [
      {
        orgId: "org-1",
        contactId: "contact-1",
        lineUserId: `U${"c".repeat(32)}`,
        kind: "rent_reminder",
        targetId: "inv-1",
        text: "【繳款提醒】您有未繳租金。請查看：https://app.condola.app/t/pay",
        email,
        environment: "live",
      },
    ],
  };
  const mailed: string[] = [];
  const completed: string[] = [];
  assert.equal(
    await deliverReminders([plan], {
      async claim() {
        return "row-line";
      },
      async complete(_id, messageId) {
        completed.push(messageId);
      },
      async release() {
        throw new Error("should not release a fallback send");
      },
      async send(message) {
        mailed.push(message.to);
        return { ok: true, messageId: "mail-1", provider: "cloudflare" };
      },
      async sendLine() {
        return { ok: false, fallback: true, reason: "not_linked" };
      },
    }),
    1,
  );
  assert.deepEqual(mailed, ["tenant@example.com"]);
  assert.deepEqual(completed, ["mail-1"]);

  const released: string[] = [];
  const sent: string[] = [];
  assert.equal(
    await deliverReminders([plan], {
      async claim() {
        return "row-wait";
      },
      async complete() {
        throw new Error("should not complete a waiting push");
      },
      async release(id) {
        released.push(id);
      },
      async send() {
        sent.push("email");
        return { ok: true, messageId: "mail-2", provider: "cloudflare" };
      },
      async sendLine() {
        return { ok: false, fallback: false, reason: "waiting" };
      },
    }),
    0,
  );
  assert.deepEqual(released, ["row-wait"]);
  assert.deepEqual(sent, []);
});

test("the cron secret check rejects a missing or wrong secret", () => {
  assert.equal(cronAuthorized(null, "secret"), false);
  assert.equal(cronAuthorized("secret", ""), false);
  assert.equal(cronAuthorized("nope", "secret"), false);
  assert.equal(cronAuthorized("secret", "secret"), true);
});
