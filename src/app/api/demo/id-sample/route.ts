import { NextResponse } from "next/server";
import { demoModeEnabled } from "@/server/demo";
import { attachSampleId } from "@/server/id-docs";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** Demo only: attach a masked sample ID so a try-out lease can be signed. */
export async function POST(request: Request) {
  if (!demoModeEnabled()) return new NextResponse(null, { status: 404 });
  const session = await readSession();
  if (!session || session.kind !== "staff" || (session.role !== "admin" && session.role !== "manager")) {
    return new NextResponse(null, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { leaseId?: string } | null;
  if (!body?.leaseId) return NextResponse.json({ error: "errors.required" }, { status: 400 });
  await attachSampleId(session.userId, body.leaseId);
  return NextResponse.json({ ok: true });
}
