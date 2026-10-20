import { redirect } from "next/navigation";
import { roleHome } from "@/server/perms";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ContinuePage() {
  const session = await getSession();
  redirect(roleHome(session.kind, session.role));
}
