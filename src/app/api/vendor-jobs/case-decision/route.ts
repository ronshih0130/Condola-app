import { decideVendorCase, parseDecisionInput } from "@/server/b105-vendor-case";
import { FlowError } from "@/server/errors";
import { vendorTokenAcceptable } from "@/server/vendor-repair-rules";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** B-105 RV-JOB-ACCEPT / RV-DECLINE: the token bearer accepts or declines this one job. In-app only. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return new Response(null, { status: 415, headers });
  }
  let token: string;
  let input: NonNullable<ReturnType<typeof parseDecisionInput>>;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 8000) return new Response(null, { status: 413, headers });
    const value: unknown = JSON.parse(body);
    const fields = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const parsed = parseDecisionInput(value);
    if (typeof fields.token !== "string" || !vendorTokenAcceptable(fields.token) || !parsed) throw new Error("invalid");
    token = fields.token; input = parsed;
  } catch {
    return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  }
  try {
    const result = await decideVendorCase(token, input);
    const status = result.status === "recorded" ? 200 : result.status === "rejected_conflict" ? 409 : 400;
    return Response.json(result, { status, headers });
  } catch (error) {
    if (error instanceof FlowError) return new Response(null, { status: 404, headers });
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "55P03" || code === "57014" || code === "40001") return Response.json({ status: "busy" }, { status: 503, headers });
    throw error;
  }
}
