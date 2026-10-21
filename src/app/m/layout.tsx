import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar, TaskPanel } from "@/components/chrome";
import { demoModeEnabled } from "@/server/demo";
import { can, permForPath, requiresAdmin } from "@/server/perms";
import { loadManagerChrome } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind === "tenant") redirect("/t");
  if (session.kind === "owner") redirect("/o");
  const path = (await headers()).get("x-pathname") || "";
  if (requiresAdmin(path) && session.role !== "admin") redirect("/m/noperm?need=settings.edit");
  const perm = permForPath(path);
  if (perm && !can(session.role, perm)) redirect(`/m/noperm?need=${perm}`);
  const jar = await cookies();
  const { flags, firm, badge } = await loadManagerChrome(session);
  return (
    <>
      {session.environment === "live" ? null : (
        <TaskPanel flags={flags} hidden={jar.get("condola_tryout_hide")?.value === "1"} />
      )}
      <input id="nav-open" className="nav-check" type="checkbox" />
      <div className="app">
        <label htmlFor="nav-open" className="nav-backdrop" aria-hidden="true" />
        <Sidebar
          firm={firm.name}
          pending={badge.pending}
          tickets={badge.tickets}
          role={session.role}
          showReset={demoModeEnabled() && session.role === "admin"}
          showDemo={session.environment !== "live"}
        />
        <div className="main">{children}</div>
      </div>
    </>
  );
}
