import { requireCurrentConsent } from "@/server/consent-gate";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The bank-transfer application no longer renders. Settings is the plan screen. */
export default async function UpgradePage() {
  await requireCurrentConsent(undefined, "page");
  redirect("/m/settings");
}
