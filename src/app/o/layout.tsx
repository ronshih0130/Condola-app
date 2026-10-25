import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { OwnerNav } from "@/components/owner-nav";
import { entryConsentRedirect } from "@/server/consent-gate";
import { ownerPropertyNames } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind !== "owner") redirect("/m");
  const path = (await headers()).get("x-pathname") || "";
  const gate = await entryConsentRedirect(session.userId, "portal", path || "/o");
  if (gate) redirect(gate);
  const properties = await ownerPropertyNames(session);
  return <OwnerNav properties={properties}>{children}</OwnerNav>;
}
