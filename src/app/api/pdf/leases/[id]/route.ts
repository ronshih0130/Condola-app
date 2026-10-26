import { NextResponse } from "next/server";
import { leasePdfForSession } from "@/server/pdf-download";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return new NextResponse("Not found", { status: 404 });
  const session = await getSession();
  const doc = await leasePdfForSession(session, id);
  if (!doc) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(doc, { headers: { "Cache-Control": "private, no-store" } });
}
