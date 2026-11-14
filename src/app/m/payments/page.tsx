import { PaymentsContent } from "@/components/payments-content";
import { staffPaymentTurns } from "@/server/b3-payment-turns";
import { omitForbidden } from "@/lib/b3-payment-ui";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { ManagementEmptyState } from "@/components/management-empty-state";
import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { actionReversePayment } from "@/server/auth-actions";
import { actionConfirmPayment, actionRejectPayment } from "@/server/actions";
import { can, rolesFor } from "@/server/perms";
import { listPayments } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const v3 = await brandV3EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  const params = await searchParams;
  // A refusal from the turn reader leaves the list as it is today; it does not take the page down.
  const [rows, turns] = await Promise.all([listPayments(session), v3 ? omitForbidden(() => staffPaymentTurns(session)) : undefined]);
  const canAct = can(session, "pay.record");
  const canReverse = can(session, "pay.reverse");
  const roleLabel: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  const reverseNote = t("pm_need", {
    roles: rolesFor("pay.reverse")
      .map((role) => t(roleLabel[role]))
      .join(t("i_list_sep")),
  });
  return <PaymentsContent rows={rows} locale={session.locale} error={params.error} canAct={canAct} canReverse={canReverse}
    reverseNote={reverseNote} v3={v3} turns={turns} emptyState={<ManagementEmptyState session={session} page="PAY" />}
    actions={{ confirm: actionConfirmPayment, reject: actionRejectPayment, reverse: actionReversePayment }} />;
}
