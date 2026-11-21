import { TodayPage } from "@/components/v3/m/today/today";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { readTodayMonthly, readTodayTurns, readTodayTurn } from "@/server/today-v3";
import { NotificationCenterEntry } from "@/components/notification-center-entry";
import { DashboardContent } from "@/components/dashboard-content";
import { requireCurrentConsent } from "@/server/consent-gate";
import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { readSetupStep } from "@/server/onboarding-progress";
import { resolveEmptyCta } from "@/lib/empty-cta";
import { dashboard } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ dupFirm?: string; code?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await guardEffectiveSession(await getSession(), "dash.view");
  if (await brandV3EnabledForOrg(session.orgId)) {
    // B3A-TODAY-NUM interim rule: 未結餘額, 報修 and 出租 stay below the large number until their destination pages show them.
    const [turns, monthly, setup, query, legacy] = await Promise.all([
      readTodayTurns(session), readTodayMonthly(session),
      session.role === "admin" || session.role === "manager" ? readTodayTurn(async () => ({ state: "ready" as const, setup: await readSetupStep(session) })) : undefined,
      searchParams,
      readTodayTurn(async () => ({ state: "ready" as const, data: await dashboard(session) })),
    ]);
    return <TodayPage session={session} turns={turns} monthly={monthly} interim={legacy.state === "ready" ? legacy.data : undefined} setup={setup?.state === "ready" ? setup.setup : undefined} setupFailed={setup?.state === "unavailable"} query={query} />;
  }
  const [v2, query, data, setup] = await Promise.all([
    brandV2EnabledForOrg(session.orgId), searchParams, dashboard(session), readSetupStep(session),
  ]);
  const cta = resolveEmptyCta({ page: "DASH", setup, can: key => setup.permissions.includes(key) });
  return <DashboardContent session={session} data={data} setup={setup} cta={cta} query={query} v2={v2}
    notificationEntry={<NotificationCenterEntry session={session} />} />;
}
