import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { contractVersionDigest } from "./document";
import { stampSignature, taipeiIso } from "./stamp";

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

// Synthetic single-pixel PNG; no customer data.
const png = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
);

async function fixture() {
  const doc = await PDFDocument.create();
  doc.addPage();
  return doc.save();
}

test("signature page appends to a loadable PDF and returns the exact output digest", async () => {
  const source = await fixture();
  const before = await contractVersionDigest(source);
  const snapshot = source.slice();
  const result = await stampSignature(source, png, {
    signerDisplayName: "Example Signer",
    signedAt: "2026-10-26T16:30:00Z",
    documentDigest: before,
  });
  const loaded = await PDFDocument.load(result.bytes);
  assert.equal(loaded.getPageCount(), 2);
  assert.equal(result.postSigningDigest, await contractVersionDigest(result.bytes));
  assert.notEqual(result.postSigningDigest, before);
  assert.deepEqual(source, snapshot);
});

test("Taipei stamp time includes date rollover and timezone offset", () => {
  assert.equal(taipeiIso("2026-10-26T16:30:00Z"), "2026-10-27T00:30:00.000+08:00");
  assert.equal(taipeiIso("2026-10-27T00:30:00+08:00"), "2026-10-27T00:30:00.000+08:00");
  assert.throws(() => taipeiIso("2026-10-26"));
  assert.throws(() => taipeiIso("invalid"));
});

test("reject wrong digest, empty name and Chinese name without font bytes", async () => {
  const source = await fixture();
  const input = {
    signerDisplayName: "Example",
    signedAt: "2026-10-26T16:30:00Z",
    documentDigest: await contractVersionDigest(source),
  };
  await assert.rejects(() => stampSignature(source, png, { ...input, documentDigest: "0".repeat(64) }));
  await assert.rejects(() => stampSignature(source, png, { ...input, signerDisplayName: " " }));
  await assert.rejects(
    () => stampSignature(source, png, { ...input, signerDisplayName: "測試簽署人" }),
    /Font bytes required/,
  );
});
