import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { SAMPLE_JPEG_BASE64 } from "../lib/idv";
import { embedIdWatermarkMark, MAX_LONG_EDGE, MAX_PHOTO_BYTES, readJpegSize } from "../lib/jpeg-size";
import { ENCRYPTION_KEY_REF, LEGACY_ENCRYPTION_KEY_REF, assertIdDocKeys, decryptBytes, encryptBytes, hashIdNumber, hashIdNumberSubtle, keyForRef, parsePhotoPayload, photoTypeRejected, readPhotoToken, signPhotoToken } from "./id-crypto";

const BINDING = { orgId: "org-1", documentId: "doc-1", slot: "front" };

function markerJpeg(width: number, height: number) {
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0"), sof, sos]);
}

function marked(bytes: Buffer) {
  const out = embedIdWatermarkMark(bytes);
  if (!out) throw new Error("watermark mark");
  return Buffer.from(out);
}

const ENC = "11".repeat(32);
const HMAC = "22".repeat(32);
const SIGN = "33".repeat(32);

process.env.ID_DOC_ENCRYPTION_KEY ??= ENC;
process.env.ID_DOC_HMAC_KEY ??= HMAC;
process.env.ID_DOC_SIGNING_SECRET ??= SIGN;

test("ciphertext round-trips and the HMAC is not the ID number", async () => {
  const plain = Buffer.from(SAMPLE_JPEG_BASE64, "base64");
  const cipher = await encryptBytes(plain, BINDING);
  assert.equal(cipher.equals(plain), false);
  assert.deepEqual(await decryptBytes(cipher, BINDING, ENCRYPTION_KEY_REF), plain);
  await assert.rejects(() => decryptBytes(cipher, { ...BINDING, slot: "back" }, ENCRYPTION_KEY_REF));
  await assert.rejects(() => decryptBytes(cipher, BINDING, "env:other"), /Unknown encryption_key_ref/);
  assert.deepEqual(await decryptBytes(cipher, BINDING, LEGACY_ENCRYPTION_KEY_REF), plain);
  const hash = hashIdNumber("a123456789", BINDING.orgId);
  assert.equal(hash, hashIdNumber("A123456789", BINDING.orgId));
  assert.notEqual(hash, hashIdNumber("A123456789", "org-2"));
  assert.equal(hash.includes("A123456789"), false);
  assert.throws(() => hashIdNumber("A123456789", BINDING.orgId, "env:ID_DOC_HMAC_KEY"), /Unknown hmac key ref/);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await hashIdNumberSubtle("a123456789", BINDING.orgId), hash);
  await assert.rejects(() => hashIdNumberSubtle("A123456789", BINDING.orgId, "env:ID_DOC_HMAC_KEY"), /Unknown hmac key ref/);
});

test("a photo token expires and a tampered signature is rejected", () => {
  const token = signPhotoToken({ documentId: "doc", slot: "front", userId: "user", exp: Date.now() + 60_000 });
  const parsed = readPhotoToken(token);
  assert.equal(parsed?.d, "doc");
  assert.equal(parsed?.s, "front");
  assert.equal(parsed?.u, "user");
  const expired = signPhotoToken({ documentId: "doc", slot: "front", userId: "user", exp: Date.now() - 1000 });
  assert.equal(readPhotoToken(expired), null);
  const [body] = token.split(".");
  assert.equal(readPhotoToken(`${body}.not-the-signature`), null);
});

test("photo payloads must be a JPEG within 800 KB and the long-edge cap", () => {
  const sample = marked(Buffer.from(SAMPLE_JPEG_BASE64, "base64"));
  const sampleSize = readJpegSize(sample);
  assert.ok(sampleSize);
  assert.ok(Math.max(sampleSize.width, sampleSize.height) <= MAX_LONG_EDGE);
  const parsed = parsePhotoPayload(`data:image/jpeg;base64,${sample.toString("base64")}`);
  assert.equal(parsed?.mime, "image/jpeg");
  assert.equal(parsed?.bytes.includes(Buffer.from("condola-id-wm")), false);
  assert.equal(parsePhotoPayload("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ")?.mime, "image/png");
  assert.equal(parsePhotoPayload("data:image/png;base64,iVBORw0KGgo="), null);
  assert.equal(parsePhotoPayload("data:image/jpeg;base64,QQ=="), null);
  const wide = markerJpeg(4032, 3024);
  assert.equal(readJpegSize(wide)?.width, 4032);
  assert.equal(parsePhotoPayload(`data:image/jpeg;base64,${marked(wide).toString("base64")}`), null);
  const capped = markerJpeg(MAX_LONG_EDGE, 1200);
  assert.equal(parsePhotoPayload(`data:image/jpeg;base64,${capped.toString("base64")}`), null);
  assert.equal(parsePhotoPayload(`data:image/jpeg;base64,${marked(capped).toString("base64")}`)?.mime, "image/jpeg");
  const heavy = Buffer.concat([capped, Buffer.alloc(MAX_PHOTO_BYTES)]);
  assert.equal(parsePhotoPayload(`data:image/jpeg;base64,${heavy.toString("base64")}`), null);
  const secret = "SECRET-EXIF-PAYLOAD";
  const appBody = Buffer.concat([Buffer.from("Exif\0\0"), Buffer.from(secret)]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (appBody.length + 2) >> 8, (appBody.length + 2) & 0xff]), appBody]);
  const comBody = Buffer.from(secret);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, (comBody.length + 2) >> 8, (comBody.length + 2) & 0xff]), comBody]);
  const tagged = Buffer.concat([capped.subarray(0, 2), app1, com, capped.subarray(2)]);
  const stripped = parsePhotoPayload(`data:image/jpeg;base64,${marked(tagged).toString("base64")}`);
  assert.ok(stripped);
  assert.equal(stripped.bytes.includes(Buffer.from(secret)), false);
  assert.ok(stripped.bytes.length < tagged.length);
  const trailing = Buffer.concat([marked(capped), Buffer.from("TRAILING-BYTES")]);
  const trimmed = parsePhotoPayload(`data:image/jpeg;base64,${trailing.toString("base64")}`);
  assert.ok(trimmed);
  assert.equal(trimmed.bytes.includes(Buffer.from("TRAILING-BYTES")), false);
  assert.equal(trimmed.bytes[trimmed.bytes.length - 2], 0xff);
  assert.equal(trimmed.bytes[trimmed.bytes.length - 1], 0xd9);
  const progressive = markerJpeg(32, 32);
  progressive[progressive.indexOf(0xc0)] = 0xc2;
  assert.equal(parsePhotoPayload(`data:image/jpeg;base64,${marked(progressive).toString("base64")}`), null);
});

test("a GIF is rejected from its magic bytes, and a PNG is accepted only as a PNG", () => {
  const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  assert.equal(photoTypeRejected(`data:image/gif;base64,${gif}`), true);
  assert.equal(photoTypeRejected(`data:image/jpeg;base64,${gif}`), true);
  assert.equal(parsePhotoPayload(`data:image/gif;base64,${gif}`), null);
  assert.equal(parsePhotoPayload(`data:image/jpeg;base64,${gif}`), null);
  assert.equal(photoTypeRejected(`data:image/png;base64,${png}`), false);
  assert.equal(photoTypeRejected(`data:image/jpeg;base64,${png}`), true);
  assert.equal(parsePhotoPayload(`data:image/jpeg;base64,${png}`), null);
  assert.equal(parsePhotoPayload(`data:image/png;base64,${png}`)?.mime, "image/png");
});

test("startup refuses when an ID key is missing outside demo mode", async () => {
  const saved = {
    DEMO_MODE: process.env.DEMO_MODE,
    CONDOLA_ENV: process.env.CONDOLA_ENV,
    NEXT_PHASE: process.env.NEXT_PHASE,
    enc: process.env.ID_DOC_ENCRYPTION_KEY,
    hmac: process.env.ID_DOC_HMAC_KEY,
    sign: process.env.ID_DOC_SIGNING_SECRET,
  };
  process.env.DEMO_MODE = "false";
  delete process.env.CONDOLA_ENV;
  delete process.env.NEXT_PHASE;
  delete process.env.ID_DOC_ENCRYPTION_KEY;
  delete process.env.ID_DOC_HMAC_KEY;
  delete process.env.ID_DOC_SIGNING_SECRET;
  assert.throws(() => assertIdDocKeys(), /ID_DOC_ENCRYPTION_KEY is required/);
  process.env.ID_DOC_ENCRYPTION_KEY = "unit-enc";
  assert.throws(() => assertIdDocKeys(), /ID_DOC_ENCRYPTION_KEY must be exactly 32 bytes/);
  process.env.ID_DOC_ENCRYPTION_KEY = Buffer.alloc(32, 0x11).toString("base64");
  assert.throws(() => assertIdDocKeys(), /ID_DOC_HMAC_KEY is required/);
  process.env.ID_DOC_HMAC_KEY = "unit-hmac";
  assert.throws(() => assertIdDocKeys(), /ID_DOC_HMAC_KEY must be exactly 32 bytes/);
  process.env.ID_DOC_HMAC_KEY = HMAC;
  assert.throws(() => assertIdDocKeys(), /ID_DOC_SIGNING_SECRET is required/);
  process.env.ID_DOC_SIGNING_SECRET = "unit-sign";
  assert.throws(() => assertIdDocKeys(), /ID_DOC_SIGNING_SECRET must be exactly 32 bytes/);
  process.env.ID_DOC_SIGNING_SECRET = SIGN;
  assert.doesNotThrow(() => assertIdDocKeys());
  const round = await encryptBytes(Buffer.from("abc"), BINDING);
  assert.deepEqual(await decryptBytes(round, BINDING, ENCRYPTION_KEY_REF), Buffer.from("abc"));
  delete process.env.ID_DOC_ENCRYPTION_KEY;
  await assert.rejects(() => encryptBytes(Buffer.from("abc"), BINDING), /ID_DOC_ENCRYPTION_KEY/);
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("DEMO_MODE", saved.DEMO_MODE);
  restore("CONDOLA_ENV", saved.CONDOLA_ENV);
  restore("NEXT_PHASE", saved.NEXT_PHASE);
  restore("ID_DOC_ENCRYPTION_KEY", saved.enc);
  restore("ID_DOC_HMAC_KEY", saved.hmac);
  restore("ID_DOC_SIGNING_SECRET", saved.sign);
});

test("webcrypto opens a payload written by node aes-256-gcm", async () => {
  const key = keyForRef(ENCRYPTION_KEY_REF);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${BINDING.orgId}\n${BINDING.documentId}\n${BINDING.slot}`));
  const body = Buffer.concat([cipher.update(Buffer.from("legacy-row")), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), body]);
  assert.deepEqual(await decryptBytes(payload, BINDING, ENCRYPTION_KEY_REF), Buffer.from("legacy-row"));
});

test("demo keys cannot encrypt when the environment is production", async () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = {
    DEMO_MODE: env.DEMO_MODE,
    CONDOLA_ENV: env.CONDOLA_ENV,
    NODE_ENV: env.NODE_ENV,
    NEXT_PHASE: env.NEXT_PHASE,
    enc: env.ID_DOC_ENCRYPTION_KEY,
    hmac: env.ID_DOC_HMAC_KEY,
    sign: env.ID_DOC_SIGNING_SECRET,
  };
  env.DEMO_MODE = "true";
  env.CONDOLA_ENV = "production";
  env.NODE_ENV = "test";
  delete env.NEXT_PHASE;
  delete env.ID_DOC_ENCRYPTION_KEY;
  delete env.ID_DOC_HMAC_KEY;
  delete env.ID_DOC_SIGNING_SECRET;
  try {
    assert.throws(() => assertIdDocKeys(), /ID_DOC_ENCRYPTION_KEY is required/);
    await assert.rejects(() => encryptBytes(Buffer.from("abc"), BINDING), /ID_DOC_ENCRYPTION_KEY/);
  } finally {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete env[name];
      else env[name] = value;
    };
    restore("DEMO_MODE", saved.DEMO_MODE);
    restore("CONDOLA_ENV", saved.CONDOLA_ENV);
    restore("NODE_ENV", saved.NODE_ENV);
    restore("NEXT_PHASE", saved.NEXT_PHASE);
    restore("ID_DOC_ENCRYPTION_KEY", saved.enc);
    restore("ID_DOC_HMAC_KEY", saved.hmac);
    restore("ID_DOC_SIGNING_SECRET", saved.sign);
  }
});
