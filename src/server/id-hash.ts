import { createHash, createHmac } from "node:crypto";
import { demoModeEnabled } from "./demo";

const DEMO_HMAC_MATERIAL = "condola-demo-id-hmac";
const KEY_BYTES = 32;

/**
 * Same HMAC as hashIdNumber() on the tenant ID uploader: HMAC-SHA256 with
 * ID_DOC_HMAC_KEY, over org id + newline + the trimmed uppercased number.
 * Demo mode with the key unset uses the same demo material, hashed to 32 bytes.
 */
export function hashIdNumber(number: string, orgId: string) {
  return createHmac("sha256", hmacKey())
    .update(`${orgId}\n${number.trim().toUpperCase()}`)
    .digest("hex");
}

export function parseIdHmacKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  if (value.replace(/=+$/, "").length !== 43) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === KEY_BYTES ? decoded : null;
}

function hmacKey() {
  const raw = process.env.ID_DOC_HMAC_KEY?.trim();
  if (!raw) {
    if (demoModeEnabled() || process.env.NEXT_PHASE === "phase-production-build") {
      return createHash("sha256").update(DEMO_HMAC_MATERIAL).digest();
    }
    throw new Error("ID_DOC_HMAC_KEY is required");
  }
  const parsed = parseIdHmacKey(raw);
  if (!parsed) throw new Error("ID_DOC_HMAC_KEY must be exactly 32 bytes");
  return parsed;
}
