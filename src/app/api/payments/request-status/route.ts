import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { paymentRequestStatus } from "@/server/payment-request-status";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await guardEffectiveSession(await getSession(), "pay.record");
    const denied = await requireCurrentConsent(session, "api");
    if (denied) return denied;
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("leaseId" in body) || !("requestId" in body) || typeof body.leaseId !== "string" || typeof body.requestId !== "string") return new Response(null, {status:400});
    const status = await paymentRequestStatus(session, body.leaseId, body.requestId);
    return Response.json({status}, {headers:{"Cache-Control":"no-store"}});
  } catch {
    return new Response(null, {status:403,headers:{"Cache-Control":"no-store"}});
  }
}
