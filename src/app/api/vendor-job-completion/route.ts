import { submitVendorCompletion } from "@/server/vendor-job";
import { assertCompletion } from "@/server/vendor-job-rules";
import { vendorTokenAcceptable } from "@/server/vendor-repair-rules";
import { FlowError } from "@/server/errors";
import { parseRequestId } from "../vendor-job/_request-id";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return new Response(null, { status: 415, headers });
  }
  let token: string;
  let input: Parameters<typeof submitVendorCompletion>[1];
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 20000) return new Response(null, { status: 413, headers });
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new FlowError("errors.required");
    const fields = value as Record<string, unknown>;
    if (typeof fields.token !== "string" || !vendorTokenAcceptable(fields.token)
      || typeof fields.hasAfterPhoto !== "boolean"
      || (fields.reason != null && typeof fields.reason !== "string")) throw new FlowError("errors.required");
    const requestId = parseRequestId(fields.requestId);
    if (requestId === null) throw new FlowError("errors.required");
    token = fields.token;
    input = {
      requestId, hasAfterPhoto: fields.hasAfterPhoto,
      reason: fields.reason as string | null ?? null,
    };
    assertCompletion(input);
  } catch {
    return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  }
  try {
    const result = await submitVendorCompletion(token, input);
    return Response.json(result, { headers });
  } catch (error) {
    const code = (error as { code?: string }).code
      ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "40001") return Response.json({ status: "rejected_conflict" }, { status: 409, headers });
    if (code === "42501") return new Response(null, { status: 403, headers });
    if (error instanceof FlowError) return new Response(null, { status: 403, headers });
    throw error;
  }
}
