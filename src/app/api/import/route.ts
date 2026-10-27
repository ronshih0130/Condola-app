import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { FlowError, safeDbCode, safeDbIdentifier, safeErrorReason } from "@/server/errors";
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
  logImportFailure(error);
  if (error instanceof FlowError) {
    const status = error.key === "errors.forbidden" ? 403 : 400;
    return NextResponse.json({ error: error.key, vars: error.vars ?? {} }, { status });
  }
  return NextResponse.json({ error: "errors.generic" }, { status: 500 });
}

function logImportFailure(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  const reported = cause && typeof cause === "object" ? cause : error;
  const metadata = reported && typeof reported === "object"
    ? reported as { code?: unknown; constraint?: unknown }
    : undefined;
  const reason = safeErrorReason(
    cause && typeof cause === "object" && "reason" in cause ? cause.reason : undefined,
  );
  const safeToken = (value: unknown, pattern: RegExp) =>
    typeof value === "string" && pattern.test(value) ? value : undefined;
  const name = error instanceof FlowError
    ? "FlowError"
    : error instanceof Error
      ? safeToken(error.name, /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError|AggregateError)$/) ?? "Error"
      : "Error";
  const key = error instanceof FlowError
    ? safeToken(error.key, /^errors\.[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
    : undefined;
  const code = safeDbCode(metadata?.code);
  const constraint = safeDbIdentifier(metadata?.constraint);
  console.error("import failed", {
    name,
    ...(key === undefined ? {} : { key }),
    ...(code === undefined ? {} : { code }),
    ...(constraint === undefined ? {} : { constraint }),
    ...(reason === undefined ? {} : { reason }),
  });
}

