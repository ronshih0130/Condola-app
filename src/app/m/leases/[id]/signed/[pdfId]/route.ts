import { writeStaffSignedPdfDownload } from "@/server/audit";
import { requireCurrentConsent } from "@/server/consent-gate";
import { logServerError } from "@/server/errors";
import { paperLeaseVersionPdf } from "@/server/paper-lease-versions";
import { paperLeaseVersionsGlobalEnabled } from "@/server/paper-lease-versions-rules";
import { getSession } from "@/server/session";
import { staffSignedPdfHttp } from "@/server/signed-pdf-http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; pdfId: string }> },
) {
  const session = await getSession();
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const { id, pdfId } = await context.params;
  return staffSignedPdfHttp({
    session,
    leaseId: id,
    pdfId,
    leaseOrgId: session.orgId,
    globallyEnabled: paperLeaseVersionsGlobalEnabled(process.env.PAPER_LEASE_VERSIONS_ENABLED),
    read: async () => {
      const file = await paperLeaseVersionPdf(session, id, pdfId);
      if (!file) return null;
      return { content: Uint8Array.from(file.content), file_name: file.file_name };
    },
    audit: () => {
      if (session.role !== "admin" && session.role !== "manager") return Promise.resolve();
      return writeStaffSignedPdfDownload({
        orgId: session.orgId,
        userId: session.userId,
        actorRole: session.role,
        leaseId: id,
        pdfId,
        requestId: crypto.randomUUID(),
      });
    },
    logError: (error) => logServerError("staff_signed_pdf", error),
  });
}
