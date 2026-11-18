import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { saveTeamSecurity } from "@/server/b073-team";
import { logServerError } from "@/server/errors";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const MAX_BODY_BYTES = 1024;

/**
 * B-073 / R5-TEAM (MGT-133-AC7): 「要求全體成員啟用兩步驟驗證」, JSON `{ required }`, saved through the existing
 * `setRequireMfa`. Same-origin only (403); no session 401; consent as other staff APIs; a non-admin gets HTTP 403
 * (MGT-133-AC8, saveTeamSecurity applies settings.edit first, whatever the body); brand_v3 OFF for the session's
 * organization 404 with nothing written; bad body 400; any other failure 500. Nothing is sent.
 */
export async function POST(request: Request) {
  // Consent guard first (consent-entrypoints rule), as in /api/owner-repair-decision; then session, origin and body.
  const denied = await requireCurrentConsent(undefined, "api");
  if (denied) return denied;
  let session: Awaited<ReturnType<typeof readSession>>;
  try {
    session = await readSession();
  } catch (error) {
    logServerError("b073_team_security_route", error);
    return new Response(null, { status: 500, headers });
  }
  if (!session) return new Response(null, { status: 401, headers });
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return new Response(null, { status: 415, headers });
  // Bound the body before reading it (Content-Length), then again in bytes after reading.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return new Response(null, { status: 413, headers });
  let text: string;
  try {
    text = await request.text();
  } catch {
    return new Response(null, { status: 400, headers });
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return new Response(null, { status: 413, headers });
  // Unparseable JSON is passed on as "no valid body": saveTeamSecurity authorizes first, so a non-admin gets 403
  // and an admin 400 for it.
  let input: unknown = undefined;
  try { input = JSON.parse(text); } catch { input = undefined; }
  try {
    const result = await saveTeamSecurity(session, input);
    if (result.ok) return Response.json({ required: result.required }, { headers });
    return new Response(null, { status: result.status, headers });
  } catch (error) {
    logServerError("b073_team_security_route", error);
    return new Response(null, { status: 500, headers });
  }
}
