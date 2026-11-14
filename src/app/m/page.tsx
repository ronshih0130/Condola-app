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
  const [v2, query, data, setup] = await Promise.all([
    brandV2EnabledForOrg(session.orgId), searchParams, dashboard(session), readSetupStep(session),
  ]);
  const cta = resolveEmptyCta({ page: "DASH", setup, can: key => setup.permissions.includes(key) });
  return <DashboardContent session={session} data={data} setup={setup} cta={cta} query={query} v2={v2}
    notificationEntry={<NotificationCenterEntry session={session} />} />;
}
