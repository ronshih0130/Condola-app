import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar, TaskPanel } from "@/components/chrome";
import { counts, loadFirm, loadTryout } from "@/server/queries";
import { getSession, listPersonas } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind === "tenant") redirect("/t");
  if (session.kind === "owner") redirect("/o");
  const jar = await cookies();
  const [flags, firm, badge, personas] = await Promise.all([
    loadTryout(session),
    loadFirm(session),
    counts(session),
    listPersonas(),
  ]);
  return (
    <>
      <TaskPanel flags={flags} hidden={jar.get("condola_tryout_hide")?.value === "1"} />
      <input id="nav-open" className="nav-check" type="checkbox" />
      <div className="app">
        <label htmlFor="nav-open" className="nav-backdrop" aria-hidden="true" />
        <Sidebar
          firm={firm.name}
          pending={badge.pending}
          tickets={badge.tickets}
          personas={personas.map((persona) => ({ id: persona.id, name: persona.name }))}
          current={session.userId}
        />
        <div className="main">{children}</div>
      </div>
    </>
  );
}
