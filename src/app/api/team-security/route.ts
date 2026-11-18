import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { saveTeamSecurity } from "@/server/b073-team";
import { authorizeSettingsEdit } from "@/server/b073-owner-view";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { logServerError } from "@/server/errors";
import { readCappedJson } from "@/server/read-capped-json";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/**
 * B-073 / R5-TEAM (MGT-133-AC7): 「要求全體成員啟用兩步驟驗證」, JSON `{ required }`, saved through `setRequireMfa`.
 * Same-origin only (403); no session 401; brand_v3 OFF 404; settings.edit required (MGT-133-AC8).
 * Consent, session, origin, flag and permission all precede the body. Nothing is sent.
 */
export async function POST(request: Request) {
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
  try {
    if (!await brandV3EnabledForOrg(session.orgId)) return new Response(null, { status: 404, headers });
    const authorized = await authorizeSettingsEdit(session);
    if (!authorized) return new Response(null, { status: 403, headers });
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return new Response(null, { status: 415, headers });
    const body = await readCappedJson(request);
    if (!body.ok) return new Response(null, { status: body.status, headers });
    const result = await saveTeamSecurity(authorized, body.value);
    if (result.ok) return Response.json({ required: result.required }, { headers });
    return new Response(null, { status: result.status, headers });
  } catch (error) {
    logServerError("b073_team_security_route", error);
    return new Response(null, { status: 500, headers });
  }
}
