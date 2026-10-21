import { createHash, createHmac } from "node:crypto";
import { demoModeEnabled, productionLikeEnv } from "./demo";

/**
 * Byte-identical to hashIdNumber() on the tenant ID uploader
 * (src/server/id-crypto.ts, HMAC_KEY_REF). After that change merges, replace
 * this module with: export { hashIdNumber } from "./id-crypto";
 */
export const HMAC_KEY_REF = "env:ID_DOC_HMAC_KEY:v1";

const DEMO_HMAC_MATERIAL = "condola-demo-id-hmac";
const KEY_BYTES = 32;

/**
 * HMAC-SHA256(ID_DOC_HMAC_KEY) over `env:ID_DOC_HMAC_KEY:v1\norgId\nID`.
 * The ID is trimmed and uppercased. A missing or malformed key fails closed.
 * Demo mode with the key unset uses sha256("condola-demo-id-hmac"), the same
 * 32 bytes as the uploader. `next build` (NEXT_PHASE=phase-production-build)
 * does not substitute that demo key.
 */
export function hashIdNumber(number: string, orgId: string, keyRef = HMAC_KEY_REF) {
  if (keyRef !== HMAC_KEY_REF) throw new Error("Unknown hmac key ref");
  return createHmac("sha256", hmacKey())
    .update(`${keyRef}\n${orgId}\n${number.trim().toUpperCase()}`)
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
    if (!productionLikeEnv() && demoModeEnabled()) {
      return createHash("sha256").update(DEMO_HMAC_MATERIAL).digest();
    }
    throw new Error("Refusing to start: ID_DOC_HMAC_KEY is required outside demo mode.");
  }
  const parsed = parseIdHmacKey(raw);
  if (!parsed) {
    throw new Error(
      "Refusing to start: ID_DOC_HMAC_KEY must be exactly 32 bytes (64 hex characters, or standard base64 that decodes to 32 bytes).",
    );
  }
  return parsed;
}
