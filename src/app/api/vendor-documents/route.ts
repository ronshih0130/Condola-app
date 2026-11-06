import { tradeLineItems } from "@/server/vendor-document-trade-rules";
import type { FixedDataUpdate } from "@/server/vendor-document-integrity";
import { vendorDocumentAction, type VendorDocumentAction } from "@/server/vendor-documents-gate";
import { failure, handleError, headers, isUuid, readBody } from "./_http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const fields = await readBody(request);
    if (fields instanceof Response) return fields;
    let input: VendorDocumentAction;
    if (fields.action === "context" || fields.action === "history") input = { action: fields.action };
    else if (fields.action === "update_fixed_data") {
      if (!fields.update || typeof fields.update !== "object" || Array.isArray(fields.update)) return failure("invalid_request", 400);
      input = { action: "update_fixed_data", update: fields.update as FixedDataUpdate };
    } else if (fields.action === "attach_scan") {
      if (!isUuid(fields.documentId) || !isUuid(fields.requestId) || typeof fields.mimeType !== "string" || typeof fields.base64 !== "string") return failure("invalid_request", 400);
      input = { action: "attach_scan", documentId: fields.documentId, requestId: fields.requestId, mimeType: fields.mimeType, base64: fields.base64 };
    }
    else if (fields.action === "mark_received") {
      if (!isUuid(fields.requestId) || typeof fields.amountMinor !== "string") return failure("invalid_request", 400);
      input = { action: "mark_received", requestId: fields.requestId, amountMinor: fields.amountMinor };
    } else if (fields.action === "void") {
      if (!isUuid(fields.documentId) || typeof fields.reason !== "string" || !fields.reason.trim() || fields.reason.length > 1000) return failure("invalid_request", 400);
      input = { action: "void", documentId: fields.documentId, reason: fields.reason };
    } else if (fields.action === "preview" || fields.action === "issue" || fields.action === "reissue") {
      if ((fields.kind !== "receipt" && fields.kind !== "completion_statement")
        || typeof fields.documentDate !== "string") return failure("invalid_request", 400);
      if (fields.action !== "preview" && (typeof fields.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(fields.idempotencyKey))) return failure("invalid_request", 400);
      if (fields.action === "reissue" && !isUuid(fields.documentId)) return failure("invalid_request", 400);
      let received: { requestId: string; amountMinor: string } | undefined;
      if (fields.received !== undefined) {
        if (fields.action !== "issue" || !fields.received || typeof fields.received !== "object" || Array.isArray(fields.received)) return failure("invalid_request", 400);
        const mark = fields.received as Record<string, unknown>;
        if (!isUuid(mark.requestId) || typeof mark.amountMinor !== "string") return failure("invalid_request", 400);
        received = { requestId: mark.requestId, amountMinor: mark.amountMinor };
      }
      input = { action: fields.action, kind: fields.kind, documentDate: fields.documentDate,
        idempotencyKey: fields.idempotencyKey as string | undefined, documentId: fields.documentId as string | undefined, received,
        tradeItems: fields.tradeItems === undefined ? undefined : tradeLineItems(fields.tradeItems) };
    } else return failure("invalid_request", 400);
    return Response.json(await vendorDocumentAction(fields.token, input), { headers });
  } catch (error) { return handleError(error); }
}
