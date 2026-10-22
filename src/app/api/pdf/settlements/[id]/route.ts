import { NextResponse } from "next/server";
import { settlementContext } from "@/server/lease-lifecycle";
import { buildSettlementPdf } from "@/server/settlement-pdf";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return new NextResponse("Not found", { status: 404 });
  const session = await getSession();
  if (session.kind !== "staff") return new NextResponse("Not found", { status: 404 });
  const view = await settlementContext(session, id);
  if (!view || view.status !== "confirmed") return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(buildSettlementPdf(view, displaySampleName(view.tenant)), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
