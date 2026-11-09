import { resolveLocalLineSecret } from "./secrets";
import type { SecretResolver } from "./webhook";
import { LineError, rejectLine } from "./login-token";
import type { LineCodeExchange } from "./login-link";

/**
 * Live LINE Login v2.1 WEB OAuth token exchange (authorization code + PKCE).
 * POSTs the code and verifier to the token endpoint and returns only the id_token.
 * Edge/Workers safe: global fetch, no node http. The client_secret, authorization
 * code and returned token never enter a log line, error message or URL; every
 * failure collapses to an opaque 503 line_unavailable.
 */
export function createLineCodeExchange(
  deps: { fetch?: typeof fetch; resolveSecret?: SecretResolver; timeoutMs?: number } = {},
): LineCodeExchange {
  const doFetch = deps.fetch ?? fetch;
  const resolveSecret = deps.resolveSecret ?? resolveLocalLineSecret;
  const timeoutMs = deps.timeoutMs ?? 5000;
  return async ({ code, verifier, redirectUri, channelId, secretRef }) => {
    try {
      const resolved = await resolveSecret(secretRef);
      if (!resolved || typeof resolved.secret !== "string" || resolved.secret.length === 0) {
        return rejectLine(503, "line_unavailable");
      }
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: channelId,
        client_secret: resolved.secret,
        code_verifier: verifier,
      });
      const response = await doFetch("https://api.line.me/oauth2/v2.1/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return rejectLine(503, "line_unavailable");
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return rejectLine(503, "line_unavailable");
      }
      if (!payload || typeof payload !== "object") return rejectLine(503, "line_unavailable");
      const idToken = (payload as Record<string, unknown>).id_token;
      if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > 8192) {
        return rejectLine(503, "line_unavailable");
      }
      return idToken;
    } catch (error) {
      if (error instanceof LineError) throw error;
      // Network error, abort/timeout, or any unexpected throw: never surface internals.
      return rejectLine(503, "line_unavailable");
    }
  };
}
