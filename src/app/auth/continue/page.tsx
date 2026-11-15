import { redirect } from "next/navigation";
import { entryConsentRedirect } from "@/server/consent-gate";
import { roleHomeForSession } from "@/server/role-home-v3";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ContinuePage() {
  const session = await getSession();
  const home = await roleHomeForSession(session);
  const variant = session.kind === "owner" || session.kind === "tenant" ? "portal" : "reconsent";
  const gate = await entryConsentRedirect(session.userId, variant, home);
  if (gate) redirect(gate);
  redirect(home);
}
