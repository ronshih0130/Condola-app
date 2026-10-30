import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendAudit,
  canonicalJson,
  contractVersionDigest,
  GENESIS_HASH,
  sha256Hex,
  verifyChain,
} from "./document";

test("canonical JSON sorts nested keys without whitespace and preserves arrays", () => {
  assert.equal(
    canonicalJson({ z: [3, { b: true, a: "中文" }], a: null }),
    '{"a":null,"z":[3,{"a":"中文","b":true}]}',
  );
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  for (const value of [undefined, NaN, Infinity, new Date(), { a: undefined }, [undefined]]) {
    assert.throws(() => canonicalJson(value));
  }
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular));
  assert.throws(() => canonicalJson(new Array(2)));
});

test("known SHA-256 vector and exact PDF byte digest", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const bytes = new Uint8Array([1, 2, 3]);
  const changed = new Uint8Array([1, 2, 4]);
  assert.notEqual(await contractVersionDigest(bytes), await contractVersionDigest(changed));
  assert.equal(
    await sha256Hex(new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)),
    await sha256Hex(bytes),
  );
});

test("append-only chain verifies, snapshots input and detects tampering", async () => {
  const event = { type: "sent", nested: { value: 1 } };
  const first = await appendAudit([], event);
  event.nested.value = 99;
  assert.equal(first[0].event.nested.value, 1);
  const second = await appendAudit(first, { type: "signed", nested: { value: 2 } }, first[0].hash);
  assert.equal(first.length, 1);
  assert.equal(second[0].prevHash, GENESIS_HASH);
  assert.equal(second[1].prevHash, second[0].hash);
  assert.equal(await verifyChain(second, second[1].hash), true);
  assert.equal(await verifyChain([], GENESIS_HASH), true);
  const edited = structuredClone(second);
  edited[0].event.nested.value = 3;
  assert.equal(await verifyChain(edited), false);
  const brokenLink = structuredClone(second);
  brokenLink[1].prevHash = GENESIS_HASH;
  assert.equal(await verifyChain(brokenLink), false);
  assert.equal(await verifyChain([...second].reverse()), false);
  assert.equal(await verifyChain(second.slice(0, 1), second[1].hash), false);
  assert.equal(await verifyChain([], second[1].hash), false);
  await assert.rejects(() => appendAudit(edited, event));
});

test("event hash is SHA-256 of previous hash plus canonical event", async () => {
  const event = { z: 1, a: "signed" };
  const chain = await appendAudit([], event);
  assert.equal(chain[0].hash, await sha256Hex(
    new TextEncoder().encode(GENESIS_HASH + canonicalJson(event)),
  ));
});
