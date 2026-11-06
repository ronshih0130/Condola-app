import { respondVendorJob } from "@/server/vendor-job";
import { assertVendorResponse } from "@/server/vendor-job-rules";
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
  let input: Parameters<typeof respondVendorJob>[1];
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 20000) return new Response(null, { status: 413, headers });
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new FlowError("errors.required");
    const fields = value as Record<string, unknown>;
    if (typeof fields.token !== "string" || !vendorTokenAcceptable(fields.token)
      || (fields.action !== "propose" && fields.action !== "reject" && fields.action !== "accept_confirm")
      || (fields.reason != null && typeof fields.reason !== "string")) throw new FlowError("errors.required");
    const requestId = parseRequestId(fields.requestId);
    if (requestId === null) throw new FlowError("errors.required");
    let times: typeof input.times;
    if (fields.times !== undefined) {
      if (!fields.times || typeof fields.times !== "object" || Array.isArray(fields.times)) throw new FlowError("errors.required");
      const raw = fields.times as Record<string, unknown>;
      const read = (name: string) => {
        const time = raw[name];
        if (time != null && typeof time !== "string") throw new FlowError("errors.required");
        return time as string | null | undefined;
      };
      times = {
        proposedStart: read("proposedStart"), proposedEnd: read("proposedEnd"),
        confirmedStart: read("confirmedStart"), confirmedEnd: read("confirmedEnd"),
      };
    }
    token = fields.token;
    input = {
      requestId, action: fields.action, times,
      reason: fields.reason as string | null ?? null,
    };
    assertVendorResponse(input);
  } catch {
    return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  }
  try {
    const result = await respondVendorJob(token, input);
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
