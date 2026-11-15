import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { areasFor, tabsFor } from "@/server/nav-v3";
import { ManagerShellV3 } from "@/components/v3/shell/manager-shell";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { BUILD_SHA } from "@/build-info";
import { Sidebar, TaskPanel } from "@/components/chrome";
import { requireCurrentConsent } from "@/server/consent-gate";
import { demoModeEnabled } from "@/server/demo";
import { noPermHref } from "@/server/perms";
import { loadManagerChrome } from "@/server/queries";
import { getSession } from "@/server/session";
import { trialBannerFor } from "@/server/b056-trial";
import { TrialBanner } from "@/components/b056-trial-banner";

export const dynamic = "force-dynamic";

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind === "tenant") redirect("/t");
  if (session.kind === "owner") redirect("/o");
  const path = (await headers()).get("x-pathname") || "";
  await requireCurrentConsent(session, "page", path || "/m");
  const denied = noPermHref(path, session);
  if (denied) redirect(denied);
  const jar = await cookies();
  const { flags, firm, badge } = await loadManagerChrome(session);
  const banner = session.kind === "staff" ? await trialBannerFor(session) : null;
  if (await brandV3EnabledForOrg(session.orgId)) {
    return <ManagerShellV3 areas={areasFor(session)} tabs={tabsFor(session)}
      locale={session.locale} name={session.name} role={session.role} firm={firm.name}
      sandbox={session.environment === "sandbox"} showReset={demoModeEnabled() && session.role === "admin"}
      buildSha={BUILD_SHA}
      trialBanner={banner ? <TrialBanner locale={session.locale} banner={banner} next={path || "/m"} /> : null}>
      {children}
    </ManagerShellV3>;
  }
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
          {banner ? <TrialBanner locale={session.locale} banner={banner} next={path || "/m"} /> : null}
          {children}
          <p className="foot build-sha" data-testid="build-sha">
            {BUILD_SHA}
          </p>
        </div>
      </div>
    </>
  );
}
