import { demoModeEnabled, productionLikeEnv } from "./demo";

const KEY_NAMES = ["ID_DOC_ENCRYPTION_KEY", "ID_DOC_HMAC_KEY", "ID_DOC_SIGNING_SECRET"] as const;
export type IdKeyName = (typeof KEY_NAMES)[number];

/** Local demo material. Hashed to 32 bytes in id-crypto, and only when demo mode is on and the env var is unset. */
export const DEMO_KEY_MATERIAL: Record<IdKeyName, string> = {
  ID_DOC_ENCRYPTION_KEY: "condola-demo-id-doc-key",
  ID_DOC_HMAC_KEY: "condola-demo-id-hmac",
  ID_DOC_SIGNING_SECRET: "condola-demo-id-signing",
};

const KEY_BYTES = 32;

function building() {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * 32 raw bytes, encoded as 64 hex characters or standard base64 (43 unpadded
 * or 44 with `=`). A passphrase is not accepted and is not hashed.
 */
export function parseIdKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  if (value.replace(/=+$/, "").length !== 43) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === KEY_BYTES ? decoded : null;
}

function formatMessage(name: IdKeyName) {
  return `Refusing to start: ${name} must be exactly 32 bytes (64 hex characters, or standard base64 that decodes to 32 bytes).`;
}

function missingMessage(name: IdKeyName) {
  return `Refusing to start: ${name} is required outside demo mode.`;
}

function refuse(message: string): never {
  console.error(`\n${"!".repeat(72)}\n${message}\n${"!".repeat(72)}\n`);
  throw new Error(message);
}

/**
 * Outside demo mode the process does not start, and does not encrypt, without
 * 32-byte ID_DOC_ENCRYPTION_KEY, ID_DOC_HMAC_KEY, and ID_DOC_SIGNING_SECRET values.
 * Demo mode may leave them unset. A value that is set must still be 32 bytes.
 */
export function assertIdDocKeys() {
  if (building()) return;
  const production = productionLikeEnv();
  for (const name of KEY_NAMES) {
    const raw = process.env[name]?.trim();
    if (!raw) {
      // Demo material is local only. A production-like process never skips a missing key.
      if (!production && demoModeEnabled()) continue;
      refuse(missingMessage(name));
    }
    if (!parseIdKey(raw)) refuse(formatMessage(name));
  }
}

/** Parsed 32-byte key, or null when demo mode is using its local material. */
export function configuredIdKey(envName: IdKeyName): Buffer | null {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    if (productionLikeEnv()) refuse(missingMessage(envName));
    if (demoModeEnabled()) return null;
    refuse(missingMessage(envName));
  }
  const parsed = parseIdKey(raw);
  if (!parsed) refuse(formatMessage(envName));
  return parsed;
}
