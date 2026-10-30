import { notFound } from "next/navigation";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { esignAvailableFor, esignEnabled } from "@/server/esign/access";
import { esignFlow } from "@/server/esign/flow";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ caseId: string; versionId: string }> }) {
  const denied = await requireCurrentConsent(undefined, "api");
  if (denied) return denied;
  if (!esignEnabled()) notFound();
  const session = await getSession();
  if (!(await esignAvailableFor(session))) notFound();
  const { caseId, versionId } = await context.params;
  const url = new URL(request.url);
  try {
    const page = url.searchParams.has("page") ? Number(url.searchParams.get("page")) : undefined;
    const result = await esignFlow.pdf(session, caseId, versionId, url.searchParams.get("final") === "1", page);
    return new Response(new Uint8Array(result.bytes).buffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="contract.pdf"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Document-SHA256": result.digest,
      },
    });
  } catch {
    return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
}
