import { sha256Hex } from "./document";

/**
 * A challenge's random version ID, signer, stored issuedAt and destination bind
 * its code. No code/hash is stored. Domain state enforces expiry, attempt limits
 * and single use across sessions/Workers. The secret must be stable across deploys.
 */
export async function emailCode(
  binding: { caseId: string; versionId: string; signerId: string; email: string; issuedAt: string },
  secret = process.env.ESIGN_EMAIL_SECRET ?? "",
) {
  if (new TextEncoder().encode(secret).length < 32) throw new Error("ESIGN_EMAIL_SECRET requires at least 32 bytes");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(JSON.stringify(["condola-esign-email-v1", binding])),
  ));
  return Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function matchesEmailCode(expected: string, response: string) {
  const a = await sha256Hex(new TextEncoder().encode(expected));
  const b = await sha256Hex(new TextEncoder().encode(response.trim()));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
