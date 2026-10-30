import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ownerRepairPolicyEntryIds } from "@/server/repair-owner-policy";
import { OwnerNav } from "@/components/owner-nav";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { requireCurrentConsent } from "@/server/consent-gate";
import { ownerPropertyNames } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const v2 = await brandV2EnabledForOrg(session.orgId);
  if (session.kind !== "owner") redirect("/m");
  const path = (await headers()).get("x-pathname") || "";
  await requireCurrentConsent(session, "page", path || "/o");
  const properties = await ownerPropertyNames(session);
  const repairPolicyIds = await ownerRepairPolicyEntryIds(session, properties.map(property => property.id));
  return <OwnerNav properties={properties} repairPolicyIds={repairPolicyIds} {...(v2 ? { v2: true } : {})}>{children}</OwnerNav>;
}
