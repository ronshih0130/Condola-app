import { FlowError } from "@/server/errors";
import { vendorDocumentAvailable } from "@/server/vendor-documents-gate";

export const headers = { "Cache-Control": "no-store" };
export function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function readBody(request: Request): Promise<Response | (Record<string, unknown> & { token: string })> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return failure("forbidden", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return failure("unsupported_media_type", 415);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 7100000) return failure("payload_too_large", 413);
  let fields: Record<string, unknown>;
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure("invalid_request", 400);
    fields = body as Record<string, unknown>;
  } catch { return failure("invalid_request", 400); }
  if (typeof fields.token !== "string" || !await vendorDocumentAvailable(fields.token)) return failure("not_found", 404);
  return { ...fields, token: fields.token };
}

export function handleError(error: unknown): Response {
  const metadata = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string; reason?: string } };
  const code = metadata.cause?.code ?? metadata.code;
  const constraint = metadata.cause?.constraint ?? metadata.constraint;
  if (code === "23514" && constraint === "b025_receipt_requires_full_payment") return failure("receipt_requires_full_payment", 409);
  if (error instanceof FlowError && error.key === "errors.notFound") return failure("not_found", 404);
  if (error instanceof FlowError && error.key === "errors.vendorDocumentItemsUnavailable") return failure("items_unavailable", 409);
  if (code === "42501") return failure("forbidden", 403);
  if (["idempotency_key_conflict", "document_already_issued", "reissue_required", "document_already_reissued"].includes(metadata.cause?.reason ?? "")) return failure(metadata.cause!.reason!, 409);
  if (error instanceof FlowError) return failure("invalid_request", 400);
  throw error;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}
