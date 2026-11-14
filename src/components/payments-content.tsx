import React from "react";
import { CompletionCheck } from "./v3/completion-check";
import { RoleAvatar } from "./v3/role-avatar";
import { TurnTag } from "./v3/turn-tag";
import { makeT, translate, type Locale } from "@/i18n";
import { brandV3Copy } from "@/i18n/lanes/brand-v3";
import { ErrorBanner, PageHeader, statusClass, statusKey } from "./ui";
import { moneyLabel } from "@/server/format";
import { displaySampleName } from "@/server/sandbox-data";
import type { listPayments } from "@/server/queries";
import type { StaffPaymentTurns } from "@/server/b3-payment-turns";

type PaymentAction = (formData: FormData) => void | Promise<void>;
export function PaymentsContent({ rows, locale, error, canAct, canReverse, reverseNote, emptyState, actions, v3 = false, turns }: {
  rows: Awaited<ReturnType<typeof listPayments>>; locale: Locale; error?: string;
  canAct: boolean; canReverse: boolean; reverseNote: string; emptyState?: React.ReactNode;
  actions: { confirm: PaymentAction; reject: PaymentAction; reverse: PaymentAction };
  v3?: boolean; turns?: StaffPaymentTurns;
}) {
  const t = makeT(locale), copy = brandV3Copy(locale);
  const ready = v3 && turns?.state === "ready" ? turns : undefined;
  const others = new Set(ready?.others.map(row => row.id));
  const { confirm: actionConfirmPayment, reject: actionRejectPayment, reverse: actionReversePayment } = actions;
  return (
    <>
      <PageHeader title={t("i_nav_inbox")} />
      {ready && ready.yourTurn >= 1 && <p className="v3-payment-count">{translate(copy, "awaitingReview", { count: ready.yourTurn })}</p>}
      <ErrorBanner t={t} error={error} />
      <div className="card">
        {rows.length === 0 ? (
          emptyState
        ) : (
          <table className="t rf">
            <thead>
              <tr>
                <th>{t("s_74f19b0")}</th>
                <th>{t("i_paid_on")}</th>
                <th>{t("i_last5")}</th>
                <th className="num">{t("i_amount_label")}</th>
                <th>{t("i_status")}</th>
                {ready && <th>{copy.turnHolder}</th>}
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
                    {moneyLabel(Number(row.amount), row.currency, locale)}
                  </td>
                  <td data-label={t("i_status")}>
                    {v3 && row.status === "confirmed" ? <CompletionCheck /> : null}
                    <span className={`chip ${statusClass(row.status)}`}>{t(statusKey(row.status))}</span>
                  </td>
                  {ready && <td className="v3-payment-holder-cell" data-label={copy.turnHolder}>
                    {canAct && row.status === "submitted" ? <span className="v3-payment-holder"><RoleAvatar role="m" locale={locale} /><TurnTag>{translate(copy, "yourTurnStep", { step: t("i_confirm_received") })}</TurnTag></span>
                      : others.has(row.id) ? <span className="v3-payment-holder"><RoleAvatar role="t" locale={locale} /><span>{translate(copy, "waitingTenant", { name: "" })}</span></span> : null}
                  </td>}
                  <td className="r">
                    {row.status === "confirmed" ? (
                      canReverse ? (
                        <form action={actionReversePayment} data-testid="reverse-form">
                          <input type="hidden" name="paymentId" value={row.id} />
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
                          <button className={ready ? "btn sm v3-confirm-payment" : "btn sm pri"} type="submit" data-testid="confirm-payment">
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
