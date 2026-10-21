import { NextResponse } from "next/server";
import { openReceipt } from "@/server/receipts";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) return new Response("Not found", { status: 404 });
  const { id } = await context.params;
  const file = await openReceipt(session, id);
  if (!file) return new Response("Not found", { status: 404 });
  return NextResponse.redirect(file.url, 302);
}
