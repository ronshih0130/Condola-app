import { submitVendorEstimate } from "@/server/vendor-estimates";
import { parseVendorEstimate } from "@/server/vendor-estimate-rules";
import { vendorTokenAcceptable } from "@/server/vendor-repair-rules";
import { FlowError } from "@/server/errors";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return new Response(null, { status: 415, headers });
  }
  let token: string, input: ReturnType<typeof parseVendorEstimate>;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 40000) return new Response(null, { status: 413, headers });
    const value: unknown = JSON.parse(body);
    input = parseVendorEstimate(value);
    token = (value as { token: string }).token;
    if (typeof token !== "string" || !vendorTokenAcceptable(token)) throw new FlowError("errors.required");
  } catch {
    return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  }
  try {
    const result = await submitVendorEstimate(token, input);
    return Response.json(result, { status: result.status === "rejected_conflict" ? 409 : 200, headers });
  } catch (error) {
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "40001") return Response.json({ status: "rejected_conflict" }, { status: 409, headers });
    // Bounded lock contention is temporary: retry with the same request id.
    if (code === "55P03") return Response.json({ status: "busy", retryable: true }, { status: 503, headers: { ...headers, "Retry-After": "1" } });
    if (error instanceof FlowError || code === "42501") return new Response(null, { status: 403, headers });
    throw error;
  }
}
