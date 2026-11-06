import { rebindVendorAccount, inviteVendorAccount, correctVendorJobAccount, authorizeVendorAccountStaffRequest, vendorAccountLinkEvents } from "@/server/vendor-accounts";
import { FlowError } from "@/server/errors";
export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  try {
    const session = await authorizeVendorAccountStaffRequest(request);
    const text = await request.text();
    if (text.length > 2048) return new Response(null, { status: 413, headers });
    const input = JSON.parse(text);
    if (input?.action === "invite" && typeof input.contactId === "string" && typeof input.userId === "string") {
      return Response.json(await inviteVendorAccount(session, input.contactId, input.userId), { headers });
    }
    if (input?.action === "rebind" && typeof input.contactId === "string" && typeof input.userId === "string") {
      return Response.json(await rebindVendorAccount(session, input.contactId, input.userId), { headers });
    }
    if (input?.action === "correct" && typeof input.jobId === "string" && (typeof input.userId === "string" || input.userId === null)) {
      return Response.json(await correctVendorJobAccount(session, input.jobId, input.userId), { headers });
    }
    return new Response(null, { status: 400, headers });
  } catch (error) {
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (error instanceof SyntaxError) return new Response(null, { status: 400, headers });
    if (code === "55P03") return new Response(null, { status: 503, headers });
    if (error instanceof FlowError || code === "42501") return new Response(null, { status: 403, headers });
    throw error;
  }
}

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const session = await authorizeVendorAccountStaffRequest(request);
    return Response.json(await vendorAccountLinkEvents(session, new URL(request.url).searchParams.get("jobId") ?? ""), { headers });
  } catch (error) {
    if (error instanceof FlowError) return new Response(null, { status: 403, headers });
    throw error;
  }
}
