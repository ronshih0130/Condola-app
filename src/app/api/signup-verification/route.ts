import { withFlagGate } from "@/server/flag-gate";
import { readCappedJson } from "@/server/read-capped-json";
import { signupRouteFlagsOn } from "@/server/sms/flags";
import { auditLogSmsAudit, createAuditLogSmsLedger, requestSmsOtp } from "@/server/sms/request-otp";
import { selectTransport } from "@/server/sms/transport";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const BODY_LIMIT = 1024;

export const POST = withFlagGate({
  flagKey: "signup_verification",
  flag: session => signupRouteFlagsOn(session.orgId),
  tag: "b044_signup_verification",
  headers,
  sameOrigin: true,
}, async (request, session) => {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return new Response(null, { status: 415, headers });
  }
  const body = await readCappedJson(request, BODY_LIMIT);
  if (!body.ok) return new Response(null, { status: body.status, headers });
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return new Response(null, { status: 400, headers });
  }
  const { to, deviceId, requestId } = body.value as Record<string, unknown>;
  const user = "user" in session ? session.user : null;
  const actorUserId = "userId" in session && typeof session.userId === "string" ? session.userId
    : user && typeof user === "object" && "id" in user && typeof user.id === "string" ? user.id : null;
  // Use the address appended by the ingress, not an earlier client-supplied entry.
  const ip = request.headers.get("x-forwarded-for")?.split(",").pop()?.trim() || null;
  const env = process.env;
  const selected = selectTransport(env);
  const result = await requestSmsOtp({
    purpose: "signup_verification",
    orgId: session.orgId,
    actorUserId,
    ip,
    to,
    deviceId: typeof deviceId === "string" ? deviceId : null,
    requestId: typeof requestId === "string" ? requestId : null,
  }, {
    env,
    flagOn: signupRouteFlagsOn,
    ledger: createAuditLogSmsLedger(),
    audit: auditLogSmsAudit,
    // Let the library record a refusal if live configuration was incomplete.
    ...("transport" in selected ? { transport: selected.transport } : {}),
  });
  return Response.json(result, { status: result.ok ? 202 : result.reason === "flag_off" ? 404 : 400, headers });
});
