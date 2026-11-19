import { authorizeNotifySettings, saveNotifySetting } from "@/server/b073-notify-settings";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { withFlagGate } from "@/server/flag-gate";
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
 * Consent → session → origin → brand_v3 run in withFlagGate (Lauren 2b; brandV3EnabledForOrg never rejects).
 */
export const POST = withFlagGate({
  flagKey: "brand_v3",
  flag: session => brandV3EnabledForOrg(session.orgId),
  tag: "b073_notify_route",
  headers,
  sameOrigin: true,
}, async (request, session) => {
  const authorized = await authorizeNotifySettings(session);
  if (!authorized) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return new Response(null, { status: 415, headers });
  const body = await readCappedJson(request);
  if (!body.ok) return new Response(null, { status: body.status, headers });
  const result = await saveNotifySetting(authorized, body.value);
  if (result.ok) return Response.json({ block: result.block, toggles: result.toggles }, { headers });
  return new Response(null, { status: result.status, headers });
});
