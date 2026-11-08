import { vendorPaperScan } from "@/server/vendor-documents-gate";
import { failure, handleError, headers, isUuid, readBody } from "../_http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const fields = await readBody(request);
    if (fields instanceof Response) return fields;
    if (!isUuid(fields.scanId)) return failure("invalid_request", 400);
    const scan = await vendorPaperScan(fields.token, fields.scanId);
    const ext = scan.mime_type === "application/pdf" ? "pdf" : scan.mime_type === "image/png" ? "png" : "jpg";
    return new Response(new Uint8Array(scan.bytes), { headers: { ...headers,
      "Content-Type": scan.mime_type, "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="paper-scan.${ext}"`,
    } });
  } catch (error) { return handleError(error); }
}
