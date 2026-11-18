import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { ASSIGN_BODY_LIMIT, authorizeAssign, maintUnitAssignEnabledForOrg, saveAssign } from "@/server/b059-maint-unit-assign";
import { logServerError } from "@/server/errors";
import { readCappedJson } from "@/server/read-capped-json";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/**
 * B-059 / MGT-118-AC1 (負責的單位・{名字} 「儲存」): replaces one maintenance person's units, JSON
 * `{ requestId, target, units }`. Same-origin only (403); no session 401; brand_v3 or maint_unit_assign OFF (or a
 * failed flag lookup) 404; native admin/manager required (403, MGT-118-AC7); then content type and the capped body.
 * Consent, session, origin, both flags and permission all precede the body. Nothing is sent.
 */
export async function POST(request: Request) {
  const denied = await requireCurrentConsent(undefined, "api");
  if (denied) return denied;
  let session: Awaited<ReturnType<typeof readSession>>;
  try {
    session = await readSession();
  } catch (error) {
    logServerError("b059_assign_route", error);
    return new Response(null, { status: 500, headers });
  }
  if (!session) return new Response(null, { status: 401, headers });
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  try {
    if (!await brandV3EnabledForOrg(session.orgId)) return new Response(null, { status: 404, headers });
    if (!await maintUnitAssignEnabledForOrg(session.orgId)) return new Response(null, { status: 404, headers });
    const authorized = await authorizeAssign(session);
    if (!authorized) return new Response(null, { status: 403, headers });
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return new Response(null, { status: 415, headers });
    const body = await readCappedJson(request, ASSIGN_BODY_LIMIT);
    if (!body.ok) return new Response(null, { status: body.status, headers });
    const result = await saveAssign(authorized, body.value);
    if (result.ok) return Response.json({ status: result.status, units: result.units }, { headers });
    return new Response(null, { status: result.status, headers });
  } catch (error) {
    logServerError("b059_assign_route", error);
    return new Response(null, { status: 500, headers });
  }
}
