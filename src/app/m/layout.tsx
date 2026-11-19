import { shellTodayTitle } from "@/i18n/lanes/brand-v3";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { areasFor, tabsFor } from "@/server/nav-v3";
import { maintUnitAssignEnabledForOrg } from "@/server/b059-maint-unit-assign";
import { ManagerShellV3 } from "@/components/v3/shell/manager-shell";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { BUILD_SHA } from "@/build-info";
import { Sidebar, TaskPanel } from "@/components/chrome";
import { requireCurrentConsent } from "@/server/consent-gate";
import { demoModeEnabled } from "@/server/demo";
import { can, hasPersonalReminders, noPermHref } from "@/server/perms";
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
  const routeDenied = noPermHref(path, session);
  // Brand 3.0 money month page: the two exact month routes have independent bill (stmt.view) and report
  // (pay.record) readers, so either key admits them under brand_v3. Nested routes keep their gates. The flag
  // is read here only for that case, so the OFF path keeps its reader and redirect order (PLT-46-AC1).
  const moneyV3 = routeDenied && /^\/m\/(payments|rent)\/?$/.test(path) && (can(session, "stmt.view") || can(session, "pay.record"))
    ? await brandV3EnabledForOrg(session.orgId) : undefined;
  // Exact report page only: nested routes, including export, retain reports.export.
  const reportV3 = routeDenied && /^\/m\/reports\/?$/.test(path) && can(session, "stmt.view")
    ? await brandV3EnabledForOrg(session.orgId) : undefined;
  // R5-NOTIFY (MGT-135-AC1): 設定 › 通知設定 also opens for a manager (寄給我的) under brand_v3; exact route only.
  const notifyV3 = routeDenied && /^\/m\/notify\/?$/.test(path) && hasPersonalReminders(session)
    ? await brandV3EnabledForOrg(session.orgId) : undefined;
  const denied = moneyV3 || reportV3 || notifyV3 ? null : routeDenied;
  if (denied) redirect(denied);
  const jar = await cookies();
  const { flags, firm, badge } = await loadManagerChrome(session);
  const banner = session.kind === "staff" ? await trialBannerFor(session) : null;
  // Each of moneyV3 / reportV3 / notifyV3 is itself this organization's brand_v3 answer (read only on its route), so
  // the v3 shell is chosen exactly when brand_v3 is ON.
  const brandV3 = moneyV3 ?? reportV3 ?? notifyV3 ?? await brandV3EnabledForOrg(session.orgId);
  if (brandV3) {
    // B-059 (GS-46): the 設定 › 單位分派 row needs brand_v3 AND maint_unit_assign (as its page does), and only for
    // admin and manager; a failed lookup hides it.
    const nav = { maintAssign: brandV3 === true && ["admin", "manager"].includes(session.customRole?.nativeRole ?? session.role ?? "")
      ? await maintUnitAssignEnabledForOrg(session.orgId) : false };
    // /api/env accepts native staff roles; its null-key guard refuses assigned custom roles.
    return <ManagerShellV3 areas={areasFor(session, nav)} tabs={tabsFor(session, nav)}
      locale={session.locale} name={session.name} role={session.role} firm={firm.name}
      sandbox={session.environment === "sandbox"} showReset={demoModeEnabled() && session.role === "admin"}
      hasLiveCompany={Boolean(session.liveOrgId)}
      canSwitchCompany={session.kind === "staff" && Boolean(session.role && session.liveOrgId) && (!session.customRole || session.customRole.assigned === false)}
      todayTitle={shellTodayTitle(new Date(), session.locale)}
      buildSha={BUILD_SHA}
      // The layout is kept across client navigation, so eligibility must not depend on the first path;
      // the shell shows the banner only on /m (SH-TRIAL), and dismissal returns to /m.
      trialBanner={banner && session.role === "admin" && session.environment === "live" ? <TrialBanner shellV3 locale={session.locale} banner={banner} next="/m" /> : null}>
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
