import { vendorDocumentPdf } from "@/server/vendor-documents-gate";
import { failure, handleError, headers, isUuid, readBody } from "../_http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const fields = await readBody(request);
    if (fields instanceof Response) return fields;
    if (!isUuid(fields.documentId)) return failure("invalid_request", 400);
    const pdf = await vendorDocumentPdf(fields.token, fields.documentId);
    return new Response(Buffer.from(pdf.bytes), { headers: { ...headers, "Content-Type": "application/pdf" } });
  } catch (error) { return handleError(error); }
}
