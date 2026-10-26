import { ticketPhotoResponse, openTicketPhoto } from "@/server/ticket-photos";
import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) return new Response("Not found", { status: 404 });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const { id } = await context.params;
  return ticketPhotoResponse(() => openTicketPhoto(session, id));
}
