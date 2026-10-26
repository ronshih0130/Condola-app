import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
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

// All names, images and contract pages here are synthetic.
test("CJK font embeds successfully and two stamps preserve both signatures and digests", async () => {
  const fontBytes = new Uint8Array(await readFile("public/fonts/DroidSansFallback-subset.ttf"));
  const source = await fixture();
  const before = await contractVersionDigest(source);
  const first = await stampSignature(source, png, {
    signerDisplayName: "屋主", signedAt: "2026-10-26T16:30:00Z",
    documentDigest: before, fontBytes,
  });
  const snapshot = first.bytes.slice();
  const second = await stampSignature(first.bytes, png, {
    signerDisplayName: "租客", signedAt: "2026-10-26T16:31:00Z",
    documentDigest: first.postSigningDigest, fontBytes,
  });
  assert.deepEqual(first.bytes, snapshot);
  assert.equal(first.postSigningDigest, await contractVersionDigest(first.bytes));
  assert.equal(second.postSigningDigest, await contractVersionDigest(second.bytes));
  assert.notEqual(second.postSigningDigest, first.postSigningDigest);
  const pdf = await PDFDocument.load(second.bytes);
  assert.equal(pdf.getPageCount(), 3);
  for (const [index, digest] of [[1, before], [2, first.postSigningDigest]] as const) {
    const page = pdf.getPage(index);
    const contents = page.node.Contents();
    assert.ok(contents instanceof PDFArray);
    const text = Array.from({ length: contents.size() }, (_, i) => {
      const stream = contents.lookup(i, PDFRawStream);
      return new TextDecoder().decode(decodePDFRawStream(stream).decode());
    }).join("\n");
    const hex = Array.from(new TextEncoder().encode(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    assert.ok(text.toLowerCase().includes(hex));
    assert.match(text, /\/[^\s]+ Do/); // Image drawing operation on each signature page.
    const resources = page.node.Resources();
    assert.ok(resources);
    assert.ok(resources.has(PDFName.of("XObject")));
    assert.ok(resources.has(PDFName.of("Font")));
  }
  // Embedded Unicode maps prove both CJK names survive the second save.
  const maps = pdf.context.enumerateIndirectObjects().flatMap(([, object]) => {
    if (!(object instanceof PDFRawStream)) return [];
    const decoded = new TextDecoder().decode(decodePDFRawStream(object).decode());
    return decoded.includes("beginbfchar") || decoded.includes("beginbfrange") ? [decoded.toLowerCase()] : [];
  }).join("\n");
  for (const ch of "屋主租客") assert.ok(maps.includes(ch.codePointAt(0)!.toString(16)), ch);
  await assert.rejects(() => stampSignature(first.bytes, png, {
    signerDisplayName: "租客", signedAt: "2026-10-26T16:31:00Z",
    documentDigest: before, fontBytes,
  }), /digest mismatch/);
});
