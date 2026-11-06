import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { providerUserHash, verifyLineSignature } from "./webhook";
const secret = "local-test-secret", raw = Buffer.from('{ "events": [] }');
const signature = createHmac("sha256", secret).update(raw).digest("base64");
test("signature accepts exact RAW bytes only (whitespace, tampered body, wrong secret)", () => {
  assert.equal(verifyLineSignature(raw, signature, secret), true);
  assert.equal(verifyLineSignature(Buffer.from('{"events":[]}'), signature, secret), false);
  assert.equal(verifyLineSignature(Buffer.from('{ "events": [1] }'), signature, secret), false);
  assert.equal(verifyLineSignature(raw, signature, "wrong"), false);
});
test("missing/malformed/unequal-length signatures safely reject without buffer-length exceptions", () => {
  for (const value of [null, "", "a", "x".repeat(10000), "!".repeat(44), signature.slice(0, -1), Buffer.alloc(32).toString("base64")])
    assert.equal(verifyLineSignature(raw, value, secret), false);
});
test("signature uses timingSafeEqual before JSON parsing; reply call chain has no push access", () => {
  const source = readFileSync(new URL("./webhook.ts", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual\(expected, supplied\)/);
  assert.ok(source.indexOf("if (!verifyLineSignature(raw") < source.indexOf("JSON.parse(raw"));
  assert.match(source, /Pick<LineTransport, "reply">/);
  assert.doesNotMatch(source, /\.push\(\{|transport\.push|dispatchLinePush|fetch\(/);
});
test("identity digest is keyed and provider scoped; no plaintext id in the digest", () => {
  const id = "U" + "a".repeat(32);
  assert.match(providerUserHash("provider", id, "pepper"), /^[0-9a-f]{64}$/);
  assert.notEqual(providerUserHash("provider", id, "pepper"), providerUserHash("other", id, "pepper"));
  assert.notEqual(providerUserHash("provider", id, "pepper"), providerUserHash("provider", id, "other"));
});
