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
  return <EmptyState id={page === "MSG" && setup.tenantJoined ? "MSG_joined" : page} locale={session.locale} cta={cta} />;
}
