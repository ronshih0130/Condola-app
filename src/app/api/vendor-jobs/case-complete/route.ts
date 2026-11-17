import { completeVendorCase, parseCompleteInput } from "@/server/b097-vendor-close";
import { FlowError } from "@/server/errors";
import { readCapped } from "@/server/http-body";
import { vendorTokenAcceptable } from "@/server/vendor-repair-rules";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** B-097 RV-DONE 送出完工: the assigned vendor's case bearer closes this one repair. In-app only. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return new Response(null, { status: 415, headers });
  }
  const body = await readCapped(request, 4096);
  if (body === null) return new Response(null, { status: 413, headers });
  let token: string;
  let input: NonNullable<ReturnType<typeof parseCompleteInput>>;
  try {
    const value: unknown = JSON.parse(body);
    const fields = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const parsed = parseCompleteInput(value);
    if (typeof fields.token !== "string" || !vendorTokenAcceptable(fields.token) || !parsed) throw new Error("invalid");
    token = fields.token; input = parsed;
  } catch {
    return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  }
  try {
    const result = await completeVendorCase(token, input);
    const status = result.status === "recorded" ? 200 : result.status === "rejected_invalid" ? 400
      : result.status === "rejected_no_photo" ? 422 : 409;
    return Response.json(result, { status, headers });
  } catch (error) {
    if (error instanceof FlowError) return new Response(null, { status: 404, headers });
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "55P03" || code === "57014" || code === "40001" || code === "40P01") return Response.json({ status: "busy" }, { status: 503, headers });
    throw error;
  }
}
