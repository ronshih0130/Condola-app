import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { saveNotifySetting } from "@/server/b073-notify-settings";
import { logServerError } from "@/server/errors";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const MAX_BODY_BYTES = 1024;

/**
 * B-073 / R5-NOTIFY (MGT-135): one switch of 通知設定 per request, JSON `{ block: "me" | "tenant", field, value }`.
 * Same-origin only (403); no session 401; consent as other staff APIs; 「寄給租客的」 for a non-admin is HTTP 403
 * (MGT-135-AC4, saveNotifySetting applies settings.edit before any write); 「寄給我的」 writes only the caller's own
 * row and is 403 for roles without personal reminders; bad body 400; any other failure 500. Settings only: nothing
 * is sent because of a save (MGT-135-AC3).
 */
export async function POST(request: Request) {
  // Consent guard first (consent-entrypoints rule), as in /api/owner-view; then session, origin and body.
  const denied = await requireCurrentConsent(undefined, "api");
  if (denied) return denied;
  let session: Awaited<ReturnType<typeof readSession>>;
  try {
    session = await readSession();
  } catch (error) {
    logServerError("b073_notify_route", error);
    return new Response(null, { status: 500, headers });
  }
  if (!session) return new Response(null, { status: 401, headers });
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return new Response(null, { status: 415, headers });
  // Bound the body before reading it (Content-Length), then again in bytes after reading.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return new Response(null, { status: 413, headers });
  let input: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return new Response(null, { status: 413, headers });
    input = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400, headers });
  }
  try {
    const result = await saveNotifySetting(session, input);
    if (result.ok) return Response.json({ block: result.block, toggles: result.toggles }, { headers });
    return new Response(null, { status: result.status, headers });
  } catch (error) {
    logServerError("b073_notify_route", error);
    return new Response(null, { status: 500, headers });
  }
}
