import { notFound } from "next/navigation";
import { TopupPage } from "@/components/v3/topup/page";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { isUuid } from "@/server/repair-rules";
import { withPageFlagGate } from "@/server/page-flag-gate";

export const dynamic = "force-dynamic";

/** MO-TOPUP owner view (MGT-151-AC1/AC2): the same version, read only. brand_v3 OFF is a 404. */
export default withPageFlagGate({
  flagKey: "brand_v3",
  flag: async session => session.kind === "owner" && (await brandV3EnabledForOrg(session.orgId)),
}, async ({ params }: { params: Promise<{ id: string }> }, session) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  // eslint-disable-next-line @next/next/no-css-tags
  return <><link rel="stylesheet" href="/brand/v3/topup.css" /><TopupPage session={session} leaseId={id} retryHref={`/o/leases/${id}/settlement`} /></>;
});
