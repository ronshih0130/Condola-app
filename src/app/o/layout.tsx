import { redirect } from "next/navigation";
import { OwnerNav } from "@/components/owner-nav";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind !== "owner") redirect("/m");
  return <OwnerNav>{children}</OwnerNav>;
}
