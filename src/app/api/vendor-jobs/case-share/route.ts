import { vendorCaseShare } from "@/server/b110-case-share";
import { FlowError } from "@/server/errors";
import { vendorTokenAcceptable } from "@/server/vendor-repair-rules";
import { readSmallBody } from "@/server/b110-body";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** B-110 ven-copy-link: the B-105 case bearer checks, opens or copies its closed case's read-only link. In-app only. */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return new Response(null, { status: 415, headers });
  const text = await readSmallBody(request, 1024);
  if (text === null) return new Response(null, { status: 413, headers });
  let fields: { token?: unknown; mode?: unknown };
  try { fields = JSON.parse(text); } catch { return new Response(null, { status: 400, headers }); }
  if (typeof fields?.token !== "string" || !vendorTokenAcceptable(fields.token)
    || (fields.mode !== "check" && fields.mode !== "open" && fields.mode !== "copy")) return new Response(null, { status: 400, headers });
  try {
    return Response.json(await vendorCaseShare(fields.token, fields.mode, new URL(request.url).origin), { headers });
  } catch (error) {
    if (error instanceof FlowError) return new Response(null, { status: error.key === "errors.required" ? 400 : 404, headers });
    throw error;
  }
}
