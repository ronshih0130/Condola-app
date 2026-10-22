import Link from "next/link";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionConfirmPayment, actionRegisterRent, actionRejectPayment } from "@/server/actions";
import { actionReversePayment } from "@/server/auth-actions";
import { moneyLabel } from "@/server/format";
import { taipeiToday } from "@/server/money";
import { can } from "@/server/perms";
import { paymentBoard } from "@/server/queries";
import { civilPeriodLabel } from "@/server/rent-settlement-math";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

const FIELD_ERROR: Record<string, string> = {
  "pay.lease": "i_pay_err_lease",
  "pay.kind": "i_pay_err_kind",
  "pay.period": "i_pay_err_period",
  "pay.payee": "i_pay_err_required",
  "pay.amount": "i_pay_err_amount",
  "pay.date": "i_pay_err_date",
};

function monthDay(iso: string) {
  const [, month, day] = iso.slice(0, 10).split("-");
  return `${month}/${day}`;
}

function daysAfter(due: string, today: string) {
  const start = Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const today = taipeiToday();
  const month = params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : today.slice(0, 7);
  const board = await paymentBoard(session, month);
  const canAct = can(session.role, "pay.record");
  const canReverse = can(session.role, "pay.reverse");
  const query = (params.q ?? "").trim();
  const status = params.status ?? "";
  const money = (minor: number) => moneyLabel(minor, "TWD", session.locale);
  const periodLabel = (period: string | null) => (period && /^\d{4}-\d{2}$/.test(period) ? civilPeriodLabel(period) : civilPeriodLabel(month));

  const recorded = board.payments
    .filter((row) => row.status === "confirmed" && row.charge_kind !== "deposit")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const pending = board.payments
    .filter((row) => row.status === "submitted")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const unpaid = board.open.reduce((sum, row) => sum + Number(row.balance), 0);

  const matches = (tenant: string | null, place: string) => {
    if (!query) return true;
    const hay = `${tenant ?? ""} ${place}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  };
  const payments = board.payments.filter((row) => matches(row.tenant, row.place));
  const open = board.open.filter((row) => matches(row.tenant, row.place));
  const showPayments = status === "" || status === "recorded" || status === "pending" || status === "reversed" || status === "partial";
  const showOpen = status === "" || status === "unpaid" || status === "partial";
  const visiblePayments = payments.filter((row) => {
    if (status === "recorded") return row.status === "confirmed";
    if (status === "pending") return row.status === "submitted";
    if (status === "reversed") return row.status === "reversed";
    if (status === "partial") return false;
    return true;
  });
  const visibleOpen = showOpen ? open : [];
  const empty = visiblePayments.length === 0 && visibleOpen.length === 0;
  const formOpen = params.open === "1" || Boolean(params.error) || params.notice === "duplicate";
  const fieldKey = params.error ? FIELD_ERROR[params.error] : undefined;
  const duplicateAmount = params.amount ? money(Number(params.amount) * 100) : "";

  return (
    <>
      <PageHeader
        title={t("i_nav_inbox")}
        actions={
          canAct ? (
            <form method="get" action="/m/payments">
              <input type="hidden" name="month" value={month} />
              <input type="hidden" name="open" value="1" />
              <button className="btn pri" type="submit" data-testid="register-rent">{t("i_pay_register")}</button>
            </form>
          ) : null
        }
      />
      <p className="small muted">{t("i_stmt_disclaimer")}</p>
      {board.leases.some((lease) => lease.records_only) ? (
        <div className="alert warn" data-testid="records-only">
          <p>{t("i_stmt_readonly")}</p>
          <button className="btn" type="button" disabled data-testid="edit-property">{t("i_edit")}</button>
          <button className="btn" type="button" disabled data-testid="edit-lease">{t("i_edit")}</button>
        </div>
      ) : null}
      {params.error && !fieldKey ? <ErrorBanner t={t} error={params.error} /> : null}
      {fieldKey ? (
        <div className="alert bad" data-testid="error-banner">
          <div>{params.error === "pay.lease" || params.error === "pay.kind" || params.error === "pay.period" || params.error === "pay.payee" ? t("i_pay_err_required") : t("i_pay_err_summary")}</div>
          <div>{t(fieldKey)}</div>
        </div>
      ) : null}
      <form className="row" method="get" action="/m/payments" style={{ marginBottom: 12 }}>
        <input className="inp" type="month" name="month" defaultValue={month} aria-label={civilPeriodLabel(month)} data-testid="payment-month" />
        <select className="inp" name="status" defaultValue={status} aria-label={t("i_pay_status_all")} data-testid="payment-status">
          <option value="">{t("i_pay_status_all")}</option>
          <option value="recorded">{t("i_pay_recorded")}</option>
          <option value="pending">{t("i_pay_pending")}</option>
          <option value="unpaid">{t("i_pay_unpaid")}</option>
          <option value="reversed">{t("i_pay_reversed")}</option>
          <option value="partial">{t("i_pay_partial")}</option>
        </select>
        <input className="inp" name="q" defaultValue={query} placeholder={t("i_pay_search")} data-testid="payment-search" />
        <button className="btn" type="submit">{civilPeriodLabel(month)}</button>
      </form>
      <p className="small" data-testid="payment-summary">
        {t("i_pay_summary", { recorded: money(recorded), pending: money(pending), unpaid: money(unpaid) })}
      </p>
      {formOpen && canAct ? (
        <form className="card pad" action={actionRegisterRent} data-testid="register-form" role="dialog" aria-modal="true" aria-label={t("i_pay_register")} style={{ marginBottom: 16, maxWidth: 640 }}>
          <h3>{t("i_pay_register")}</h3>
          <input type="hidden" name="month" value={month} />
          {params.notice === "duplicate" ? <input type="hidden" name="acceptDuplicate" value="1" /> : null}
          {params.notice === "duplicate" ? (
            <p className="alert warn" data-testid="duplicate-hint">{t("i_pay_dup", { amount: duplicateAmount || params.amount || "" })}</p>
          ) : null}
          <div className="fg">
            <label className="f">{t("i_pay_lease")}</label>
            <select className="inp" name="leaseId" defaultValue={params.leaseId ?? ""} data-testid="rent-lease" required>
              <option value="">{t("i_pay_choose")}</option>
              {board.leases.map((lease) => (
                <option key={lease.id} value={lease.id}>
                  {displaySampleName(lease.tenant)}・{displaySampleName(lease.place)}
                </option>
              ))}
            </select>
            {params.error === "pay.lease" ? <p className="small bad">{t("i_pay_err_lease")}</p> : null}
          </div>
          <div className="fg">
            <label className="f">{t("i_pay_kind")}</label>
            <select className="inp" name="kind" defaultValue={params.kind ?? ""} data-testid="rent-kind" required>
              <option value="">{t("i_pay_err_kind")}</option>
              <option value="rent">{t("i_pay_kind_rent", { period: civilPeriodLabel(params.period && /^\d{4}-\d{2}$/.test(params.period) ? params.period : month) })}</option>
              <option value="deposit">{t("i_pay_kind_deposit")}</option>
              <option value="other">{t("i_pay_kind_other")}</option>
            </select>
            {params.error === "pay.kind" ? <p className="small bad">{t("i_pay_err_kind")}</p> : null}
          </div>
          <div className="fg">
            <label className="f">{t("i_pay_period")}</label>
            <input className="inp" type="month" name="period" defaultValue={params.period ?? month} data-testid="rent-period" required />
            {params.error === "pay.period" ? <p className="small bad">{t("i_pay_err_period")}</p> : null}
          </div>
          <div className="fg">
            <label className="f">{t("i_pay_col_amount")}</label>
            <input className="inp" name="amount" inputMode="numeric" defaultValue={params.amount ?? ""} data-testid="rent-amount" required />
            {params.error === "pay.amount" ? <p className="small bad">{t("i_pay_err_amount")}</p> : null}
          </div>
          <div className="fg">
            <label className="f">{t("i_pay_date")}</label>
            <input className="inp" type="date" name="paidOn" max={today} defaultValue={params.paidOn ?? today} data-testid="rent-date" required />
            {params.error === "pay.date" ? <p className="small bad">{t("i_pay_err_date")}</p> : null}
          </div>
          <div className="fg">
            <label className="f">{t("i_pay_last5_opt")}</label>
            <input className="inp" name="last5" defaultValue={params.last5 ?? ""} inputMode="numeric" maxLength={5} data-testid="rent-last5" />
          </div>
          <div className="fg">
            <label className="f">{t("i_pay_note_opt")}</label>
            <input className="inp" name="note" defaultValue={params.note ?? ""} data-testid="rent-note" />
          </div>
          <div className="fg">
            <label className="f">{t("i_pay_col_payee")}</label>
            <select className="inp" name="payee" defaultValue={params.payee ?? ""} data-testid="rent-payee" required>
              <option value="">{t("i_pay_choose")}</option>
              <option value="owner">{t("i_stmt_payee_owner")}</option>
              <option value="firm">{t("i_stmt_payee_firm")}</option>
            </select>
          </div>
          <p className="small muted">{t("i_pay_deposit_note")}</p>
          <div className="row">
            <button className="btn pri" type="submit" data-testid="rent-save">{t("i_pay_save")}</button>
            <Link className="btn" href={`/m/payments?month=${month}`}>{t("i_pay_cancel")}</Link>
          </div>
        </form>
      ) : null}
      <div className="card">
        {empty ? (
          <div className="empty" data-testid="payments-empty">
            <b>{t("i_pay_empty_title")}</b>
            <p>{t("i_pay_empty_body")}</p>
            {canAct ? (
              <Link className="btn pri" href={`/m/payments?month=${month}&open=1`}>{t("i_pay_empty_cta")}</Link>
            ) : null}
          </div>
        ) : (
          <table className="t rf" data-testid="payment-list">
            <thead>
              <tr>
                <th>{t("i_pay_col_who")}</th>
                <th>{t("i_pay_col_date")}</th>
                <th>{t("i_pay_col_last5")}</th>
                <th className="num">{t("i_pay_col_amount")}</th>
                <th>{t("i_pay_col_status")}</th>
                <th>{t("i_pay_col_payee")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {showPayments
                ? visiblePayments.map((row) => {
                    const label =
                      row.status === "confirmed"
                        ? t("i_pay_recorded")
                        : row.status === "submitted"
                          ? t("i_pay_pending")
                          : row.status === "reversed"
                            ? t("i_pay_reversed")
                            : row.status === "rejected"
                              ? t("i_pay_rejected")
                              : row.status;
                    const payee = row.payee === "firm" ? t("i_stmt_payee_firm") : row.payee === "owner" ? t("i_stmt_payee_owner") : "";
                    return (
                      <tr key={row.id} data-status={row.status} data-testid="payment-record">
                        <td>
                          {displaySampleName(row.tenant ?? "")}
                          <div className="small muted">{displaySampleName(row.place)}</div>
                        </td>
                        <td data-label={t("i_pay_col_date")}>{row.paid_on}</td>
                        <td data-label={t("i_pay_col_last5")}>{row.last5 ?? ""}</td>
                        <td className="num" data-label={t("i_pay_col_amount")}>{money(Number(row.amount))}</td>
                        <td data-label={t("i_pay_col_status")}>
                          <span className="chip">{label}</span>
                          {row.status === "confirmed" ? <div className="small muted">{t("i_pay_arrived", { date: monthDay(row.paid_on) })}</div> : null}
                          {row.status === "reversed" && row.reverse_reason ? (
                            <div className="small muted">{t("i_pay_reverse_note", { reason: row.reverse_reason })}</div>
                          ) : null}
                        </td>
                        <td data-label={t("i_pay_col_payee")}>{payee}</td>
                        <td className="r">
                          {row.status === "confirmed" ? (
                            canReverse ? (
                              <form action={actionReversePayment} data-testid="reverse-form">
                                <input type="hidden" name="paymentId" value={row.id} />
                                <h3>{t("i_pay_reverse_title")}</h3>
                                <p className="small">
                                  {t("i_pay_reverse_body", {
                                    tenant: displaySampleName(row.tenant ?? ""),
                                    period: periodLabel(row.period),
                                    amount: money(Number(row.amount)),
                                  })}
                                </p>
                                <input className="inp" name="reason" placeholder={t("i_pay_reverse_ph")} aria-label={t("i_pay_reverse_reason")} data-testid="reverse-reason" required />
                                <button className="btn sm" type="submit" data-testid="reverse-payment">{t("i_pay_reverse_ok")}</button>
                              </form>
                            ) : (
                              <button className="btn sm" type="button" disabled title={t("i_pay_reverse_role")} aria-disabled="true" data-testid="reverse-payment">
                                {t("i_pay_reverse_ok")}
                              </button>
                            )
                          ) : null}
                          {canReverse && row.status === "submitted" ? (
                            <div className="row">
                              <form action={actionConfirmPayment}>
                                <input type="hidden" name="paymentId" value={row.id} />
                                <button className="btn sm pri" type="submit" data-testid="confirm-payment">{t("i_pay_confirm")}</button>
                              </form>
                              <form action={actionRejectPayment}>
                                <input type="hidden" name="paymentId" value={row.id} />
                                <input type="hidden" name="reason" value={t("i_pay_skip")} />
                                <button className="btn sm" type="submit" data-testid="reject-payment">{t("i_pay_skip")}</button>
                              </form>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })
                : null}
              {visibleOpen.map((row) => {
                const due = row.due_date ?? `${month}-05`;
                const late = daysAfter(due, today);
                const partial = Number(row.paid) > 0;
                return (
                  <tr key={row.id} data-status={partial ? "partial" : "unpaid"}>
                    <td>
                      {displaySampleName(row.tenant ?? "")}
                      <div className="small muted">{displaySampleName(row.place)}</div>
                    </td>
                    <td data-label={t("i_pay_col_date")}>{due}</td>
                    <td data-label={t("i_pay_col_last5")} />
                    <td className="num" data-label={t("i_pay_col_amount")}>{money(Number(row.balance))}</td>
                    <td data-label={t("i_pay_col_status")}>
                      <span className="chip warn">{partial ? t("i_pay_partial") : t("i_pay_unpaid")}</span>
                      {late > 0 ? <div className="small muted">{t("i_pay_overdue", { date: monthDay(due), days: late })}</div> : null}
                      {partial ? (
                        <div className="small muted">
                          {t("i_partial_note", { paid: money(Number(row.paid)), period: periodLabel(row.period_start?.slice(0, 7) ?? month) })}
                          <div>{t("i_partial_left", { left: money(Number(row.balance)) })}</div>
                        </div>
                      ) : null}
                    </td>
                    <td data-label={t("i_pay_col_payee")} />
                    <td />
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {!canReverse ? <p className="small muted">{t("i_pay_reverse_role")}</p> : null}
    </>
  );
}
