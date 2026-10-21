import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { readSession } from "@/server/session";
import { storeTicketPhoto } from "@/server/ticket-photos";

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
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) throw new FlowError("errors.required");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = await storeTicketPhoto(session, {
      ticketId: String(form.get("ticketId") ?? ""),
      fileName: file.name,
      mime: String(form.get("mime") ?? file.type),
      bytes,
      internal: form.get("internal") === "1",
    });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return jsonError(error);
  }
}
