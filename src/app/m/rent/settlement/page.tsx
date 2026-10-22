import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { Cell, RfTable } from "@/components/rf";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionCorrectBillPayment, actionRecordBillPayment, actionReverseBillPayment } from "@/server/actions";
import { moneyLabel } from "@/server/format";
import { taipeiToday } from "@/server/money";
import { can, rolesFor } from "@/server/perms";
import { loadRentSettlement } from "@/server/rent-settlement";
import { isSettlementMethod, minorNumber, minorToAmountText, SETTLEMENT_METHODS } from "@/server/rent-settlement-math";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

const METHOD_KEY = {
  bank_transfer: "i_settle_method_bank",
  cash: "i_settle_method_cash",
  check: "i_settle_method_check",
  other: "i_settle_method_other",
} as const;

export default async function RentSettlementPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; month?: string }>;
}) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const page = await loadRentSettlement(session, params.month, taipeiToday());
  if (!page) notFound();
  const canRecord = can(session.role, "pay.record");
  const canReverse = can(session.role, "pay.reverse");
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
  const money = (minor: bigint, currency: string) => moneyLabel(minorNumber(minor), currency, session.locale);
  return (
    <div data-testid="settlement-page">
      <PageHeader title={t("i_settle_title")} />
      <p className="muted" data-testid="settlement-lead">
        {t("i_settle_lead", { brand: t("i_brand") })}
      </p>
      <ErrorBanner t={t} error={params.error} />
      <form className="filters" action="/m/rent/settlement" method="get" data-testid="settlement-month-form">
        <label className="f">{t("i_month")}</label>
        <input className="inp" type="month" name="month" defaultValue={page.month} data-testid="settlement-month" />
        <button className="btn" type="submit">
          {t("i_settle_apply")}
        </button>
      </form>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>{t("i_settle_bills")}</h3>
        </div>
        {page.bills.length === 0 ? (
          <div className="empty">{t("i_settle_empty_bills")}</div>
        ) : (
          <RfTable testId="settlement-bills">
            <thead>
              <tr>
                <th>{t("i_settle_tenant")}</th>
                <th>{t("i_col_property")}</th>
                <th>{t("i_owner")}</th>
                <th>{t("i_settle_bill")}</th>
                <th>{t("i_settle_paid")}</th>
                <th>{t("i_settle_unpaid")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.bills.map((bill) => (
                <tr key={bill.id} data-testid="bill-row">
                  <Cell>{displaySampleName(bill.tenant)}</Cell>
                  <Cell label={t("i_col_property")}>{displaySampleName(bill.property)}</Cell>
                  <Cell label={t("i_owner")}>{displaySampleName(bill.owner)}</Cell>
                  <Cell label={t("i_settle_bill")}>{bill.number}</Cell>
                  <Cell label={t("i_settle_paid")}>{money(bill.paidMinor, bill.currency)}</Cell>
                  <Cell label={t("i_settle_unpaid")}>
                    <span data-testid="bill-unpaid">{money(bill.balanceMinor, bill.currency)}</span>
                  </Cell>
                  <Cell action>
                    {canRecord ? (
                      <form action={actionRecordBillPayment} data-testid="record-bill-form">
                        <input type="hidden" name="invoiceId" value={bill.id} />
                        <input type="hidden" name="month" value={page.month} />
                        <input className="inp" type="date" name="paidOn" defaultValue={page.paidOn} data-testid="bill-paid-on" required />
                        <input
                          className="inp"
                          name="amount"
                          data-testid="bill-amount"
                          inputMode={bill.currency === "TWD" ? "numeric" : "decimal"}
                          placeholder={bill.currency === "TWD" ? t("i_settle_amount") : t("i_amount_label")}
                          required
                        />
                        <select className="inp" name="method" data-testid="bill-method" defaultValue="bank_transfer">
                          {SETTLEMENT_METHODS.map((method) => (
                            <option key={method} value={method}>
                              {t(METHOD_KEY[method])}
                            </option>
                          ))}
                        </select>
                        <button className="btn sm pri" type="submit" data-testid="bill-submit">
                          {t("i_settle_mark")}
                        </button>
                      </form>
                    ) : null}
                  </Cell>
                </tr>
              ))}
            </tbody>
          </RfTable>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>{t("i_settle_history")}</h3>
        </div>
        {page.payments.length === 0 ? (
          <div className="empty">{t("i_settle_no_payments")}</div>
        ) : (
          <RfTable testId="settlement-payments">
            <thead>
              <tr>
                <th>{t("i_settle_tenant")}</th>
                <th>{t("i_settle_bill")}</th>
                <th>{t("i_settle_paid_on")}</th>
                <th>{t("i_settle_method")}</th>
                <th>{t("i_settle_paid")}</th>
                <th>{t("i_status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.payments.map((payment) => (
                <tr key={payment.id} data-testid="payment-row" data-status={payment.status}>
                  <Cell>{displaySampleName(payment.tenant)}</Cell>
                  <Cell label={t("i_settle_bill")}>{payment.invoiceNumber}</Cell>
                  <Cell label={t("i_settle_paid_on")}>{payment.paidOn}</Cell>
                  <Cell label={t("i_settle_method")}>
                    {isSettlementMethod(payment.method) ? t(METHOD_KEY[payment.method]) : payment.method}
                  </Cell>
                  <Cell label={t("i_settle_paid")}>
                    <span data-testid="payment-amount">{money(payment.amountMinor, payment.currency)}</span>
                  </Cell>
                  <Cell label={t("i_status")}>
                    <span className={`chip ${payment.status === "confirmed" ? "ok" : ""}`}>
                      {payment.status === "confirmed" ? t("i_settle_paid") : t("i_settle_reversed")}
                    </span>
                  </Cell>
                  <Cell action>
                    {payment.status === "confirmed" && canRecord ? (
                      <form action={actionCorrectBillPayment} data-testid="correct-form">
                        <input type="hidden" name="paymentId" value={payment.id} />
                        <input type="hidden" name="month" value={page.month} />
                        <input className="inp" type="date" name="paidOn" defaultValue={payment.paidOn} data-testid="correct-paid-on" required />
                        <input
                          className="inp"
                          name="amount"
                          data-testid="correct-amount"
                          defaultValue={minorToAmountText(payment.amountMinor, payment.currency)}
                          inputMode={payment.currency === "TWD" ? "numeric" : "decimal"}
                          required
                        />
                        <select className="inp" name="method" defaultValue={isSettlementMethod(payment.method) ? payment.method : "other"}>
                          {SETTLEMENT_METHODS.map((method) => (
                            <option key={method} value={method}>
                              {t(METHOD_KEY[method])}
                            </option>
                          ))}
                        </select>
                        <input className="inp" name="reason" placeholder={t("i_settle_reason")} data-testid="correct-reason" required />
                        <button className="btn sm" type="submit" data-testid="correct-submit">
                          {t("i_settle_correct")}
                        </button>
                      </form>
                    ) : null}
                    {payment.status === "confirmed" ? (
                      canReverse ? (
                        <form action={actionReverseBillPayment} data-testid="reverse-bill-form">
                          <input type="hidden" name="paymentId" value={payment.id} />
                          <input type="hidden" name="month" value={page.month} />
                          <input className="inp" name="reason" placeholder={t("i_reverse_reason")} data-testid="reverse-bill-reason" required />
                          <button className="btn sm" type="submit" data-testid="reverse-bill-submit">
                            {t("i_reverse")}
                          </button>
                        </form>
                      ) : (
                        <button className="btn sm" type="button" disabled title={reverseNote} aria-disabled="true" data-testid="reverse-bill-disabled">
                          {t("i_reverse")}
                        </button>
                      )
                    ) : null}
                  </Cell>
                </tr>
              ))}
            </tbody>
          </RfTable>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>{t("i_settle_title")}</h3>
          <span className="sp" />
          <a className="btn" href={`/m/rent/settlement/export?month=${page.month}`} data-testid="settlement-csv">
            {t("i_settle_csv")}
          </a>
        </div>
        <p className="small muted" data-testid="settlement-direct">
          {t("i_settle_direct")}
        </p>
        {page.owners.length === 0 ? (
          <div className="empty">{t("i_settle_empty_owners")}</div>
        ) : (
          <RfTable testId="settlement-owners">
            <thead>
              <tr>
                <th>{t("i_owner")}</th>
                <th>{t("i_month")}</th>
                <th>{t("i_settle_currency")}</th>
                <th>{t("i_settle_rent")}</th>
                <th>{t("i_settle_fee")}</th>
                <th>{t("i_settle_net")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.owners.map((owner) => (
                <tr key={`${owner.ownerId}-${owner.currency}`} data-testid="settlement-row" data-owner={owner.ownerId} data-currency={owner.currency}>
                  <Cell>{displaySampleName(owner.ownerName)}</Cell>
                  <Cell label={t("i_month")}>{owner.month}</Cell>
                  <Cell label={t("i_settle_currency")}>{owner.currency}</Cell>
                  <Cell label={t("i_settle_rent")}>
                    <span data-testid="settlement-rent">{money(owner.rentMinor, owner.currency)}</span>
                  </Cell>
                  <Cell label={t("i_settle_fee")}>
                    <span data-testid="settlement-fee">{money(owner.feeMinor, owner.currency)}</span>
                  </Cell>
                  <Cell label={t("i_settle_net")}>
                    <span data-testid="settlement-net">
                      {owner.owesMinor > BigInt(0)
                        ? `${t("owner_owes")} ${money(owner.owesMinor, owner.currency)}`
                        : money(owner.payableMinor, owner.currency)}
                    </span>
                  </Cell>
                  <Cell action>
                    <PdfDownloadButton
                      href={`/api/pdf/settlements?owner=${owner.ownerId}&month=${page.month}&currency=${owner.currency}`}
                      label={t("i_settle_pdf")}
                      failed={t("pdf_failed")}
                      fontFailed={t("pdf_font_missing")}
                      testId="download-settlement-pdf"
                    />
                  </Cell>
                </tr>
              ))}
            </tbody>
          </RfTable>
        )}
      </div>
    </div>
  );
}
