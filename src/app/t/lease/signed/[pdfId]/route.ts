import { selectedLease } from "@/lib/tenant-lease";
import { writeSignedPdfDownload } from "@/server/audit";
import { requireCurrentConsent } from "@/server/consent-gate";
import { logServerError } from "@/server/errors";
import { tenantSignedLeasePdf } from "@/server/queries";
import { getSession } from "@/server/session";
import { TENANT_SIGNED_PDF_ENABLED } from "@/server/tenant-signed-pdf-rules";
import {
  signedPdfPrivateHeaders as privateHeaders,
  tenantSignedPdfDownload,
} from "@/server/tenant-signed-pdf-download";

export const dynamic = "force-dynamic";

function missing() {
  return new Response("Not found", { status: 404, headers: privateHeaders });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ pdfId: string }> },
) {
  const session = await getSession();
  if (session.kind !== "tenant") {
    return new Response("Not found", { status: 404, headers: privateHeaders });
  }
  const blocked = await requireCurrentConsent(session, "api");
  if (!TENANT_SIGNED_PDF_ENABLED) return missing();
  if (blocked) return blocked;
  const { pdfId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pdfId)) {
    return missing();
  }
  const { lease } = await selectedLease();
  if (!lease) return missing();

  return tenantSignedPdfDownload({
    orgId: session.orgId,
    userId: session.userId,
    leaseId: lease.lease_id,
    pdfId,
    // No existing request-ID middleware: generate a server-owned ID per download.
    requestId: crypto.randomUUID(),
  }, {
    read: () => tenantSignedLeasePdf(session, lease.lease_id, pdfId),
    audit: writeSignedPdfDownload,
    logError: logServerError,
  });
}
