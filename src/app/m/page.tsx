import { NotificationCenterEntry } from "@/components/notification-center-entry";
import { DashboardContent } from "@/components/dashboard-content";
import { requireCurrentConsent } from "@/server/consent-gate";
import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { staffPaymentTurns } from "@/server/b3-payment-turns";
import { omitFailure, omitForbidden } from "@/lib/b3-payment-ui";
import { logServerError } from "@/server/errors";
import { can } from "@/server/perms";
import { taipeiToday } from "@/server/money";
import { readSetupStep } from "@/server/onboarding-progress";
import { resolveEmptyCta } from "@/lib/empty-cta";
import { dashboard, rentRoll } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ dupFirm?: string; code?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await guardEffectiveSession(await getSession(), "dash.view");
  const v3 = await brandV3EnabledForOrg(session.orgId);
  const [v2, query, data, setup, turns, bills] = await Promise.all([
    brandV2EnabledForOrg(session.orgId), searchParams, dashboard(session), readSetupStep(session),
    v3 ? omitForbidden(() => staffPaymentTurns(session)) : undefined,
    v3 && can(session, "stmt.view") ? omitFailure(() => rentRoll(session), error => logServerError("b3_today_bills", error)) : undefined,
  ]);
  const cta = resolveEmptyCta({ page: "DASH", setup, can: key => setup.permissions.includes(key) });
  return <DashboardContent session={session} data={data} setup={setup} cta={cta} query={query} v2={v2}
    v3={v3} turns={turns} bills={bills} month={v3 ? Number(taipeiToday().slice(5, 7)) : undefined}
    notificationEntry={<NotificationCenterEntry session={session} />} />;
}
