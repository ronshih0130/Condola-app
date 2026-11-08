import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const lineHash = (value: string) => createHash("sha256").update(value).digest("hex");
export class LineError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function rejectLine(status: number, code: string): never { throw new LineError(status, code); }
export function equalHash(value: string, expected: string | null) {
  const actual = Buffer.from(lineHash(value), "hex");
  return typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected)
    && timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
/** Local HS256 only: no discovery, JWKS, algorithm selection, or provider HTTP. */
export function verifyLoginToken(token: string, secret: string, channelId: string, nonceHash?: string, now = Date.now()) {
  try {
    if (typeof token !== "string" || token.length > 8192) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const [head, payload, signature] = parts;
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    if (!header || header.alg !== "HS256" || header.crit !== undefined || header.b64 !== undefined) throw new Error();
    const expected = createHmac("sha256", secret).update(`${head}.${payload}`).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || supplied.toString("base64url") !== signature || !timingSafeEqual(expected, supplied)) throw new Error();
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const seconds = Math.floor(now / 1000), skew = 30;
    if (!claims || claims.iss !== "https://access.line.me" || claims.aud !== channelId
      || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
      || claims.exp <= seconds - skew || claims.iat > seconds + skew || claims.iat >= claims.exp
      || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds + skew))
      || typeof claims.sub !== "string" || !/^U[0-9a-f]{32}$/.test(claims.sub)
      || (nonceHash !== undefined && (typeof claims.nonce !== "string" || !equalHash(claims.nonce, nonceHash)))) throw new Error();
    return claims.sub as string;
  } catch { return rejectLine(401, "invalid_line_token"); }
}
export type LinePersona = "tenant" | "vendor" | "owner";
export const portalPath = (persona: LinePersona) => persona === "tenant" ? "/t" : persona === "vendor" ? "/vendor-account" : "/o/statements";
export const liffPath = (persona: LinePersona) => `/${persona === "tenant" ? "t" : persona === "vendor" ? "v" : "o"}/liff`;
export function returnPath(persona: LinePersona, value?: string) {
  const allowed = [portalPath(persona), liffPath(persona)];
  if (value !== undefined && !allowed.includes(value)) rejectLine(400, "invalid_request");
  return value ?? portalPath(persona);
}
