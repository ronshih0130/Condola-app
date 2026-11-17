import { NextResponse } from "next/server";
import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { serveStaffRoomInvite } from "@/server/b040-staff-ui-http";
import { staffInviteHeaders } from "@/lib/staff-invite";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ roomId: string; view?: string[] }> }) {
  const session = await readSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401, headers: staffInviteHeaders });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const { roomId, view } = await context.params;
  return serveStaffRoomInvite(session, roomId, view ?? [], request);
}

export async function POST(request: Request, context: { params: Promise<{ roomId: string; view?: string[] }> }) {
  const session = await readSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401, headers: staffInviteHeaders });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const { roomId, view } = await context.params;
  return serveStaffRoomInvite(session, roomId, view ?? [], request);
}
