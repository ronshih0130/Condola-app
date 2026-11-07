import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { readSession } from "@/server/session";
import { confirmBatchPhoto, prepareBatchPhoto, submitBatchPhotos } from "@/server/upload-recovery";

export const dynamic = "force-dynamic";

// B-031 UPLOAD_RECOVERY. With the flag OFF every op answers 404 after one flag read.
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
    const body = (await request.json()) as {
      op?: string;
      ticketId?: string;
      batchKey?: string;
      clientKey?: string;
      fileName?: string;
      mime?: string;
      size?: number;
      internal?: boolean;
    };
    const ticketId = String(body.ticketId ?? "");
    const batchKey = String(body.batchKey ?? "");
    const clientKey = String(body.clientKey ?? "");
    if (body.op === "prepare") {
      const result = await prepareBatchPhoto(session, {
        ticketId,
        batchKey,
        clientKey,
        fileName: String(body.fileName ?? ""),
        mime: String(body.mime ?? ""),
        size: Number(body.size),
        internal: body.internal === true,
      });
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.op === "confirm") {
      return NextResponse.json({ ok: true, ...(await confirmBatchPhoto(session, { ticketId, batchKey, clientKey })) });
    }
    if (body.op === "submit") {
      const result = await submitBatchPhotos(session, { ticketId, batchKey, internal: body.internal === true });
      return NextResponse.json({ ok: true, count: result.attached.length, skipped: result.skipped });
    }
    return NextResponse.json({ ok: false, error: "errors.notFound" }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}
