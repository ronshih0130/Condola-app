import { Suspense } from "react";
import { DecidedLoading } from "@/components/v3/o/decided/decided";
import { DecidedListPage } from "@/components/v3/o/decided/page";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { withPageFlagGate } from "@/server/page-flag-gate";

export const dynamic = "force-dynamic";

/** B-093 / RO-DECIDED (更多 › 核准紀錄, OWN-35). Exists only under brand_v3; OFF is a 404. */
export default withPageFlagGate({
  flagKey: "brand_v3",
  flag: async session => brandV3EnabledForOrg(session.orgId),
}, async ({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }, session) => {
  const { after } = await searchParams;
  return <Suspense key={typeof after === "string" ? after : "first"} fallback={<DecidedLoading locale={session.locale} />}>
    <DecidedListPage session={session} after={after} />
  </Suspense>;
});
