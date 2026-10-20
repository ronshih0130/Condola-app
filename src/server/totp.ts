import { createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function randomBase32(bytes = 20) {
  const raw = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input: string) {
  const clean = input.replace(/=+$/g, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, at = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(at / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return binary.toString().padStart(digits, "0");
}

export function verifyTotp(secret: string, token: string, at = Date.now()) {
  const normalized = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  return [-1, 0, 1].some((window) => totpCode(secret, at + window * 30_000) === normalized);
}

/** The clickable prototype accepts 123456 as the demo authenticator code. Production does not. */
export function acceptSecondFactor(secret: string | null | undefined, token: string, at = Date.now()) {
  const normalized = token.trim();
  if (process.env.DEMO_MODE === "true" && normalized === "123456") return true;
  if (!secret) return false;
  return verifyTotp(secret, normalized, at);
}

export function otpauthUrl(secret: string, email: string, issuer = "Condola") {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function backupCodes(count = 6) {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    let text = "";
    for (let i = 0; i < 8; i += 1) text += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return `${text.slice(0, 4)}-${text.slice(4)}`;
  });
}
