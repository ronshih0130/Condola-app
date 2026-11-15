import { ManagementEmptyState } from "@/components/management-empty-state";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader, statusClass, statusKey } from "@/components/ui";
import { actionReversePayment } from "@/server/auth-actions";
import { actionConfirmPayment, actionRejectPayment } from "@/server/actions";
import { moneyLabel } from "@/server/format";
import { can, rolesFor } from "@/server/perms";
import { listPayments } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";

import type { Session } from "@/server/types";

export async function LegacyPaymentsList({ session, error, returnTo }: { session: Session; error?: string; returnTo?: "/m/payments/list" }) {
  const t = makeT(session.locale);
  const rows = await listPayments(session);
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
  return (
    <>
      <PageHeader title={t("i_nav_inbox")} />
      <ErrorBanner t={t} error={error} />
      <div className="card">
        {rows.length === 0 ? (
          <ManagementEmptyState session={session} page="PAY" />
        ) : (
          <table className="t rf">
            <thead>
              <tr>
                <th>{t("s_74f19b0")}</th>
                <th>{t("i_paid_on")}</th>
                <th>{t("i_last5")}</th>
                <th className="num">{t("i_amount_label")}</th>
                <th>{t("i_status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {displaySampleName(row.tenant)}
                    <div className="small muted">{displaySampleName(row.place)}</div>
                  </td>
                  <td data-label={t("i_paid_on")}>{row.paid_on}</td>
                  <td data-label={t("i_last5")}>{row.last5}</td>
                  <td className="num" data-label={t("i_amount_label")}>
                    {moneyLabel(Number(row.amount), row.currency, session.locale)}
                  </td>
                  <td data-label={t("i_status")}>
                    <span className={`chip ${statusClass(row.status)}`}>{t(statusKey(row.status))}</span>
                  </td>
                  <td className="r">
                    {row.status === "confirmed" ? (
                      canReverse ? (
                        <form action={actionReversePayment} data-testid="reverse-form">
                          <input type="hidden" name="paymentId" value={row.id} />
                          {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
                          <input className="inp" name="reason" placeholder={t("i_reverse_reason")} data-testid="reverse-reason" />
                          <button className="btn sm" type="submit">
                            {t("i_reverse")}
                          </button>
                        </form>
                      ) : (
                        <button className="btn sm" type="button" disabled title={reverseNote} aria-disabled="true" data-testid="reverse-disabled">
                          {t("i_reverse")}
                        </button>
                      )
                    ) : null}
                    {canAct && row.status === "submitted" ? (
                      <div className="row">
                        <form action={actionConfirmPayment}>
                          <input type="hidden" name="paymentId" value={row.id} />
                          {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
                          <button className="btn sm pri" type="submit" data-testid="confirm-payment">
                            {t("i_confirm_received")}
                          </button>
                        </form>
                        <form action={actionRejectPayment}>
                          <input type="hidden" name="paymentId" value={row.id} />
                          {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
                          <input className="inp" name="reason" placeholder={t("i_reject_reason")} />
                          <button className="btn sm danger" type="submit">
                            {t("i_reject")}
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
