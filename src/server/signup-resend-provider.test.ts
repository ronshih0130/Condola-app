import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Client } from "pg";
import nextHeaders from "next/headers";
import { isValidElement, type ReactElement } from "react";
import SignupVerifyPage from "@/app/signup/verify/page";
import { resendSignup, signupResendAcknowledgement, supabaseResend } from "./signup";

test("legacy resend detects provider rejection and transport failure without leaking response details", async () => {
  const auth = { url: "https://example.invalid", anon: "synthetic", service: "" };
  const calls: { url: string; body: string }[] = [];
  const accepted: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    return new Response("{}", { status: 200 });
  };
  assert.equal(await supabaseResend("synthetic@example.invalid", "http://localhost:43123", accepted, auth), true);
  assert.equal(new URL(calls[0].url).pathname, "/auth/v1/resend");
  assert.deepEqual(JSON.parse(calls[0].body), { type: "signup", email: "synthetic@example.invalid" });
  const rejected: typeof fetch = async () => new Response("synthetic private provider detail", { status: 503 });
  const failed: typeof fetch = async () => { throw new Error("synthetic transport detail"); };
  assert.equal(await supabaseResend("synthetic@example.invalid", "http://localhost:43123", rejected, auth), false);
  assert.equal(await supabaseResend("synthetic@example.invalid", "http://localhost:43123", failed, auth), false);
  assert.equal(await supabaseResend("synthetic@example.invalid", "http://localhost:43123", accepted, { ...auth, anon: "" }), false);
  assert.equal(calls.length, 1);
});

test("resend keeps unknown and confirmed users as no-ops and does not rotate on provider failure", { concurrency: false }, async () => {
  process.env.SUPABASE_URL = "https://example.invalid";
  process.env.SUPABASE_ANON_KEY = "synthetic";
  process.env.SIGNUP_MAIL_VIA = "supabase";
  let state: "pending" | "unknown" | "confirmed" = "pending";
  let mode: "accept" | "reject" | "network" = "accept";
  let calls = 0, rotations = 0;
  mock.method(Client.prototype, "connect", async () => {});
  mock.method(Client.prototype, "end", async () => {});
  mock.method(Client.prototype, "query", async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes("FROM auth.users u")) return { rows: state === "unknown" ? [] : [{ id: "synthetic-user", email_confirmed_at: state === "confirmed" ? new Date() : null, has_firm: false }] };
    if (sql.includes("UPDATE signup_verifications SET used_at")) { rotations++; return { rows: [] }; }
    throw new Error("Unexpected SQL in synthetic resend test");
  });
  mock.method(globalThis, "fetch", async () => {
    calls++;
    if (mode === "network") throw new Error("synthetic transport");
    return new Response("{}", { status: mode === "accept" ? 200 : 503 });
  });
  try {
    mode = "reject";
    assert.equal((await resendSignup("synthetic@example.invalid", "http://localhost:43123")).mail, "failed");
    assert.equal(rotations, 0);
    mode = "network";
    assert.equal((await resendSignup("synthetic@example.invalid", "http://localhost:43123")).mail, "failed");
    assert.equal(rotations, 0);
    mode = "accept";
    assert.equal((await resendSignup("synthetic@example.invalid", "http://localhost:43123")).devToken, null);
    assert.equal(rotations, 1);
    for (const next of ["unknown", "confirmed"] as const) {
      state = next;
      assert.equal((await resendSignup("synthetic@example.invalid", "http://localhost:43123")).devToken, null);
    }
    assert.equal(calls, 3);
    assert.equal(rotations, 1);
  } finally { mock.restoreAll(); }
});

test("the action acknowledgement is identical for accepted, failed, throttled, no-op and thrown outcomes", async () => {
  const expected = "/signup/verify?email=synthetic%40example.invalid&ack=1";
  const outcomes = [
    async () => ({ devToken: null }),
    async () => ({ devToken: null, mail: "failed" as const }),
    async () => ({ devToken: null, mail: "wait" as const }),
    async () => ({ devToken: "synthetic-local-token" }),
    async () => { throw new Error("synthetic failure"); },
  ];
  for (const perform of outcomes) {
    assert.equal(await signupResendAcknowledgement("synthetic@example.invalid", "http://localhost:43123", null, perform), expected);
  }
});

test("the acknowledgement page shows the same neutral message and no success or failure claim", async () => {
  mock.method(nextHeaders, "cookies", async () => ({ get: (name: string) => name === "condola_locale" ? { value: "en" } : undefined }));
  try {
    const found: ReactElement<{ children?: unknown; "data-testid"?: string }>[] = [];
    function walk(node: unknown): void {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!isValidElement<{ children?: unknown; "data-testid"?: string }>(node)) return;
      found.push(node);
      walk(node.props.children);
    }
    walk(await SignupVerifyPage({ searchParams: Promise.resolve({ email: "synthetic@example.invalid", ack: "1", mail: "failed", resent: "1" }) }));
    assert.equal(found.find((element) => element.props["data-testid"] === "verify-body")?.props.children,
      "If your signup still needs confirmation, check your inbox and spam folder for a confirmation email.");
    assert.equal(found.some((element) => element.props["data-testid"] === "signup-mail-failed"), false);
    assert.equal(found.some((element) => element.props.children === "Sent again. The previous link no longer works."), false);
  } finally { mock.restoreAll(); }
});
