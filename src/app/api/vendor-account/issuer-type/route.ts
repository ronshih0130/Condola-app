import { parseIssuerInput, saveVendorIssuerType } from "@/server/b065-vendor-activation";
import { SESSION_COOKIE } from "@/server/auth";
import { FlowError } from "@/server/errors";
import { ORG_COOKIE } from "@/server/org-scope";
import { cookieFrom, vendorWorkbenchAccess } from "@/server/vendor-workbench";
import { readCapped } from "@/server/http-body";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

const MAX_BODY_BYTES = 1024;

/** B-065: the signed-in vendor declares their issuer type (我的帳號 › 開立類型). Account session only; in-app only. */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return new Response(null, { status: 415, headers });
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return new Response(null, { status: 413, headers });
  let input: ReturnType<typeof parseIssuerInput>;
  try { input = parseIssuerInput(JSON.parse(text)); } catch { input = null; }
  if (!input) return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  const credential = cookieFrom(request, SESSION_COOKIE);
  try {
    // Same admission as the workbench pages: live account session, current terms, an open workbench org.
    const access = await vendorWorkbenchAccess(credential, cookieFrom(request, ORG_COOKIE));
    if (access.state !== "on" || !credential) return new Response(null, { status: 403, headers });
    const result = await saveVendorIssuerType(credential, access.scope.orgId, input);
    const status = result.status === "recorded" || result.status === "unchanged" ? 200 : result.status === "rejected_invalid" ? 400 : 409;
    return Response.json(result, { status, headers });
  } catch (error) {
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (error instanceof FlowError || code === "42501") return new Response(null, { status: 403, headers });
    if (code === "55P03" || code === "57014") return Response.json({ status: "busy" }, { status: 503, headers });
    throw error;
  }
}
