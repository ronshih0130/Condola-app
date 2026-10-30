import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PRIVACY_VERSION, signupConsentMetadata, signupRequestBody, TERMS_VERSION } from "./legal-versions";
import { startSignup } from "./signup";

const meta = { ua: "signup-consent", ip: "127.0.0.1" };

test("legal page effective dates are the signup consent versions", () => {
  const terms = readFileSync(new URL("../../content/legal/terms.md", import.meta.url), "utf8");
  const privacy = readFileSync(new URL("../../content/legal/privacy.md", import.meta.url), "utf8");
  assert.equal(terms.match(/^- 生效日期：(.+)$/m)?.[1], TERMS_VERSION);
  assert.equal(privacy.match(/^- 生效日期：(.+)$/m)?.[1], PRIVACY_VERSION);
  assert.equal(TERMS_VERSION, "2026-10-22");
  assert.match(PRIVACY_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(PRIVACY_VERSION > "2026-10-27", "privacy v2.1 must be newer than v2 (2026-10-27)");
});

test("the signUp payload carries terms_accepted_at and both versions", () => {
  const acceptedAt = new Date("2026-10-25T07:00:00.000Z");
  const metadata = signupConsentMetadata(acceptedAt);
  const body = signupRequestBody("owner@example.com", "Fresh1234", metadata);
  assert.equal(body.email, "owner@example.com");
  assert.equal(body.data.terms_accepted_at, "2026-10-25T07:00:00.000Z");
  assert.equal(body.data.terms_version, TERMS_VERSION);
  assert.equal(body.data.privacy_version, PRIVACY_VERSION);
  assert.deepEqual(body.options.data, body.data);
  assert.equal(Object.hasOwn(body.data, "password"), false);
});

test("startSignup rejects a missing consent flag before auth or the database", async () => {
  const calls: string[] = [];
  const saved = global.fetch;
  global.fetch = async (input) => {
    calls.push(String(input));
    throw new Error("fetch should not run");
  };
  try {
    for (const consent of [false, undefined] as const) {
      const result = await startSignup({
        email: "owner@example.com",
        password: "Fresh1234",
        confirm: "Fresh1234",
        partnerCode: "",
        origin: "http://127.0.0.1:43123",
        meta,
        consent,
      });
      assert.deepEqual(result, { ok: false, error: "consent" });
    }
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = saved;
  }
});

test("signup posts consent metadata and the form refuses to continue without it", () => {
  const signup = readFileSync(new URL("./signup.ts", import.meta.url), "utf8");
  const remote = signup.slice(signup.indexOf("async function supabaseSignUp"), signup.indexOf("async function supabaseResend"));
  assert.match(remote, /signupRequestBody\(email, password, metadata\)/);
  const start = signup.slice(signup.indexOf("export async function startSignup"), signup.indexOf("export async function resendSignup"));
  assert.match(start, /input\.consent !== true/);
  assert.match(start, /signupConsentMetadata\(acceptedAt\)/);
  assert.match(start, /supabaseSignUp\(email, input\.password, input\.origin, metadata\)/);
  const insertAt = start.indexOf("INSERT INTO auth.users");
  assert.ok(insertAt > 0);
  assert.match(start.slice(insertAt, insertAt + 500), /raw_user_meta_data/);
  assert.match(start.slice(insertAt, insertAt + 700), /JSON\.stringify\(metadata\)/);

  const form = readFileSync(new URL("../components/signup-form.tsx", import.meta.url), "utf8");
  const checkbox = readFileSync(new URL("../components/consent-check.tsx", import.meta.url), "utf8");
  assert.match(form, /LegalConsentCheckbox/);
  assert.match(form, /disabled=\{!agreed\}/);
  assert.match(checkbox, /name="consent"/);
  assert.match(checkbox, /href="\/terms"/);
  assert.match(checkbox, /href="\/privacy"/);
  assert.match(checkbox, /target="_blank"/);
  const actions = readFileSync(new URL("./signup-actions.ts", import.meta.url), "utf8");
  assert.match(actions, /formData\.get\("consent"\) === "on"/);
  assert.match(actions, /consent: formData\.get\("consent"\) === "on"/);
});
