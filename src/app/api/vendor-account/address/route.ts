import { parseSaveInput, saveVendorAddress } from "@/server/b112-vendor-address";
import { SESSION_COOKIE } from "@/server/auth";
import { FlowError } from "@/server/errors";
import { ORG_COOKIE } from "@/server/org-scope";
import { cookieFrom, vendorWorkbenchAccess } from "@/server/vendor-workbench";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** B-112: the signed-in vendor saves their confirmed address (workbench 我的帳號). Account session only; in-app only. */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return new Response(null, { status: 415, headers });
  const text = await request.text();
  if (text.length > 4096) return new Response(null, { status: 413, headers });
  let input: ReturnType<typeof parseSaveInput>;
  try { input = parseSaveInput(JSON.parse(text)); } catch { input = null; }
  if (!input) return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  const credential = cookieFrom(request, SESSION_COOKIE);
  try {
    // Same admission as the workbench pages: live account session, current terms, an open workbench org.
    const access = await vendorWorkbenchAccess(credential, cookieFrom(request, ORG_COOKIE));
    if (access.state !== "on" || !credential) return new Response(null, { status: 403, headers });
    const result = await saveVendorAddress(credential, access.scope.orgId, input);
    const status = result.status === "recorded" || result.status === "unchanged" ? 200 : result.status === "rejected_invalid" ? 400 : 409;
    return Response.json(result, { status, headers });
  } catch (error) {
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (error instanceof FlowError || code === "42501") return new Response(null, { status: 403, headers });
    if (code === "55P03" || code === "57014") return Response.json({ status: "busy" }, { status: 503, headers });
    throw error;
  }
}
