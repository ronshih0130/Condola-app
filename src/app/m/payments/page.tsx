import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader, statusClass, statusKey } from "@/components/ui";
import { actionConfirmPayment, actionRejectPayment } from "@/server/actions";
import { formatMoney } from "@/server/format";
import { listPayments } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const rows = await listPayments(session);
  const canAct = session.role === "admin" || session.role === "manager" || session.role === "accountant";
  return (
    <>
      <PageHeader title={t("i_nav_inbox")} />
      <ErrorBanner t={t} error={params.error} />
      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">{t("i_none_pending")}</div>
        ) : (
          <table className="t">
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
                    {row.tenant}
                    <div className="small muted">{row.place}</div>
                  </td>
                  <td>{row.paid_on}</td>
                  <td>{row.last5}</td>
                  <td className="num">{formatMoney(Number(row.amount), row.currency, session.locale)}</td>
                  <td>
                    <span className={`chip ${statusClass(row.status)}`}>{t(statusKey(row.status))}</span>
                  </td>
                  <td>
                    {canAct && row.status === "submitted" ? (
                      <div className="row">
                        <form action={actionConfirmPayment}>
                          <input type="hidden" name="paymentId" value={row.id} />
                          <button className="btn sm pri" type="submit" data-testid="confirm-payment">
                            {t("i_confirm_received")}
                          </button>
                        </form>
                        <form action={actionRejectPayment}>
                          <input type="hidden" name="paymentId" value={row.id} />
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
