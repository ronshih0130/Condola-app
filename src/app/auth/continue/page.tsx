import { redirect } from "next/navigation";
import { entryConsentRedirect } from "@/server/consent-gate";
import { roleHome } from "@/server/perms";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ContinuePage() {
  const session = await getSession();
  const home = roleHome(session.kind, session.role);
  const variant = session.kind === "owner" || session.kind === "tenant" ? "portal" : "reconsent";
  const gate = await entryConsentRedirect(session.userId, variant, home);
  if (gate) redirect(gate);
  redirect(home);
}
