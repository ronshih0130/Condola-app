import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { selectedLease } from "@/lib/tenant-lease";
import { writeSignedPdfDownload } from "@/server/audit";
import { requireCurrentConsent } from "@/server/consent-gate";
import { logServerError } from "@/server/errors";
import { tenantSignedLeasePdf } from "@/server/queries";
import { getSession } from "@/server/session";
import { tenantSignedPdfHttp } from "@/server/signed-pdf-http";
import { tenantSignedPdfGloballyEnabled } from "@/server/tenant-signed-pdf-rules";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ pdfId: string }> },
) {
  const session = await guardEffectiveSession(await getSession(), null);
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const { pdfId } = await context.params;
  const selected = session.kind === "tenant" ? await selectedLease() : { lease: null };
  const leaseId = selected.lease?.lease_id ?? null;
  return tenantSignedPdfHttp({
    session,
    pdfId,
    leaseId,
    leaseOrgId: leaseId ? session.orgId : null,
    globallyEnabled: tenantSignedPdfGloballyEnabled(),
    read: async () => {
      if (!leaseId) return null;
      const file = await tenantSignedLeasePdf(session, leaseId, pdfId);
      if (!file) return null;
      return { content: Uint8Array.from(file.content), file_name: file.file_name };
    },
    audit: () => {
      if (!leaseId) return Promise.resolve();
      return writeSignedPdfDownload({
        orgId: session.orgId,
        userId: session.userId,
        leaseId,
        pdfId,
        requestId: crypto.randomUUID(),
      });
    },
    logError: (error) => logServerError("tenant_signed_pdf", error),
  });
}
