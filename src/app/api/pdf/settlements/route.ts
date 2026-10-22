import { NextResponse } from "next/server";
import { taipeiToday } from "@/server/money";
import { settlementPdfForSession } from "@/server/rent-settlement";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await readSession();
  if (!session) return new NextResponse("Not found", { status: 404 });
  const url = new URL(request.url);
  const doc = await settlementPdfForSession(
    session,
    {
      ownerId: url.searchParams.get("owner") ?? "",
      month: url.searchParams.get("month") ?? "",
      currency: url.searchParams.get("currency") ?? "",
    },
    taipeiToday(),
  );
  if (!doc) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(doc, { headers: { "Cache-Control": "private, no-store" } });
}
