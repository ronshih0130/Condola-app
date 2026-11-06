import { authorizeVendorAccountRequest, claimVendorAccount, syncVendorAccount, vendorAccountHistory } from "@/server/vendor-accounts";
import { FlowError } from "@/server/errors";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  if (code === "55P03") return Response.json({ status: "busy" }, { status: 503, headers });
  if (error instanceof FlowError || code === "42501") return new Response(null, { status: 403, headers });
  throw error;
}
export async function GET(request: Request) {
  try {
    const credential = await authorizeVendorAccountRequest(request);
    return Response.json(await vendorAccountHistory(credential), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  try {
    const credential = await authorizeVendorAccountRequest(request);
    const text = await request.text();
    if (text.length > 2048) return new Response(null, { status: 413, headers });
    let input: { action?: unknown; invitation?: unknown };
    try { input = JSON.parse(text); } catch { return new Response(null, { status: 400, headers }); }
    if (input?.action === "sync") return Response.json(await syncVendorAccount(credential), { headers });
    if (input?.action !== "claim" || typeof input.invitation !== "string") return new Response(null, { status: 400, headers });
    return Response.json(await claimVendorAccount(credential, input.invitation), { headers });
  } catch (error) { return failure(error); }
}
