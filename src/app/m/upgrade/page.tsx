import { getSession } from "@/server/session";
import { upgradeGate } from "@/server/upgrade-gate";
import { FREE_UNITS } from "@/server/billing";
import { requireCurrentConsent } from "@/server/consent-gate";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The bank-transfer application no longer renders. Settings is the plan screen. */
export default async function UpgradePage() {
  await requireCurrentConsent(undefined, "page");
  const gate = await upgradeGate(await getSession(), FREE_UNITS);
  if (gate.redirectTo) redirect(gate.redirectTo);
  redirect("/m/settings");
}
