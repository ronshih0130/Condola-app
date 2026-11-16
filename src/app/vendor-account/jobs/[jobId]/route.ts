import { SESSION_COOKIE } from "@/server/auth";
import { ORG_COOKIE } from "@/server/org-scope";
import { cookieFrom, vendorWorkbenchJobToken } from "@/server/vendor-workbench";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

/**
 * B-063 V-HOME / V-JOBS / V-RECV row 「查看」: opens that job's existing page (/v/[token]). The account session
 * must hold this job through both B-026 reads in the open workbench organization; anything else is a bare
 * 404 that says nothing about the job.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const token = await vendorWorkbenchJobToken(cookieFrom(request, SESSION_COOKIE), cookieFrom(request, ORG_COOKIE), jobId);
  if (!token) return new Response(null, { status: 404, headers });
  return new Response(null, { status: 303, headers: { ...headers, Location: `/v/${encodeURIComponent(token)}` } });
}
