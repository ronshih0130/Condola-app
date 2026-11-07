import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { lineHash, returnPath, verifyLoginToken } from "./login-token";
const secret = "local-jwt-secret";
const now = 1800000000000;
const claims = { iss: "https://access.line.me", aud: "login-channel", sub: `U${"a".repeat(32)}`, iat: now / 1000 - 5, exp: now / 1000 + 300, nonce: "nonce" };
function token(payload: Record<string, unknown>, header = { alg: "HS256", typ: "JWT" }, key = secret) {
 const raw = [header, payload].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
 return `${raw}.${createHmac("sha256", key).update(raw).digest("base64url")}`;
}
test("local HS256 accepts the verified subject and checks OAuth nonce", () => {
 assert.equal(verifyLoginToken(token(claims), secret, claims.aud, lineHash("nonce"), now), claims.sub);
});
for (const [name, patch] of Object.entries({ audience: { aud: "other" }, issuer: { iss: "https://evil.test" }, expiry: { exp: now / 1000 - 31 },
 future: { iat: now / 1000 + 31 }, nonce: { nonce: "other" }, subject: { sub: "arbitrary" }, missingExpiry: { exp: null },
 backwards: { iat: now / 1000 + 20, exp: now / 1000 }, arrayAudience: { aud: ["login-channel"] }, nbf: { nbf: now / 1000 + 60 } })) {
 test(`local JWT rejects ${name}`, () => assert.throws(() => verifyLoginToken(token({ ...claims, ...patch }), secret, claims.aud, lineHash("nonce"), now), /invalid_line_token/));
}
test("JWT rejects algorithm confusion, signature tampering and malformed input", () => {
 for (const value of [token(claims, { alg: "none", typ: "JWT" }), token(claims, undefined, "wrong"), "bad", token(claims) + "="]) {
  assert.throws(() => verifyLoginToken(value, secret, claims.aud, undefined, now), /invalid_line_token/);
 }
});
test("return paths are exact portal allowlists", () => {
 assert.equal(returnPath("vendor"), "/vendor-account");
 assert.equal(returnPath("vendor", "/vendor-account"), "/vendor-account");
 assert.throws(() => returnPath("vendor", "/v"));
 assert.equal(returnPath("tenant"), "/t"); assert.equal(returnPath("owner"), "/o/statements");
 for (const path of ["https://evil.test", "//evil.test", "/t/../m", "/t?next=https://evil.test", "/v", "/t\\evil"]) assert.throws(() => returnPath("tenant", path));
});
