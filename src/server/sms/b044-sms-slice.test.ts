import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { dailyCap, normalizeE164, numberKey } from "./guards";
import {
  requestSmsOtp,
  type SmsAuditRow,
  type SmsLedger,
  type SmsLedgerTransaction,
  type SmsOtpDeps,
  type SmsOtpRefusal,
  type SmsOtpRequest,
} from "./request-otp";
import { createCaptureTransport, createTwilioVerifyTransport, isApproved, type SmsTransport } from "./transport";

const TO = "+12025550123";
const OTHER = "+12025550188";
const ORG = "7a33b31c-e615-42f1-b191-0776004a0044";
const SECRET = "b044-test-number-key-secret-00001";
const NOW = Date.parse("2026-11-19T20:00:00Z");
const PACIFIC_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles" });
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

type Counts = Awaited<ReturnType<SmsLedgerTransaction["counts"]>>;
type Env = SmsOtpDeps["env"];
type Recorded = { row: SmsAuditRow; at: number };

function fixture(options: {
  env?: Env;
  counts?: Partial<Counts>;
  flag?: SmsOtpDeps["flagOn"];
  defaultTransport?: boolean;
  mode?: SmsTransport["mode"];
  start?: SmsTransport["startVerification"];
  failCommit?: boolean;
  failOutcome?: boolean;
} = {}) {
  const rows: SmsAuditRow[] = [];
  const recorded: Recorded[] = [];
  const calls = { flag: 0, lock: 0, counts: 0, transport: 0 };
  let instant = NOW;
  let queue = Promise.resolve();

  function commit(entry: Recorded) {
    recorded.push(entry);
    rows.push(entry.row);
  }

  const ledger: SmsLedger = {
    async withLock<T>(fn: (tx: SmsLedgerTransaction) => Promise<T>): Promise<T> {
      calls.lock++;
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const staged: Recorded[] = [];
      try {
        const result = await fn({
          async counts(q) {
            calls.counts++;
            const now = (deps.now ?? Date.now)();
            const attempts = recorded.filter(({ row }) => row.event === "sms_otp_attempt");
            const byNumber = attempts.filter(({ row }) => row.numberKey === q.numberKey);
            const inHour = ({ at }: Recorded) => at >= now - 3_600_000;
            const last = byNumber.reduce<number | null>(
              (latest, { at }) => latest === null ? at : Math.max(latest, at), null,
            );
            const today = PACIFIC_DATE.format(now);
            return {
              numberHour: byNumber.filter(inHour).length,
              numberDay: byNumber.filter(({ at }) => at >= now - 86_400_000).length,
              ipHour: attempts.filter((entry) => entry.row.ip === q.ip && inHour(entry)).length,
              deviceHour: attempts.filter((entry) => entry.row.deviceKey === q.deviceKey && inHour(entry)).length,
              secondsSinceLastToNumber: last === null ? null : (now - last) / 1000,
              providerSendsToday: attempts.filter(({ at }) => PACIFIC_DATE.format(at) === today).length,
              ...options.counts,
            };
          },
          async insert(row) {
            staged.push({ row, at: (deps.now ?? Date.now)() });
          },
        });
        if (options.failCommit) throw new Error("fixture_commit_failed");
        for (const entry of staged) commit(entry);
        return result;
      } finally {
        release();
      }
    },
  };

  const mode = options.mode ?? "capture";
  const transport: SmsTransport = {
    mode,
    provider: mode === "live" ? "twilio_verify" : "capture",
    async startVerification(input) {
      calls.transport++;
      assert.ok(rows.some((row) => row.event === "sms_otp_attempt" && row.numberKey === numberKey(input.to, SECRET)),
        "transport must see a committed attempt");
      if (options.start) return options.start(input);
      return { status: mode === "live" ? "pending" : "captured", providerRef: null };
    },
    async checkVerification() {
      return { status: "captured" };
    },
  };
  const deps: SmsOtpDeps = {
    env: { SMS_DEST_ALLOWLIST: TO, SMS_NUMBER_KEY_SECRET: SECRET, ...options.env },
    async flagOn(orgId) {
      calls.flag++;
      return options.flag ? options.flag(orgId) : true;
    },
    ledger,
    ...(options.defaultTransport ? {} : { transport }),
    async audit(row) {
      assert.notEqual(row.event, "sms_otp_attempt");
      if (options.failOutcome && row.event !== "sms_otp_refused") throw new Error("fixture_outcome_failed");
      commit({ row, at: (deps.now ?? Date.now)() });
    },
    now: () => instant,
  };
  return {
    rows,
    calls,
    advance(ms: number) {
      instant += ms;
    },
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

test("B044-US-G1 (B044-AC-P3/P8) purpose is exact and checked before parsing the destination", async () => {
  for (const purpose of ["unknown-purpose", undefined, "contract_signing_otp", "SIGNUP_VERIFICATION", "signup_verification "]) {
    const f = fixture();
    const row = await expectRefusal(f, "purpose_not_allowed", { purpose });
    assert.equal(row.purpose, purpose === "contract_signing_otp" ? purpose : "unknown");
    assert.equal(row.toMasked, null);
    assert.equal(row.numberKey, null);
    assert.equal(f.calls.flag, 0);
  }
});

test("B044-US-G2 E.164 and +1 shape refusals do not record a number key", async () => {
  for (const to of [TO.slice(1), "+1 202 555 0123", ""]) {
    const f = fixture();
    const row = await expectRefusal(f, "invalid_e164", { to });
    assert.equal(row.toMasked, null);
    assert.equal(row.numberKey, null);
    assert.equal(f.calls.flag, 0);
  }
  for (const to of ["+445550123", "+10555550123"]) {
    const f = fixture();
    const row = await expectRefusal(f, "country_not_in_slice", { to });
    assert.ok(row.toMasked?.includes("•"));
    assert.equal(row.numberKey, null);
    assert.ok(!JSON.stringify(row).includes(to));
    assert.equal(f.calls.flag, 0);
  }
});

test("B044-US-G3 allowlist refuses missing, malformed, and unlisted destinations before the secret check", async () => {
  const cases: [string | undefined, SmsOtpRefusal][] = [
    [undefined, "dest_allowlist_missing"],
    ["", "dest_allowlist_missing"],
    [" , ", "dest_allowlist_missing"],
    [`${TO},invalid`, "dest_allowlist_invalid"],
    [`${TO},`, "dest_allowlist_invalid"],
    [OTHER, "dest_not_allowlisted"],
  ];
  for (const [SMS_DEST_ALLOWLIST, reason] of cases) {
    const f = fixture({ env: { SMS_DEST_ALLOWLIST, SMS_NUMBER_KEY_SECRET: undefined } });
    const row = await expectRefusal(f, reason);
    assert.equal(row.numberKey, null);
    assert.equal(row.deviceKey, null);
    assert.equal(f.calls.flag, 0);
    assert.equal(f.calls.lock, 0);
  }
});

test("B044-US-G3b the secret is required after the allowlist and before org validation in all modes", async () => {
  for (const SMS_TRANSPORT_MODE of [undefined, "capture", "live"]) {
    for (const SMS_NUMBER_KEY_SECRET of [undefined, "", "x".repeat(31), " ".repeat(32)]) {
      const f = fixture({ env: { SMS_TRANSPORT_MODE, SMS_NUMBER_KEY_SECRET } });
      const row = await expectRefusal(f, "number_key_secret_missing", { orgId: null });
      assert.equal(row.numberKey, null);
      assert.equal(row.deviceKey, null);
      assert.equal(f.calls.flag, 0);
      assert.equal(f.calls.lock, 0);
    }
  }
});

test("B044-US-G4 missing org and disabled or unavailable flag refuse before rate checks", async () => {
  for (const orgId of [null, "not-a-uuid"]) {
    const f = fixture({ flag: async () => false });
    await expectRefusal(f, "org_missing", { orgId, ip: null });
    assert.equal(f.calls.flag, 0);
    assert.equal(f.calls.lock, 0);
  }
  for (const flag of [async () => false, async () => { throw new Error("flag unavailable"); }]) {
    const f = fixture({ flag });
    await expectRefusal(f, "flag_off", { ip: null });
    assert.equal(f.calls.flag, 1);
    assert.equal(f.calls.lock, 0);
  }
});

test("B044-US-G5a missing or malformed IP refuses inside the lock before the cap", async () => {
  for (const ip of [null, "", " ", "client.example", "192.0.2.256", "192.0.2.10:80", "[2001:db8::1]", "2001:::1"]) {
    const f = fixture({ counts: { providerSendsToday: 5 } });
    const row = await expectRefusal(f, "rate_context_missing", { ip });
    assert.equal(row.ip, null);
    assert.equal(f.calls.lock, 1);
    assert.equal(f.calls.counts, 0);
  }
  const f = fixture();
  assert.equal((await f.run({ ip: "2001:db8::1" })).ok, true);
  assert.equal(f.rows[0]?.ip, "2001:db8::1");
});

test("B044-US-G5 (B044-AC-P10) resend and each of the four rate ceilings refuse before the cap", async () => {
  const cases: [Partial<Counts>, SmsOtpRefusal][] = [
    [{ secondsSinceLastToNumber: 44.999 }, "rate_resend_wait"],
    [{ numberHour: 3 }, "rate_number_hour"],
    [{ numberDay: 5 }, "rate_number_day"],
    [{ ipHour: 10 }, "rate_ip_hour"],
    [{ deviceHour: 5 }, "rate_device_hour"],
  ];
  for (const [counts, reason] of cases) {
    const f = fixture({ counts: { ...counts, providerSendsToday: 5 } });
    await expectRefusal(f, reason);
    assert.equal(f.calls.lock, 1);
    assert.equal(f.calls.counts, 1);
  }

  const f = fixture();
  assert.deepEqual(await f.run(), { ok: true, status: "captured", mode: "capture" });
  f.advance(44_999);
  assert.deepEqual(await f.run(), { ok: false, reason: "rate_resend_wait" });
  assert.equal(f.calls.transport, 1);
  f.advance(1);
  assert.equal((await f.run()).ok, true);
  assert.equal(f.calls.transport, 2);
});

test("B044-US-G5b device-less requests share one device bucket across numbers and IPs", async () => {
  const numbers = Array.from({ length: 6 }, (_, i) => `+1202555012${i}`);
  const f = fixture({ env: { SMS_DEST_ALLOWLIST: numbers.join(",") } });
  for (const [i, to] of numbers.entries()) {
    const result = await f.run({ to, ip: `192.0.2.${i + 1}`, deviceId: null });
    if (i < 5) assert.equal(result.ok, true);
    else assert.deepEqual(result, { ok: false, reason: "rate_device_hour" });
  }
  assert.equal(f.calls.transport, 5);
  assert.ok(f.rows.every((row) => row.deviceKey === "smsd_none"));
});

test("B044-US-G6 daily cap can only be lowered and refuses without a transport call", async () => {
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
});

test("B044-US-G6b a concurrent request sees the reservation while the first transport is still running", {
  timeout: 2_000,
}, async () => {
  let markStarted!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const waitForFinish = new Promise<void>((resolve) => { finish = resolve; });
  const f = fixture({
    env: { SMS_DAILY_SEND_CAP: "1", SMS_DEST_ALLOWLIST: `${TO},${OTHER}` },
    async start() {
      markStarted();
      await waitForFinish;
      return { status: "captured", providerRef: null };
    },
  });

  const first = f.run();
  try {
    await Promise.race([started, first]);
    assert.deepEqual(f.rows.map((row) => row.event), ["sms_otp_attempt"]);
    assert.deepEqual(await f.run({ to: OTHER }), { ok: false, reason: "daily_cost_cap" });
    assert.equal(f.calls.transport, 1);
  } finally {
    finish();
    await first;
  }
  assert.deepEqual(f.rows.map((row) => row.event), ["sms_otp_attempt", "sms_otp_refused", "sms_otp_captured"]);
});

test("B044-US-G6c (review r1 B2) five throwing live attempts exhaust the cap; the sixth does not call the provider", async () => {
  const numbers = Array.from({ length: 6 }, (_, i) => `+1202555013${i}`);
  const f = fixture({
    env: { SMS_DEST_ALLOWLIST: numbers.join(",") },
    mode: "live",
    async start({ to }) {
      throw new Error(`provider failed for ${to}`);
    },
  });
  for (const [i, to] of numbers.entries()) {
    const result = await f.run({ to, deviceId: `fixture-device-${i}` });
    assert.deepEqual(result, { ok: false, reason: i < 5 ? "provider_error" : "daily_cost_cap" });
    assert.equal(f.calls.transport, Math.min(i + 1, 5));
    assert.ok(!JSON.stringify({ result, rows: f.rows }).includes(to));
  }
  assert.equal(f.rows.filter((row) => row.event === "sms_otp_attempt").length, 5);
  assert.equal(f.rows.filter((row) => row.event === "sms_otp_provider_error" && row.reason === "provider_error").length, 5);
});

test("B044-US-G6d a reservation commit failure never calls transport", async () => {
  const f = fixture({ mode: "live", failCommit: true });
  await assert.rejects(f.run(), { message: "fixture_commit_failed" });
  assert.equal(f.calls.transport, 0);
  assert.deepEqual(f.rows, []);
});

test("B044-US-G6e an outcome-write failure leaves the committed attempt counting toward the cap", async () => {
  const f = fixture({
    mode: "live",
    failOutcome: true,
    env: { SMS_DAILY_SEND_CAP: "1", SMS_DEST_ALLOWLIST: `${TO},${OTHER}` },
  });
  await assert.rejects(f.run(), { message: "fixture_outcome_failed" });
  assert.deepEqual(f.rows.map((row) => row.event), ["sms_otp_attempt"]);
  assert.deepEqual(await f.run({ to: OTHER }), { ok: false, reason: "daily_cost_cap" });
  assert.equal(f.calls.transport, 1);
});

test("B044-US-MASK (review r1 B1) number keys match HMAC-SHA256 and change with the secret; audit stores no raw identifiers or unkeyed digest", async () => {
  const to = normalizeE164(TO);
  assert.ok(to);
  const expected = "smsn_" + createHmac("sha256", SECRET).update(TO).digest("hex").slice(0, 32);
  assert.equal(numberKey(to, SECRET), expected);
  assert.notEqual(numberKey(to, "x".repeat(32)), expected);

  const f = fixture();
  const rawDeviceId = `device:${TO}`;
  assert.equal((await f.run({ deviceId: rawDeviceId, requestId: `req-${TO.slice(1)}` })).ok, true);
  const expectedDevice = "smsd_" + createHmac("sha256", SECRET)
    .update(`device:${rawDeviceId}`).digest("hex").slice(0, 32);
  assert.equal(f.rows.length, 2);
  for (const row of f.rows) {
    assert.equal(row.numberKey, expected);
    assert.equal(row.deviceKey, expectedDevice);
    assert.equal(row.requestId, null);
    assert.equal(row.toMasked, "+1••••••••23");
  }
  const serialized = JSON.stringify(f.rows);
  assert.ok(!serialized.includes(TO));
  assert.ok(!serialized.includes(rawDeviceId));
  for (const value of [TO, `condola-sms-v1:${TO}`]) {
    const unkeyed = createHash("sha256").update(value).digest("hex");
    assert.ok(!serialized.includes(unkeyed.slice(0, 32)));
  }
});

test("B044-US-MASK2 request IDs are retained only when bounded, allowlisted, and free of long digit runs", async () => {
  for (const requestId of [null, "", "has space", "line\n", "x".repeat(81), "req:1234567", TO]) {
    const row = await expectRefusal(fixture(), "invalid_e164", { to: "", requestId });
    assert.equal(row.requestId, null);
  }
  for (const requestId of ["req:A_123456.b-7", "x".repeat(80)]) {
    const row = await expectRefusal(fixture(), "invalid_e164", { to: "", requestId });
    assert.equal(row.requestId, requestId);
  }
});

test("B044-US-CAPTURE (B044-AC-P1) unset and wrong-case modes capture, and only attempts affect subsequent counts", async () => {
  for (const SMS_TRANSPORT_MODE of [undefined, "LIVE"]) {
    const f = fixture({
      defaultTransport: true,
      env: { SMS_TRANSPORT_MODE, SMS_DAILY_SEND_CAP: "2", SMS_DEST_ALLOWLIST: ` ${OTHER} , ${TO} , ${TO} ` },
    });
    assert.deepEqual(await f.run(), { ok: true, status: "captured", mode: "capture" });
    assert.deepEqual(f.rows.map((row) => row.event), ["sms_otp_attempt", "sms_otp_captured"]);
    assert.ok(f.rows.every((row) => row.mode === "capture"));
    assert.deepEqual(await f.run(), { ok: false, reason: "rate_resend_wait" });
    assert.equal((await f.run({ to: OTHER })).ok, true);
    assert.equal(networkCalls, 0);
  }
});

test("B044-US-LIVE-CONFIG exact live mode with missing credentials fails closed without reserving an attempt", async () => {
  const f = fixture({ defaultTransport: true, env: { SMS_TRANSPORT_MODE: "live" } });
  await expectRefusal(f, "live_config_missing");
  assert.equal(networkCalls, 0);
});

test("B044-US-CHECK capture check returns captured, never approval", async () => {
  const to = normalizeE164(TO);
  assert.ok(to);
  const result = await createCaptureTransport().checkVerification({
    to, purpose: "signup_verification", code: "012345",
  });
  assert.deepEqual(result, { status: "captured" });
  assert.equal(isApproved(result), false);
  assert.equal(isApproved({ status: "rejected" }), false);
  assert.equal(isApproved({ status: "approved" }), true);
});

test("B044-US-TWILIO (review r1 B3) Twilio posts Verify forms with manual redirects and sanitizes HTTP errors", async () => {
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
  assert.equal(first?.init?.redirect, "manual");
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

  response = () => new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } });
  const beforeRedirect = calls.length;
  await assert.rejects(transport.startVerification(start), { message: "twilio_verify_http_302" });
  assert.equal(calls.length, beforeRedirect + 1);
  assert.equal(calls.at(-1)?.init?.redirect, "manual");

  response = () => Response.error();
  await assert.rejects(transport.startVerification(start), { message: "twilio_verify_http_0" });

  response = () => new Response(`${TO} ${authToken}`, { status: 429 });
  await assert.rejects(transport.startVerification(start), { message: "twilio_verify_http_429" });

  const check = { ...start, code: "012345" };
  for (const [status, expected] of [["approved", "approved"], ["pending", "rejected"], ["APPROVED", "rejected"]]) {
    response = () => Response.json({ status });
    assert.deepEqual(await transport.checkVerification(check), { status: expected });
  }

  response = () => new Response(null, { status: 404 });
  await assert.rejects(transport.startVerification(start), { message: "twilio_verify_http_404" });
  assert.deepEqual(await transport.checkVerification(check), { status: "rejected" });
  response = () => new Response(null, { status: 500 });
  await assert.rejects(transport.checkVerification(check), { message: "twilio_verify_http_500" });

  const last = calls.at(-1);
  assert.equal(last?.url, `${base}/VerificationCheck`);
  assert.equal(last?.init?.method, "POST");
  assert.equal(last?.init?.redirect, "manual");
  const checkBody = last?.init?.body;
  assert.ok(checkBody instanceof URLSearchParams);
  assert.equal(checkBody.get("To"), TO);
  assert.equal(checkBody.get("Code"), "012345");
});
