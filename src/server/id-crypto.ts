import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { acceptIdJpeg, acceptIdPng, jpegHasWatermarkMark, maxJpegBase64Chars, sniffIdImage, stripJpegMetadata } from "@/lib/jpeg-size";
import { productionLikeEnv } from "./demo";
import { configuredIdKey, DEMO_KEY_MATERIAL, type IdKeyName } from "./id-keys";

/** Current write version. Decrypt still accepts the unversioned ref from older rows. */
export const LEGACY_ENCRYPTION_KEY_REF = "env:ID_DOC_ENCRYPTION_KEY";
export const ENCRYPTION_KEY_REF = "env:ID_DOC_ENCRYPTION_KEY:v1";
export const HMAC_KEY_REF = "env:ID_DOC_HMAC_KEY:v1";
export { assertIdDocKeys } from "./id-keys";

const ENCRYPTION_KEYS: Record<string, IdKeyName> = {
  [LEGACY_ENCRYPTION_KEY_REF]: "ID_DOC_ENCRYPTION_KEY",
  [ENCRYPTION_KEY_REF]: "ID_DOC_ENCRYPTION_KEY",
};

const derivedKeys = new Map<string, Buffer>();
const aesKeys = new Map<string, Promise<CryptoKey>>();

function key32(envName: IdKeyName) {
  const configured = configuredIdKey(envName);
  if (configured) {
    const cacheId = `${envName}:cfg:${configured.toString("hex")}`;
    const cached = derivedKeys.get(cacheId);
    if (cached) return cached;
    derivedKeys.set(cacheId, configured);
    return configured;
  }
  if (envName === "ID_DOC_ENCRYPTION_KEY") throw new Error("Refusing to start: ID_DOC_ENCRYPTION_KEY is required.");
  // Demo hashes are unreachable when CONDOLA_ENV or NODE_ENV is production-like.
  if (productionLikeEnv()) throw new Error(`Refusing to start: ${envName} is required outside demo mode.`);
  const cacheId = `${envName}:demo:${DEMO_KEY_MATERIAL[envName]}`;
  const cached = derivedKeys.get(cacheId);
  if (cached) return cached;
  const hashed = createHash("sha256").update(DEMO_KEY_MATERIAL[envName]).digest();
  derivedKeys.set(cacheId, hashed);
  return hashed;
}

export type IdCipherBinding = { orgId: string; documentId: string; slot: string };

function associatedData(binding: IdCipherBinding) {
  return Buffer.from(`${binding.orgId}\n${binding.documentId}\n${binding.slot}`, "utf8");
}

/** A fresh ArrayBuffer. WebCrypto refuses a SharedArrayBuffer view, and a pooled slice must not leak. */
function exactBytes(value: Uint8Array) {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

/** The stored encryption_key_ref selects the key. An unknown ref is refused. */
export function keyForRef(ref: string | null | undefined) {
  const name = ref ? ENCRYPTION_KEYS[ref] : undefined;
  if (!name) throw new Error("Unknown encryption_key_ref");
  return key32(name);
}

/** One CryptoKey per raw key and usage. importKey used to run on every photo. */
async function aesKey(raw: Uint8Array, usage: "encrypt" | "decrypt") {
  const cacheId = `${Buffer.from(raw).toString("hex")}:${usage}`;
  const cached = aesKeys.get(cacheId);
  if (cached) return cached;
  const created = crypto.subtle.importKey("raw", exactBytes(raw), { name: "AES-GCM" }, false, [usage]);
  aesKeys.set(cacheId, created);
  try {
    return await created;
  } catch (error) {
    aesKeys.delete(cacheId);
    throw error;
  }
}

/**
 * AES-GCM via crypto.subtle. On Workers that runs outside the 10ms CPU budget;
 * node:crypto createCipheriv does not. Layout stays iv || tag || body so rows
 * written by the old cipher still open.
 */
export async function encryptBytes(plain: Uint8Array, binding: IdCipherBinding) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: exactBytes(associatedData(binding)), tagLength: 128 },
      await aesKey(keyForRef(ENCRYPTION_KEY_REF), "encrypt"),
      exactBytes(plain),
    ),
  );
  const tag = encrypted.subarray(encrypted.length - 16);
  const body = encrypted.subarray(0, encrypted.length - 16);
  const out = new Uint8Array(iv.length + tag.length + body.length);
  out.set(iv, 0);
  out.set(tag, iv.length);
  out.set(body, iv.length + tag.length);
  return Buffer.from(out);
}

export async function decryptBytes(payload: Uint8Array, binding: IdCipherBinding, keyRef: string | null | undefined) {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const body = payload.subarray(28);
  const combined = new Uint8Array(body.length + tag.length);
  combined.set(body, 0);
  combined.set(tag, body.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: exactBytes(iv), additionalData: exactBytes(associatedData(binding)), tagLength: 128 },
    await aesKey(keyForRef(keyRef), "decrypt"),
    combined,
  );
  return Buffer.from(plain);
}

/** SHA-256 of a photo. subtle stays off the Workers CPU budget. */
export async function sha256HexBytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", exactBytes(bytes));
  return Buffer.from(digest).toString("hex");
}

function idNumberMessage(number: string, orgId: string, keyRef: string) {
  return `${keyRef}\n${orgId}\n${number.trim().toUpperCase()}`;
}

/** HMAC is bound to the key ref so a later version can be verified beside v1. */
export function hashIdNumber(number: string, orgId: string, keyRef = HMAC_KEY_REF) {
  if (keyRef !== HMAC_KEY_REF) throw new Error("Unknown hmac key ref");
  return createHmac("sha256", key32("ID_DOC_HMAC_KEY")).update(idNumberMessage(number, orgId, keyRef)).digest("hex");
}

/** Same digest as hashIdNumber. subtle runs outside the Workers CPU budget; createHmac does not. */
export async function hashIdNumberSubtle(number: string, orgId: string, keyRef = HMAC_KEY_REF) {
  if (keyRef !== HMAC_KEY_REF) throw new Error("Unknown hmac key ref");
  const key = await crypto.subtle.importKey(
    "raw",
    exactBytes(key32("ID_DOC_HMAC_KEY")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(idNumberMessage(number, orgId, keyRef)));
  return Buffer.from(sig).toString("hex");
}

export function sha256Hex(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

type PhotoToken = { d: string; s: string; u: string; e: number };

function signSecret() {
  return key32("ID_DOC_SIGNING_SECRET");
}

export function signPhotoToken(input: { documentId: string; slot: string; userId: string; exp: number }) {
  // `n` is inside the signature so a retry is a different URL even in the same millisecond.
  const body = Buffer.from(
    JSON.stringify({ d: input.documentId, s: input.slot, u: input.userId, e: input.exp, n: randomBytes(8).toString("base64url") }),
  ).toString("base64url");
  const sig = createHmac("sha256", signSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readPhotoToken(token: string): PhotoToken | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", signSecret()).update(body).digest("base64url");
  const actual = Buffer.from(sig);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PhotoToken;
    if (!parsed.d || !parsed.s || !parsed.u || typeof parsed.e !== "number") return null;
    if (parsed.e < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function taipeiStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

function declaredImage(mime: string) {
  const value = mime.toLowerCase();
  if (value === "image/jpg") return "image/jpeg";
  return value;
}

/** True when the data URL is an image that is not a JPEG or a PNG, or its bytes disagree with that label. */
export function photoTypeRejected(value: string) {
  const match = DATA_URL.exec(value.trim());
  if (!match) return false;
  const declared = declaredImage(match[1] ?? "");
  const sniffed = sniffIdImage(Buffer.from(match[2] ?? "", "base64"));
  if (declared !== "image/jpeg" && declared !== "image/png") return true;
  if (sniffed === "jpeg") return declared !== "image/jpeg";
  if (sniffed === "png") return declared !== "image/png";
  return true;
}

export function parsePhotoPayload(value: string) {
  const trimmed = value.trim();
  const maxChars = maxJpegBase64Chars();
  if (trimmed.length > "data:image/jpeg;base64,".length + maxChars) return null;
  const match = DATA_URL.exec(trimmed);
  if (!match || match[2].length > maxChars || photoTypeRejected(trimmed)) return null;
  const raw = Buffer.from(match[2], "base64");
  return acceptUploadBytes(raw, match[1] ?? "");
}

/** One raw photo from a single upload request. Null when the type or the bytes are refused. */
export function acceptUploadBytes(bytes: Uint8Array, declaredType: string) {
  const declared = declaredImage(declaredType.split(";")[0]?.trim() ?? "");
  const sniffed = sniffIdImage(bytes);
  if (declared !== "image/jpeg" && declared !== "image/png") return null;
  if (sniffed === "png") {
    if (declared !== "image/png" || !acceptIdPng(bytes)) return null;
    return { mime: "image/png" as const, bytes: Buffer.from(bytes) };
  }
  if (sniffed !== "jpeg" || declared !== "image/jpeg" || !jpegHasWatermarkMark(bytes)) return null;
  const stripped = stripJpegMetadata(bytes);
  if (!stripped || !acceptIdJpeg(stripped)) return null;
  return { mime: "image/jpeg" as const, bytes: Buffer.from(stripped) };
}
