import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { ASSIGN_BODY_LIMIT, authorizeAssign, maintUnitAssignEnabledForOrg, saveAssign } from "@/server/b059-maint-unit-assign";
import { withFlagGate } from "@/server/flag-gate";
import { readCappedJson } from "@/server/read-capped-json";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/**
 * B-059 / MGT-118-AC1 (負責的單位・{名字} 「儲存」): replaces one maintenance person's units, JSON
 * `{ requestId, target, units }`. Same-origin only (403); no session 401; brand_v3 or maint_unit_assign OFF (or a
 * failed flag lookup) 404; native admin/manager required (403, MGT-118-AC7); then content type and the capped body.
 * Consent, session, origin, both flags and permission all precede the body. Nothing is sent.
 * Consent → session → origin → brand_v3 → maint_unit_assign run in withFlagGate (Lauren 2b; neither predicate
 * rejects, and maint_unit_assign is read only when brand_v3 is ON).
 */
export const POST = withFlagGate({
  flagKey: "maint_unit_assign",
  flag: async session => await brandV3EnabledForOrg(session.orgId) && await maintUnitAssignEnabledForOrg(session.orgId),
  tag: "b059_assign_route",
  headers,
  sameOrigin: true,
}, async (request, session) => {
  const authorized = await authorizeAssign(session);
  if (!authorized) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return new Response(null, { status: 415, headers });
  const body = await readCappedJson(request, ASSIGN_BODY_LIMIT);
  if (!body.ok) return new Response(null, { status: body.status, headers });
  const result = await saveAssign(authorized, body.value);
  if (result.ok) return Response.json({ status: result.status, units: result.units }, { headers });
  return new Response(null, { status: result.status, headers });
});
