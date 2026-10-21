import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The bank-transfer application no longer renders. Settings is the plan screen. */
export default function UpgradePage() {
  redirect("/m/settings");
}
