import { OwnerShellV3 } from "@/components/v3/shell/owner-shell";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { ownerPrivacy } from "@/server/auth";
import { centerSessionAdmission } from "@/server/notification-center";
import { ownerReceiptTitleView } from "@/server/owner-finance-replies";
import { ownerNavigationV3 } from "@/server/nav-v3";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ownerRepairPolicyEntryIds } from "@/server/repair-owner-policy";
import { OwnerNav } from "@/components/owner-nav";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { requireCurrentConsent } from "@/server/consent-gate";
import { ownerPropertyNames } from "@/server/queries";
import { repairApprovalsEnabled } from "@/server/repair-approval";
import { ownerRulesAvailable } from "@/server/b094-owner-rules";
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
  if (await brandV3EnabledForOrg(session.orgId)) {
    const firm = await ownerPrivacy(session.orgId);
    const admission = await centerSessionAdmission(session);
    const receiptTitle = await ownerReceiptTitleView(session);
    // RO-MORE / OV-SH-MORE: 核准紀錄 only while its page is live for the org; a failed read hides it.
    const decided = await repairApprovalsEnabled(session.orgId).catch(() => false);
    // RO-MORE: 授權規則 only while owner_rules is live for this owner; a failed read hides it.
    const rules = await ownerRulesAvailable(session);
    return <OwnerShellV3 locale={session.locale} name={session.name} firm={firm.name}
      canSwitchToTenant={Boolean(session.portals?.owner && session.portals.tenant)}
      navigation={ownerNavigationV3(session, properties, repairPolicyIds, admission, Boolean(receiptTitle), decided, rules)}>{children}</OwnerShellV3>;
  }
  return <OwnerNav properties={properties} repairPolicyIds={repairPolicyIds} {...(v2 ? { v2: true } : {})}>{children}</OwnerNav>;
}
