import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dailyCap, normalizeE164 } from "./guards";
import {
  requestSmsOtp,
  type SmsAuditRow,
  type SmsLedger,
  type SmsOtpDeps,
  type SmsOtpRefusal,
  type SmsOtpRequest,
} from "./request-otp";
import { createTwilioVerifyTransport, type SmsTransport } from "./transport";

const TO = "+12025550123";
const OTHER = "+12025550188";
const ORG = "7a33b31c-e615-42f1-b191-0776004a0044";
const NOW = Date.parse("2026-11-19T20:00:00Z");
const originalFetch = globalThis.fetch;
let networkCalls = 0;

before(() => {
  globalThis.fetch = () => {
    networkCalls++;
    throw new Error("network forbidden");
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkCalls, 0, "no test may attempt to use global fetch");
});

type Counts = Awaited<ReturnType<SmsLedger["counts"]>>;
type Env = SmsOtpDeps["env"];

function fixture(options: {
  env?: Env;
  counts?: Partial<Counts>;
  flag?: SmsOtpDeps["flagOn"];
  defaultTransport?: boolean;
  start?: SmsTransport["startVerification"];
} = {}) {
  const rows: SmsAuditRow[] = [];
  const recorded: { row: SmsAuditRow; at: number }[] = [];
  const calls = { flag: 0, lock: 0, counts: 0, transport: 0 };
  let locked = false;
  let queue = Promise.resolve();
  const ledger: SmsLedger = {
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      calls.lock++;
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
        release();
      }
    },
    async counts(q) {
      assert.equal(locked, true);
      calls.counts++;
      const attempts = recorded.filter(({ row }) => row.event !== "sms_otp_refused");
      const byNumber = attempts.filter(({ row }) => row.numberKey === q.numberKey);
      const inHour = ({ at }: { at: number }) => at >= q.now - 3_600_000;
      return {
        numberHour: byNumber.filter(inHour).length,
        numberDay: byNumber.filter(({ at }) => at >= q.now - 86_400_000).length,
        ipHour: attempts.filter((entry) => q.ip !== null && entry.row.ip === q.ip && inHour(entry)).length,
        deviceHour: attempts.filter((entry) =>
          q.deviceId !== null && entry.row.deviceId === q.deviceId && inHour(entry)).length,
        lastToNumberAt: byNumber.reduce<number | null>(
          (latest, { at }) => latest === null ? at : Math.max(latest, at), null,
        ),
        // The fixture clock is fixed; all recorded rows are on the same Pacific day.
        providerSendsToday: attempts.filter(({ row }) =>
          row.event === "sms_otp_captured" || row.event === "sms_otp_sent").length,
        ...options.counts,
      };
    },
  };
  const transport: SmsTransport = {
    mode: "capture",
    provider: "capture",
    async startVerification(input) {
      assert.equal(locked, true);
      calls.transport++;
      if (options.start) return options.start(input);
      return { status: "captured", providerRef: null };
    },
    async checkVerification() {
      return { status: "captured" };
    },
  };
  const deps: SmsOtpDeps = {
    env: { SMS_DEST_ALLOWLIST: TO, ...options.env },
    async flagOn(orgId) {
      calls.flag++;
      return options.flag ? options.flag(orgId) : true;
    },
    ledger,
    ...(options.defaultTransport ? {} : { transport }),
    async audit(row) {
      if (row.event !== "sms_otp_refused") assert.equal(locked, true);
      rows.push(row);
      recorded.push({ row, at: NOW });
    },
    now: () => NOW,
  };
  return {
    rows,
    calls,
    run(input: Partial<SmsOtpRequest> = {}) {
      return requestSmsOtp({
        purpose: "signup_verification", to: TO, orgId: ORG,
        ip: "192.0.2.10", deviceId: "fixture-device", ...input,
      }, deps);
    },
  };
}

async function expectRefusal(f: ReturnType<typeof fixture>, reason: SmsOtpRefusal, input?: Partial<SmsOtpRequest>) {
  assert.deepEqual(await f.run(input), { ok: false, reason });
  assert.equal(f.calls.transport, 0);
  assert.equal(f.rows.length, 1);
  const row = f.rows[0];
  assert.ok(row);
  assert.equal(row.event, "sms_otp_refused");
  assert.equal(row.reason, reason);
  assert.ok(!JSON.stringify(row).includes(TO));
  return row;
}

test("B044-US-G1 purpose is exact and checked before parsing the destination", async () => {
  for (const purpose of ["unknown-purpose", undefined, "contract_signing_otp", "SIGNUP_VERIFICATION", "signup_verification "]) {
    const f = fixture();
    const row = await expectRefusal(f, "purpose_not_allowed", { purpose });
    assert.equal(row.purpose, purpose === "contract_signing_otp" ? purpose : "unknown");
    assert.equal(row.toMasked, null);
    assert.equal(row.numberKey, null);
    assert.equal(f.calls.flag, 0);
  }
});

test("B044-US-G2 E.164 and NANP shape are checked before the flag or transport", async () => {
  for (const to of ["5551234567", "+1 555 123 4567", "+0123", ""]) {
    const row = await expectRefusal(fixture(), "invalid_e164", { to });
    assert.equal(row.toMasked, null);
    assert.equal(row.numberKey, null);
  }
  for (const to of ["+886912345678", "+11234567890"]) {
    const f = fixture();
    const row = await expectRefusal(f, "country_not_in_slice", { to });
    assert.ok(row.toMasked?.includes("•"));
    assert.ok(!JSON.stringify(row).includes(to));
    assert.equal(f.calls.flag, 0);
  }
});

test("B044-US-G3 allowlist fails closed for missing, malformed, or absent destinations", async () => {
  for (const SMS_DEST_ALLOWLIST of [undefined, "", " , "]) {
    await expectRefusal(fixture({ env: { SMS_DEST_ALLOWLIST } }), "dest_allowlist_missing");
  }
  for (const SMS_DEST_ALLOWLIST of [`${TO},invalid`, `${TO},`]) {
    await expectRefusal(fixture({ env: { SMS_DEST_ALLOWLIST } }), "dest_allowlist_invalid");
  }
  await expectRefusal(fixture({ env: { SMS_DEST_ALLOWLIST: OTHER } }), "dest_not_allowlisted");
});

test("B044-US-G4 org and flag fail closed, and the flag is not consulted after earlier refusal", async () => {
  for (const orgId of [null, "not-a-uuid"]) {
    const f = fixture();
    await expectRefusal(f, "org_missing", { orgId });
    assert.equal(f.calls.flag, 0);
  }
  for (const flag of [async () => false, async () => { throw new Error("flag unavailable"); }]) {
    const f = fixture({ flag });
    await expectRefusal(f, "flag_off");
    assert.equal(f.calls.flag, 1);
    assert.equal(f.calls.lock, 0);
  }
  const f = fixture();
  await expectRefusal(f, "invalid_e164", { to: "" });
  assert.equal(f.calls.flag, 0);
});

test("B044-US-G5 resend and all four rate ceilings refuse at their boundaries", async () => {
  const cases: [Partial<Counts>, SmsOtpRefusal][] = [
    [{ lastToNumberAt: NOW - 10_000 }, "rate_resend_wait"],
    [{ numberHour: 3 }, "rate_number_hour"],
    [{ numberDay: 5 }, "rate_number_day"],
    [{ ipHour: 10 }, "rate_ip_hour"],
    [{ deviceHour: 5 }, "rate_device_hour"],
  ];
  for (const [counts, reason] of cases) {
    await expectRefusal(fixture({ counts }), reason);
  }
  const f = fixture({ counts: { numberHour: 2, lastToNumberAt: NOW - 45_000 } });
  assert.deepEqual(await f.run(), { ok: true, status: "captured", mode: "capture" });
  assert.equal(f.calls.transport, 1);
});

test("B044-US-G6 daily cap can only be lowered and counts concurrent captures", async () => {
  for (const [value, cap] of [[undefined, 5], ["50", 5], ["2", 2], ["abc", 5], ["0", 0]] as const) {
    const env = { SMS_DAILY_SEND_CAP: value };
    assert.equal(dailyCap(env), cap);
    await expectRefusal(fixture({ env, counts: { providerSendsToday: cap } }), "daily_cost_cap");
    if (cap > 0) {
      assert.equal((await fixture({ env, counts: { providerSendsToday: cap - 1 } }).run()).ok, true);
    }
  }
  for (const value of [" 2", "2\n", "+2", "2.0", "-1", "2e0"]) {
    assert.equal(dailyCap({ SMS_DAILY_SEND_CAP: value }), 5);
  }
  const f = fixture({
    env: { SMS_DAILY_SEND_CAP: "1", SMS_DEST_ALLOWLIST: `${TO},${OTHER}` },
    defaultTransport: true,
  });
  const results = await Promise.all([f.run(), f.run({ to: OTHER })]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.find((result) => !result.ok), { ok: false, reason: "daily_cost_cap" });
  assert.equal(f.rows.filter((row) => row.event === "sms_otp_captured").length, 1);
});

test("B044-US-ORDER purpose precedes allowlist, allowlist precedes flag, and rate precedes cap", async () => {
  const options = { env: { SMS_DEST_ALLOWLIST: undefined }, flag: async () => false };
  const purpose = fixture(options);
  await expectRefusal(purpose, "purpose_not_allowed", { purpose: "tenant_invite" });
  assert.equal(purpose.calls.flag, 0);

  const allowlist = fixture(options);
  await expectRefusal(allowlist, "dest_allowlist_missing");
  assert.equal(allowlist.calls.flag, 0);

  await expectRefusal(fixture({
    counts: { numberHour: 3, providerSendsToday: 5 },
  }), "rate_number_hour");
});

test("B044-US-CAPTURE unset and wrong-case modes capture without network or a raw destination in audit", async () => {
  for (const SMS_TRANSPORT_MODE of [undefined, "LIVE"]) {
    const f = fixture({
      defaultTransport: true,
      env: { SMS_TRANSPORT_MODE, SMS_DEST_ALLOWLIST: ` ${OTHER} , ${TO} , ${TO} ` },
    });
    assert.deepEqual(await f.run(), { ok: true, status: "captured", mode: "capture" });
    assert.equal(f.rows.length, 1);
    const row = f.rows[0];
    assert.ok(row);
    assert.equal(row.event, "sms_otp_captured");
    assert.equal(row.toMasked, "+1••••••••23");
    assert.match(row.numberKey ?? "", /^smsn_[0-9a-f]{32}$/);
    assert.equal(row.mode, "capture");
    assert.ok(!JSON.stringify(row).includes(TO));
    assert.deepEqual(await f.run(), { ok: false, reason: "rate_resend_wait" });
    assert.equal(networkCalls, 0);
  }
});

test("B044-US-LIVE-CONFIG exact live mode with missing credentials fails closed", async () => {
  const f = fixture({ defaultTransport: true, env: { SMS_TRANSPORT_MODE: "live" } });
  await expectRefusal(f, "live_config_missing");
  assert.equal(networkCalls, 0);
});

test("B044-US-TWILIO adapter posts Verify forms and sanitizes HTTP errors", async () => {
  const accountSid = "AC_fake";
  const authToken = "fixture-secret";
  const serviceSid = "VA_fake";
  const base = `https://verify.twilio.com/v2/Services/${serviceSid}`;
  const calls: { url: string; init?: RequestInit }[] = [];
  let response = () => Response.json({ sid: "VE_fake", status: "pending" });
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return response();
  };
  const transport = createTwilioVerifyTransport({ accountSid, authToken, serviceSid, fetchImpl });
  const to = normalizeE164(TO);
  assert.ok(to);
  const start = { to, purpose: "signup_verification" } as const;

  assert.deepEqual(await transport.startVerification({ ...start, locale: "en" }), {
    status: "pending", providerRef: "VE_fake",
  });
  const first = calls[0];
  assert.equal(first?.url, `${base}/Verifications`);
  assert.equal(first?.init?.method, "POST");
  assert.ok(first?.init?.signal instanceof AbortSignal);
  assert.equal(new Headers(first?.init?.headers).get("Authorization"), `Basic ${btoa(`${accountSid}:${authToken}`)}`);
  const body = first?.init?.body;
  assert.ok(body instanceof URLSearchParams);
  assert.equal(body.get("To"), TO);
  assert.equal(body.get("Channel"), "sms");
  assert.equal(body.get("Locale"), "en");

  await transport.startVerification({ ...start, locale: "zh-TW" });
  const taiwanBody = calls[1]?.init?.body;
  assert.ok(taiwanBody instanceof URLSearchParams);
  assert.equal(taiwanBody.has("Locale"), false);

  response = () => new Response(`${TO} ${authToken}`, { status: 429 });
  await assert.rejects(transport.startVerification(start), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "twilio_verify_http_429");
    assert.ok(!error.message.includes(authToken) && !error.message.includes(TO));
    return true;
  });

  const check = { ...start, code: "012345" };
  for (const [status, expected] of [["approved", "approved"], ["pending", "rejected"], ["APPROVED", "rejected"]]) {
    response = () => Response.json({ status });
    assert.deepEqual(await transport.checkVerification(check), { status: expected });
  }
  const last = calls.at(-1);
  assert.equal(last?.url, `${base}/VerificationCheck`);
  assert.equal(last?.init?.method, "POST");
  const checkBody = last?.init?.body;
  assert.ok(checkBody instanceof URLSearchParams);
  assert.equal(checkBody.get("To"), TO);
  assert.equal(checkBody.get("Code"), "012345");
});

test("B044-US-PROVIDER-ERROR provider details never escape into the result or audit", async () => {
  const f = fixture({ start: async () => { throw new Error(`provider failed for ${TO}`); } });
  const result = await f.run();
  assert.deepEqual(result, { ok: false, reason: "provider_error" });
  assert.equal(f.calls.transport, 1);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0]?.event, "sms_otp_provider_error");
  assert.equal(f.rows[0]?.reason, "provider_error");
  assert.ok(!JSON.stringify({ result, rows: f.rows }).includes(TO));
});
