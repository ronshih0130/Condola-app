import { Suspense } from "react";
import { notFound } from "next/navigation";
import { RulesLoading } from "@/components/v3/o/rules/rules";
import { RulesPage } from "@/components/v3/o/rules/page";
import { ownerRuleView } from "@/server/b091-owner-rules";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * B-094 / RO-RULES (更多 › 授權規則, OWN-34). Exists only under brand_v3 with owner_rules on; otherwise a 404.
 * Only "off" is a 404: a forbidden or failed read renders B1-NOPERM or the error in place.
 */
export default async function OwnerRulesRoute() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  if (!(await brandV3EnabledForOrg(session.orgId))) notFound();
  if ((await ownerRuleView(session)).state === "off") notFound();
  return <Suspense fallback={<RulesLoading locale={session.locale} />}><RulesPage session={session} /></Suspense>;
}
