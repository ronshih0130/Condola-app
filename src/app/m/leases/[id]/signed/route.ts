import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { writeStaffSignedPdfDownload } from "@/server/audit";
import { requireCurrentConsent } from "@/server/consent-gate";
import { logServerError } from "@/server/errors";
import { signedLeasePdf } from "@/server/queries";
import { getSession } from "@/server/session";
import { legacyStaffSignedPdfHttp } from "@/server/signed-pdf-http";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await guardEffectiveSession(await getSession(), "props.view");
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const { id } = await context.params;
  return legacyStaffSignedPdfHttp({
    session,
    leaseId: id,
    read: async () => {
      const file = await signedLeasePdf(session, id);
      if (!file) return null;
      return { id: file.id, content: Uint8Array.from(file.content), file_name: file.file_name };
    },
    audit: (pdfId) => {
      if (session.role !== "admin" && session.role !== "manager") {
        throw new Error("staff_signed_pdf_legacy: role not permitted to download signed PDF");
      }
      return writeStaffSignedPdfDownload({
        orgId: session.orgId,
        userId: session.userId,
        actorRole: session.role,
        leaseId: id,
        pdfId,
        requestId: crypto.randomUUID(),
      });
    },
    logError: (error) => logServerError("staff_signed_pdf_legacy", error),
  });
}
