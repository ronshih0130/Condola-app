import { NextResponse } from "next/server";
import { openTicketPhoto } from "@/server/ticket-photos";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) return new Response("Not found", { status: 404 });
  const { id } = await context.params;
  const photo = await openTicketPhoto(session, id);
  if (!photo) return new Response("Not found", { status: 404 });
  return NextResponse.redirect(photo.url, 302);
}
