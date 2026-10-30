import { consentRequiredResponse, requireCurrentConsent } from "@/server/consent-gate";
import { logPayeeIngress, readPayeeContext, tenantPayee } from "@/server/payee";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ leaseId: string }> }) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const session = await readSession();
    if (!session) {
      await logPayeeIngress(await readPayeeContext());
      return Response.json({ ok: false }, { status: 401, headers });
    }
    const consent = await requireCurrentConsent(session, "api");
    if (consent) {
      await logPayeeIngress(session);
      return consentRequiredResponse();
    }
    const { leaseId } = await context.params;
    const data = await tenantPayee(session, leaseId);
    return Response.json({ ok: true, data }, { headers });
  } catch {
    return Response.json({ ok: false }, { status: 403, headers });
  }
}
