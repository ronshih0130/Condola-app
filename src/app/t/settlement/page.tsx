import { notFound } from "next/navigation";
import { TopupPage } from "@/components/v3/topup/page";
import { selectedLease } from "@/lib/tenant-lease";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";

export const dynamic = "force-dynamic";

/** MO-TOPUP tenant view (MGT-151-AC1/AC2): the selected lease's settlement, read only, no button. brand_v3 OFF is a 404. */
export default async function TenantSettlementPage() {
  await requireCurrentConsent(undefined, "page");
  const { session, lease } = await selectedLease();
  if (session.kind !== "tenant" || !lease || !(await brandV3EnabledForOrg(session.orgId))) notFound();
  // eslint-disable-next-line @next/next/no-css-tags
  return <><link rel="stylesheet" href="/brand/v3/topup.css" /><TopupPage session={session} leaseId={lease.lease_id} retryHref="/t/settlement" /></>;
}
