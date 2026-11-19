import { Suspense } from "react";
import { notFound } from "next/navigation";
import { RulesLoading } from "@/components/v3/o/rules/rules";
import { RulesPage } from "@/components/v3/o/rules/page";
import { ownerRuleViewOnce } from "@/server/b094-owner-rules";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { withPageFlagGate } from "@/server/page-flag-gate";

export const dynamic = "force-dynamic";

/**
 * B-094 / RO-RULES (更多 › 授權規則, OWN-34). Exists only under brand_v3 with owner_rules on; otherwise a 404.
 * Only "off" is a 404: a forbidden or failed read renders B1-NOPERM or the error in place. The off check blocks
 * before the skeleton (like the brand_v3 check); its read is shared with the layout and the body (one per request).
 */
export default withPageFlagGate({
  flagKey: "brand_v3",
  flag: async session => brandV3EnabledForOrg(session.orgId),
}, async (_props: object, session) => {
  if ((await ownerRuleViewOnce(session)).state === "off") notFound();
  return <Suspense fallback={<RulesLoading locale={session.locale} />}><RulesPage session={session} /></Suspense>;
});
