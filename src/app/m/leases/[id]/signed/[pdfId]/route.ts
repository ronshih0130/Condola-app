import { requireCurrentConsent } from "@/server/consent-gate";
import { paperLeaseVersionPdf } from "@/server/paper-lease-versions";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; pdfId: string }> },
) {
  const { id, pdfId } = await context.params;
  const session = await getSession();
  if (session.kind !== "staff") return new Response("Not found", { status: 404 });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const file = await paperLeaseVersionPdf(session, id, pdfId);
  if (!file) return new Response("Not found", { status: 404 });
  const bytes = Uint8Array.from(file.content);
  return new Response(new Blob([bytes], { type: "application/pdf" }), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.file_name)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
