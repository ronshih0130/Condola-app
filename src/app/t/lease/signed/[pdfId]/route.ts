import { selectedLease } from "@/lib/tenant-lease";
import { requireCurrentConsent } from "@/server/consent-gate";
import { tenantSignedLeasePdf } from "@/server/queries";
import { getSession } from "@/server/session";
import { TENANT_SIGNED_PDF_ENABLED } from "@/server/tenant-signed-pdf-rules";

export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

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
  const file = await tenantSignedLeasePdf(session, lease.lease_id, pdfId);
  if (!file) return missing();

  return new Response(new Blob([Uint8Array.from(file.content)], {
    type: "application/pdf",
  }), {
    headers: {
      ...privateHeaders,
      "Content-Type": "application/pdf",
      "Content-Length": String(file.size_bytes),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.file_name)}"`,
    },
  });
}
