import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { readSession } from "@/server/session";
import { prepareTicketPhotoUpload } from "@/server/ticket-photos";

export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const key = error instanceof FlowError ? error.key : "errors.generic";
  const status = key === "errors.forbidden" ? 403 : key === "errors.notFound" ? 404 : 400;
  return NextResponse.json({ ok: false, error: key }, { status });
}

export async function POST(request: Request) {
  try {
    const session = await readSession();
    if (!session) return NextResponse.json({ ok: false, error: "errors.forbidden" }, { status: 401 });
    const blocked = await requireCurrentConsent(session, "api");
    if (blocked) return blocked;
    const body = (await request.json()) as { ticketId?: string; fileName?: string; mime?: string; size?: number };
    const result = await prepareTicketPhotoUpload(session, {
      ticketId: String(body.ticketId ?? ""),
      fileName: String(body.fileName ?? ""),
      mime: String(body.mime ?? ""),
      size: Number(body.size),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
