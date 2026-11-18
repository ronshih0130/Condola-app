import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { authorizeSettingsEdit, saveOwnerView } from "@/server/b073-owner-view";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { logServerError } from "@/server/errors";
import { readCappedJson } from "@/server/read-capped-json";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/**
 * B-073 / R5-OWNVIEW (MGT-138): one switch of 「屋主看得到什麼」 per request, JSON `{ field, value }`.
 * Same-origin only (403); no session 401; brand_v3 OFF 404; settings.edit required (MGT-138-AC3).
 * Consent, session, origin, flag and permission all precede the body. Nothing is sent to owners.
 */
export async function POST(request: Request) {
  const denied = await requireCurrentConsent(undefined, "api");
  if (denied) return denied;
  let session: Awaited<ReturnType<typeof readSession>>;
  try {
    session = await readSession();
  } catch (error) {
    logServerError("b073_owner_view_route", error);
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
    const result = await saveOwnerView(authorized, body.value);
    if (result.ok) return Response.json({ privacy: result.privacy }, { headers });
    return new Response(null, { status: result.status, headers });
  } catch (error) {
    logServerError("b073_owner_view_route", error);
    return new Response(null, { status: 500, headers });
  }
}
