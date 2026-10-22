import { NextResponse } from "next/server";
import { demoModeEnabled } from "@/server/demo";
import { readSession } from "@/server/session";

const qaClock = globalThis as { __qaBusinessToday?: string };

/** DEMO_MODE only. Freezes server business dates for the QA process. */
export async function POST(request: Request) {
  if (!demoModeEnabled()) return new NextResponse(null, { status: 404 });
  const session = await readSession();
  if (!session || session.kind !== "staff" || session.role !== "admin") {
    return new NextResponse(null, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { today?: unknown } | null;
  const today = typeof body?.today === "string" ? body.today : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return NextResponse.json({ error: "today" }, { status: 400 });
  }
  qaClock.__qaBusinessToday = today;
  return NextResponse.json({ today });
}
