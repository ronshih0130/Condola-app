import { openTicketPhoto } from "@/server/ticket-photos";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) return new Response("Not found", { status: 404 });
  const { id } = await context.params;
  const photo = await openTicketPhoto(session, id);
  if (!photo) return new Response("Not found", { status: 404 });
  const name = photo.name.replace(/[\r\n"]/g, "_");
  return new Response(new Uint8Array(photo.bytes), {
    headers: {
      "Content-Type": photo.mime,
      "Content-Disposition": `inline; filename="${encodeURIComponent(name)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
