import { SESSION_COOKIE } from "@/server/auth";
import { ORG_COOKIE } from "@/server/org-scope";
import { cookieFrom, vendorWorkbenchJobOpen } from "@/server/vendor-workbench";
import { VENDOR_WORKBENCH, VENDOR_WORKBENCH_CONSENT, VENDOR_WORKBENCH_LOGIN } from "@/lib/vendor-workbench-paths";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const see = (location: string) => new Response(null, { status: 303, headers: { ...headers, Location: location } });

/**
 * B-063 V-HOME / V-JOBS / V-RECV row 「查看」: opens that job's existing page (/v/[token]). Same admission as the
 * sibling workbench routes: no account session or a job token alone → the vendor sign-in; terms not current →
 * consent; a signed-in non-vendor → the sibling route's B1-NOPERM; workbench OFF, or a job this account does not
 * hold in the open organization → a bare 404 that says nothing about the job.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const result = await vendorWorkbenchJobOpen(cookieFrom(request, SESSION_COOKIE), cookieFrom(request, ORG_COOKIE), jobId);
  if (result.state === "open") return see(`/v/${encodeURIComponent(result.token)}`);
  if (result.state === "login") return see(VENDOR_WORKBENCH_LOGIN);
  if (result.state === "consent") return see(VENDOR_WORKBENCH_CONSENT);
  if (result.state === "noperm") return see(VENDOR_WORKBENCH.jobs);
  return new Response(null, { status: 404, headers });
}
