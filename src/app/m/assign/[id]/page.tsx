import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AssignLoading } from "@/components/v3/m/settings/assign";
import { AssignEditSection } from "@/components/v3/m/settings/assign-page";
import { maintUnitAssignEnabledForOrg } from "@/server/b059-maint-unit-assign";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { isUuid } from "@/server/repair-rules";
import { withPageFlagGate } from "@/server/page-flag-gate";

export const dynamic = "force-dynamic";

/**
 * B-059 / 負責的單位・{名字} (MGT-118-AC1, AC2, AC7, AC8; GS-24 from 團隊, GS-46 from 單位分派). Exists only under
 * brand_v3 with maint_unit_assign on; OFF, or a failed flag lookup, is a 404 before the id or any other read. A
 * person who is not a maintenance member or pending maintenance invitation of this organization is `assign-perm`.
 */
export default withPageFlagGate({
  flagKey: "maint_unit_assign",
  flag: async session => (await brandV3EnabledForOrg(session.orgId)) && (await maintUnitAssignEnabledForOrg(session.orgId)),
}, async ({ params }: { params: Promise<{ id: string }> }, session) => {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  // eslint-disable-next-line @next/next/no-css-tags
  return <><link rel="stylesheet" href="/brand/v3/assign.css" /><Suspense fallback={<AssignLoading locale={session.locale} edit />}><AssignEditSection session={session} target={id} /></Suspense></>;
});
