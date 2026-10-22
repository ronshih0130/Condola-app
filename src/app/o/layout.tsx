import { redirect } from "next/navigation";
import { OwnerNav } from "@/components/owner-nav";
import { ownerPropertyNames } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind !== "owner") redirect("/m");
  const properties = await ownerPropertyNames(session);
  return <OwnerNav properties={properties}>{children}</OwnerNav>;
}
