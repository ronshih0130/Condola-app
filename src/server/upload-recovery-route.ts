import { NextResponse } from "next/server";
import { FlowError } from "./errors";
import type { Session } from "./types";
import { confirmBatchPhoto, discardBatchPhotos, prepareBatchPhoto, submitBatchPhotos, uploadRecoveryEnabled } from "./upload-recovery";

/**
 * B-031 UPLOAD_RECOVERY body for POST /api/tickets/photos/batch, called by the route
 * after its readSession (401 without a session) and the repo-wide consent gate
 * (consent-entrypoints.test requires the gate to dominate every route body).
 * Here: exactly one flag read, then 404 when OFF — no other SQL, no writes.
 */
function jsonError(error: unknown) {
  const key = error instanceof FlowError ? error.key : "errors.generic";
  const status = key === "errors.forbidden" ? 403 : key === "errors.notFound" ? 404 : key === "errors.busy" ? 503 : 400;
  return NextResponse.json({ ok: false, error: key }, { status });
}

export async function handleUploadBatch(request: Request, session: Session): Promise<Response> {
  try {
    if (!(await uploadRecoveryEnabled(session.orgId))) return NextResponse.json({ ok: false, error: "errors.notFound" }, { status: 404 });
    const body = (await request.json()) as {
      op?: string; ticketId?: string; batchKey?: string; clientKey?: string;
      fileName?: string; mime?: string; size?: number; internal?: boolean;
    };
    const ticketId = String(body.ticketId ?? "");
    const batchKey = String(body.batchKey ?? "");
    const clientKey = String(body.clientKey ?? "");
    if (body.op === "prepare") {
      const result = await prepareBatchPhoto(session, {
        ticketId, batchKey, clientKey,
        fileName: String(body.fileName ?? ""), mime: String(body.mime ?? ""), size: Number(body.size),
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
    if (body.op === "discard" || body.op === "remove") {
      const result = await discardBatchPhotos(session, { ticketId, batchKey, ...(body.op === "remove" ? { clientKey } : {}) });
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ ok: false, error: "errors.notFound" }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}
