import assert from "node:assert/strict";
import test from "node:test";
import { createLineCodeExchange } from "./oauth-exchange";
import { LineError } from "./login-token";
import type { SecretResolver } from "./webhook";

const input = {
  code: "auth-code-xyz-123",
  verifier: "pkce-code-verifier",
  redirectUri: "https://app.condola.app/api/line/login/callback",
  channelId: "login-channel",
  secretRef: "line-login",
};
const resolveSecret = async () => ({ secret: "top-secret-value", identityPepper: "pepper", destination: "dest" });

function jsonResponse(body: unknown, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function assertUnavailable(fetchImpl: typeof fetch, resolver: SecretResolver = resolveSecret) {
  const exchange = createLineCodeExchange({ fetch: fetchImpl, resolveSecret: resolver });
  await assert.rejects(exchange(input), err => err instanceof LineError && err.status === 503 && err.code === "line_unavailable");
}

test("posts the code and PKCE verifier to the LINE token endpoint and returns id_token", async () => {
  type CapturedInit = { method: string; headers: Record<string, string>; body: string; cache: string; redirect: string };
  let captured: { url: string; init: CapturedInit } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => { captured = { url: String(url), init: init as unknown as CapturedInit }; return jsonResponse({ id_token: "header.payload.sig" }); };
  const exchange = createLineCodeExchange({ fetch: fetchImpl, resolveSecret });
  const idToken = await exchange(input);
  assert.equal(idToken, "header.payload.sig");
  assert.ok(captured);
  assert.equal(captured.url, "https://api.line.me/oauth2/v2.1/token");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(captured.init.cache, "no-store");
  assert.equal(captured.init.redirect, "manual");
  const params = new URLSearchParams(captured.init.body);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("code"), input.code);
  assert.equal(params.get("redirect_uri"), input.redirectUri);
  assert.equal(params.get("client_id"), input.channelId);
  assert.equal(params.get("client_secret"), "top-secret-value");
  assert.equal(params.get("code_verifier"), input.verifier);
});

test("maps provider failures to 503 line_unavailable", async () => {
  await assertUnavailable(async () => jsonResponse({ error: "invalid_grant" }, 400));
  await assertUnavailable(async () => jsonResponse({ error: "boom" }, 500));
  await assertUnavailable(async () => new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
  await assertUnavailable(async () => jsonResponse({ access_token: "x" }, 200)); // missing id_token
  await assertUnavailable(async () => jsonResponse({ id_token: "x".repeat(8193) }, 200)); // oversized id_token
  await assertUnavailable(async () => { throw new Error("network down"); });
  await assertUnavailable(async () => { throw new DOMException("aborted", "AbortError"); });
});

test("a missing secret never reaches the token endpoint", async () => {
  let called = false;
  await assertUnavailable(async () => { called = true; return jsonResponse({ id_token: "x" }); }, async () => null);
  assert.equal(called, false);
});

test("errors never leak the client_secret or authorization code", async () => {
  const exchange = createLineCodeExchange({ fetch: async () => jsonResponse({ error: "invalid_grant" }, 400), resolveSecret });
  await exchange(input).then(() => assert.fail("should reject"), err => {
    const text = `${err.message} ${err.code} ${err.stack ?? ""}`;
    assert.ok(!text.includes("top-secret-value"), "secret must not appear");
    assert.ok(!text.includes(input.code), "code must not appear");
  });
});
