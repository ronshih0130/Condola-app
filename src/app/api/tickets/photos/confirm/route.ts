import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { readSession } from "@/server/session";
import { confirmTicketPhoto } from "@/server/ticket-photos";

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
    const body = (await request.json()) as {
      ticketId?: string;
      path?: string;
      fileName?: string;
      mime?: string;
      size?: number;
      internal?: boolean;
      uploadToken?: string;
    };
    const id = await confirmTicketPhoto(session, {
      ticketId: String(body.ticketId ?? ""),
      path: String(body.path ?? ""),
      fileName: String(body.fileName ?? ""),
      mime: String(body.mime ?? ""),
      size: Number(body.size),
      internal: Boolean(body.internal),
      uploadToken: String(body.uploadToken ?? ""),
    });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return jsonError(error);
  }
}
