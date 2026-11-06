import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { downloadHandoverAttachment } from "@/server/handover";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ leaseId: string; attachmentId: string }> }) {
  const blocked = await requireCurrentConsent(undefined, "api");
  if (blocked) return blocked;
  const session = await guardEffectiveSession(await getSession(), "leases.edit");
  const { leaseId, attachmentId } = await context.params;
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const file = await downloadHandoverAttachment(session, leaseId, attachmentId);
    return new Response(Buffer.from(file.bytes), { headers: { ...headers, "Content-Type": file.mime, "Content-Disposition": `${file.mime.startsWith("image/") ? "inline" : "attachment"}; filename="handover-file"` } });
  } catch { return new Response("Not found", { status: 404, headers }); }
}
