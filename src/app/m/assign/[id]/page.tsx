import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AssignLoading } from "@/components/v3/m/settings/assign";
import { AssignEditSection } from "@/components/v3/m/settings/assign-page";
import { maintUnitAssignEnabledForOrg } from "@/server/b059-maint-unit-assign";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import { isUuid } from "@/server/repair-rules";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * B-059 / 負責的單位・{名字} (MGT-118-AC1, AC2, AC7, AC8; GS-24 from 團隊, GS-46 from 單位分派). Exists only under
 * brand_v3 with maint_unit_assign on; OFF, or a failed flag lookup, is a 404 before the id or any other read. A
 * person who is not a maintenance member or pending maintenance invitation of this organization is `assign-perm`.
 */
export default async function AssignEditRoute({ params }: { params: Promise<{ id: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  if (!(await brandV3EnabledForOrg(session.orgId))) notFound();
  if (!(await maintUnitAssignEnabledForOrg(session.orgId))) notFound();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  // eslint-disable-next-line @next/next/no-css-tags
  return <><link rel="stylesheet" href="/brand/v3/assign.css" /><Suspense fallback={<AssignLoading locale={session.locale} edit />}><AssignEditSection session={session} target={id} /></Suspense></>;
}
