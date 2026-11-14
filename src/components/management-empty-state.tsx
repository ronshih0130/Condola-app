import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { Illustration } from "./v3/illustrations";
import { emptyPageAction, resolveEmptyCta, type EmptyPage } from "@/lib/empty-cta";
import { readSetupStep, type SetupProgress } from "@/server/onboarding-progress";
import type { Session } from "@/server/types";
import { EmptyState } from "./empty-state";

export async function ManagementEmptyState({ session, page, actionHref, progress }: {
  session: Session; page: EmptyPage; actionHref?: string; progress?: SetupProgress;
}) {
  const setup = progress ?? await readSetupStep(session);
  const own = emptyPageAction(page);
  const cta = resolveEmptyCta({ page, setup, can: key => setup.permissions.includes(key),
    pageAction: own && actionHref ? { ...own, href: actionHref } : own });
  const drawing = page === "PAY" ? "04" : page === "TIX" ? "05" : page === "MSG" ? "06" : null;
  const v3 = drawing !== null && await brandV3EnabledForOrg(session.orgId);
  return <EmptyState id={page === "MSG" && setup.tenantJoined ? "MSG_joined" : page} locale={session.locale} cta={cta} illustration={v3 && drawing ? <Illustration name={drawing} /> : undefined} />;
}
