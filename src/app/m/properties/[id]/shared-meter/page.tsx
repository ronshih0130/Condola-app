import { notFound } from "next/navigation";
import { SharedMeterPage } from "@/components/v3/m/shared-meter/page";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { isUuid } from "@/server/repair-rules";
import { withPageFlagGate } from "@/server/page-flag-gate";

export const dynamic = "force-dynamic";

/** B-109 ADV-METER, 物件 › 進階設定 › 公用電表 (MGT-90-AC4…AC6). Exists only under brand_v3 and shared_meter. */
export default withPageFlagGate({
  flagKey: "brand_v3",
  flag: async session => brandV3EnabledForOrg(session.orgId),
}, async ({ params }: { params: Promise<{ id: string }> }, session) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  // eslint-disable-next-line @next/next/no-css-tags
  return <><link rel="stylesheet" href="/brand/v3/shared-meter.css" /><SharedMeterPage session={session} propertyId={id} /></>;
});
