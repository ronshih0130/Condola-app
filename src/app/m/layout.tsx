import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { BUILD_SHA } from "@/build-info";
import { Sidebar, TaskPanel } from "@/components/chrome";
import { demoModeEnabled } from "@/server/demo";
import { noPermHref } from "@/server/perms";
import { loadManagerChrome } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind === "tenant") redirect("/t");
  if (session.kind === "owner") redirect("/o");
  const path = (await headers()).get("x-pathname") || "";
  const denied = noPermHref(path, session.role);
  if (denied) redirect(denied);
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
          sandbox={session.environment === "sandbox"}
        />
        <div className="main">
          {children}
          <p className="foot build-sha" data-testid="build-sha">
            {BUILD_SHA}
          </p>
        </div>
      </div>
    </>
  );
}
