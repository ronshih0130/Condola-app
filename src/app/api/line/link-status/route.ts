import { NextResponse } from "next/server";
import { staffLinkStatus } from "@/server/line-store";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (session.kind !== "staff") return NextResponse.json({ status: "off" });
  const status = await staffLinkStatus(session);
  return NextResponse.json(status);
}
