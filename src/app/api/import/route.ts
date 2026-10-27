import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { FlowError, logServerError } from "@/server/errors";
import { commitImportBatch, dryRunImport, previewImport, readImportBody } from "@/server/import-batch";
import { readSession } from "@/server/session";
import type { Session } from "@/server/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await readSession();
  if (!session || session.kind !== "staff") return NextResponse.json({ error: "errors.forbidden" }, { status: 401 });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  try {
    const body = await readImportBody(request);
    if (body.mode === "preview") {
      const issues = await previewImport(session, { fileName: body.fileName, rows: body.rows });
      return NextResponse.json({ issues }, { headers: { "cache-control": "no-store" } });
    }
    if (body.mode === "dry") {
      const result = await dryRunImport(session, { fileName: body.fileName, rows: body.rows });
      return NextResponse.json(result);
    }
    return streamCommit(session, body);
  } catch (error) {
    return importErrorResponse(error);
  }
}

function streamCommit(session: Session, body: { fileName: string; rows: unknown }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        const result = await commitImportBatch(session, { fileName: body.fileName, rows: body.rows }, (done, total) => {
          send({ type: "progress", done, total });
        });
        send({ type: "result", result });
      } catch (error) {
        logImportFailure(error);
        try {
          send({ type: "error", error: "im_none" });
        } catch {
          // The browser already went away.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function importErrorResponse(error: unknown) {
  if (error instanceof FlowError) {
    const status = error.key === "errors.forbidden" ? 403 : 400;
    return NextResponse.json({ error: error.key, vars: error.vars ?? {} }, { status });
  }
  logImportFailure(error);
  return NextResponse.json({ error: "errors.generic" }, { status: 500 });
}

function logImportFailure(error: unknown) {
  // mapDbError already logged this failure, including its driver metadata.
  if (error instanceof FlowError) return;
  const cause = error instanceof Error ? error.cause : undefined;
  const reported = cause && typeof cause === "object" ? cause : error;
  logServerError("import", reported);
}
