import { tenantPayee } from "@/server/payee";
import { authorizePayeeApiEntry } from "@/server/payee-consent";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ leaseId: string }> }) {
  const authorization = await authorizePayeeApiEntry();
  if (!authorization.ok) return authorization.response;
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const { leaseId } = await context.params;
    const data = await tenantPayee(authorization.session, leaseId);
    return Response.json({ ok: true, data }, { headers });
  } catch {
    return Response.json({ ok: false }, { status: 403, headers });
  }
}
