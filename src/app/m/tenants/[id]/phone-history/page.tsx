import { notFound } from "next/navigation";
import { PhoneHistoryView } from "@/components/v3/m/tenants/phone-history";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { parseAfter, parseTrail, phoneHistory } from "@/server/b076a-phone-history";
import { isUuid } from "@/server/repair-rules";
import { withPageFlagGate } from "@/server/page-flag-gate";

export const dynamic = "force-dynamic";

/** mgr-history-direct (B-076a), 物件與租客 › {租客} › 改號紀錄. brand_v3 OFF or tenant_directory_edit OFF is a 404. */
export default withPageFlagGate({
  flagKey: "brand_v3",
  flag: async session => brandV3EnabledForOrg(session.orgId),
}, async ({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ after?: string | string[]; trail?: string | string[] }>;
}, session) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const after = parseAfter(query.after), trail = parseTrail(query.trail, after);
  const data = await phoneHistory(session, id, { after });
  if (data.state === "off") notFound();
  // eslint-disable-next-line @next/next/no-css-tags
  return <><link rel="stylesheet" href="/brand/v3/tenants.css" /><PhoneHistoryView data={data} id={id} locale={session.locale} after={after} trail={trail} /></>;
});
