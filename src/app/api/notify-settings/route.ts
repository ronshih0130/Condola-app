import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { authorizeNotifySettings, saveNotifySetting } from "@/server/b073-notify-settings";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { logServerError } from "@/server/errors";
import { readCappedJson } from "@/server/read-capped-json";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/**
 * B-073 / R5-NOTIFY (MGT-135): one switch of 通知設定 per request, JSON `{ block: "me" | "tenant", field, value }`.
 * Same-origin only (403); no session 401; consent as other staff APIs; 「寄給租客的」 for a non-admin is HTTP 403
 * (MGT-135-AC4, saveNotifySetting applies settings.edit before any write); 「寄給我的」 writes only the caller's own
 * row and is 403 for roles without personal reminders; brand_v3 OFF for the session's organization 404 with nothing
 * written (as /api/team-security); bad body 400; any other failure 500. Settings only: nothing
 * is sent because of a save (MGT-135-AC3).
 */
export async function POST(request: Request) {
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
  try {
    if (!await brandV3EnabledForOrg(session.orgId)) return new Response(null, { status: 404, headers });
    const authorized = await authorizeNotifySettings(session);
    if (!authorized) return new Response(null, { status: 403, headers });
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return new Response(null, { status: 415, headers });
    const body = await readCappedJson(request);
    if (!body.ok) return new Response(null, { status: body.status, headers });
    const result = await saveNotifySetting(authorized, body.value);
    if (result.ok) return Response.json({ block: result.block, toggles: result.toggles }, { headers });
    return new Response(null, { status: result.status, headers });
  } catch (error) {
    logServerError("b073_notify_route", error);
    return new Response(null, { status: 500, headers });
  }
}
