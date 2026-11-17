import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { parseReopenInput, staffReopenRepair } from "@/server/b097-vendor-close";
import { requireCurrentConsent } from "@/server/consent-gate";
import { FlowError } from "@/server/errors";
import { readCapped } from "@/server/http-body";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** B-097 RV-MGR 重開 (MGT-146-AC3/AC4): admin / manager with tickets.update, within 7 days of the vendor's close. */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return new Response(null, { status: 415, headers });
  }
  let session;
  try { session = await guardEffectiveSession(await readSession(), "tickets.update"); } catch { return new Response(null, { status: 403, headers }); }
  if (!session) return new Response(null, { status: 401, headers });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const body = await readCapped(request, 4096);
  if (body === null) return new Response(null, { status: 413, headers });
  let input: ReturnType<typeof parseReopenInput>;
  try { input = parseReopenInput(JSON.parse(body)); } catch { input = null; }
  if (!input) return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  try {
    const result = await staffReopenRepair(session, input);
    const status = result.status === "reopened" ? 200 : result.status === "rejected_invalid" ? 400 : 409;
    return Response.json(result, { status, headers });
  } catch (error) {
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (error instanceof FlowError || code === "42501") return new Response(null, { status: 403, headers });
    if (code === "55P03" || code === "57014" || code === "40001" || code === "40P01") return Response.json({ status: "busy" }, { status: 503, headers });
    throw error;
  }
}
