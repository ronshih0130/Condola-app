import { Suspense } from "react";
import { AssignLoading } from "@/components/v3/m/settings/assign";
import { AssignListSection } from "@/components/v3/m/settings/assign-page";
import { maintUnitAssignEnabledForOrg } from "@/server/b059-maint-unit-assign";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { withPageFlagGate } from "@/server/page-flag-gate";

export const dynamic = "force-dynamic";

/**
 * B-059 / 設定 › 單位分派 (MGT-118-AC1…AC8; GS-46 entry). Exists only under brand_v3 with maint_unit_assign on; OFF,
 * or a failed flag lookup, is a 404 before any other read. Admin and manager see the list; accountants and maintenance
 * see `assign-perm` in place (AC7). The skeleton shows while the gateway reads (AC8).
 */
export default withPageFlagGate({
  flagKey: "maint_unit_assign",
  flag: async session => (await brandV3EnabledForOrg(session.orgId)) && (await maintUnitAssignEnabledForOrg(session.orgId)),
}, async (_props: object, session) => {
  // eslint-disable-next-line @next/next/no-css-tags
  return <><link rel="stylesheet" href="/brand/v3/assign.css" /><Suspense fallback={<AssignLoading locale={session.locale} />}><AssignListSection session={session} /></Suspense></>;
});
