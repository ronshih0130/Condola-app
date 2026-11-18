import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AssignLoading } from "@/components/v3/m/settings/assign";
import { AssignListSection } from "@/components/v3/m/settings/assign-page";
import { maintUnitAssignEnabledForOrg } from "@/server/b059-maint-unit-assign";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * B-059 / 設定 › 單位分派 (MGT-118-AC1…AC8; GS-46 entry). Exists only under brand_v3 with maint_unit_assign on; OFF,
 * or a failed flag lookup, is a 404 before any other read. Admin and manager see the list; accountants and maintenance
 * see `assign-perm` in place (AC7). The skeleton shows while the gateway reads (AC8).
 */
export default async function AssignRoute() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  if (!(await brandV3EnabledForOrg(session.orgId))) notFound();
  if (!(await maintUnitAssignEnabledForOrg(session.orgId))) notFound();
  // eslint-disable-next-line @next/next/no-css-tags
  return <><link rel="stylesheet" href="/brand/v3/assign.css" /><Suspense fallback={<AssignLoading locale={session.locale} />}><AssignListSection session={session} /></Suspense></>;
}
