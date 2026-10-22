import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionary, makeT } from "@/i18n";
import { AuditHistory } from "@/components/audit-log";
import { PayDialog } from "@/components/dialogs";
import { LeaseTermsForm } from "@/components/lease-terms-form";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { PortalInviteButton } from "@/components/portal-invite-button";
import { ErrorBanner, PageHeader, chargeKey, statusClass, statusKey } from "@/components/ui";
import { actionMessage, actionSign, actionSimulateSign, actionUploadSignedPdf } from "@/server/actions";
import { showDemoLineCopy } from "@/server/demo";
import { formatDate, moneyLabel } from "@/server/format";
import { majorField } from "@/server/portfolio";
import { leaseTermsEditable } from "@/server/lease-rules";
import { portalLoginReady } from "@/server/portal-invite";
import { isUuid } from "@/server/repair-rules";
import { leaseDetail, threadMessages } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function LeasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; error?: string; audit?: string; created?: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const tab = query.tab || "summary";
  const session = await getSession();
  const t = makeT(session.locale);
  const dict = dictionary(session.locale);
  const detail = await leaseDetail(session, id);
  if (!detail) notFound();
  const { lease, signatures } = detail;
  const canInvite = session.role === "admin" || session.role === "manager";
  const tenantActivated = canInvite ? await portalLoginReady(lease.tenant_user_id) : false;
  const money = (minor: number) => moneyLabel(minor, lease.currency, session.locale);
  const tenantSig = signatures.find((row) => row.role === "tenant");
  const managerSig = signatures.find((row) => row.role === "manager");
  const tabs = [
    ["summary", "s_6b6fe14"],
    ["ledger", "s_6ef99a0"],
    ["sign", "s_8ecfcf9"],
    ["msg", "s_b95abdb"],
  ] as const;
  const messages = tab === "msg" && lease.thread_id ? await threadMessages(session, lease.thread_id) : [];
  return (
    <>
      <PageHeader
        title={
          <>
            {displaySampleName(lease.tenant)} <span className="small muted">{displaySampleName(lease.place)}</span>
          </>
        }
        crumb={<Link href="/m/leases">{t("s_fba85ae")}</Link>}
        actions={
          <PdfDownloadButton
            href={`/api/pdf/leases/${id}`}
            label={t("s_874a842")}
            failed={t("pdf_failed")}
            fontFailed={t("pdf_font_missing")}
            testId="download-lease-pdf"
          />
        }
      />
      <ErrorBanner t={t} error={query.error} />
      {query.created === "1" ? (
        <div className="alert ok" data-testid="lease-created">
          {t("i_lease_created")}
        </div>
      ) : null}
      <div className="tabsx">
        {tabs.map(([key, label]) => (
          <Link key={key} className={tab === key ? "on" : ""} href={`/m/leases/${id}?tab=${key}`}>
            {t(label)}
          </Link>
        ))}
      </div>
      {tab === "summary" ? (
        <div className="grid2">
          <div className="card">
            <table className="t">
              <tbody>
                <tr>
                  <td>{t("i_period")}</td>
                  <td>
                    {formatDate(lease.start_date, session.locale, session.calendar, dict)} – {formatDate(lease.end_date, session.locale, session.calendar, dict)}
                  </td>
                </tr>
                <tr>
                  <td>{t("i_rent_label")}</td>
                  <td data-testid="summary-rent">{money(Number(lease.rent))}</td>
                </tr>
                <tr>
                  <td>{t("i_deposit_label")}</td>
                  <td data-testid="summary-deposit">{money(Number(lease.deposit))}</td>
                </tr>
                {lease.deposit_override_reason ? (
                  <tr data-testid="deposit-override-reason">
                    <td>{t("lease_deposit_reason")}</td>
                    <td>{lease.deposit_override_reason}</td>
                  </tr>
                ) : null}
                <tr>
                  <td>{t("i_due_day_label")}</td>
                  <td>{lease.due_day}</td>
                </tr>
                <tr>
                  <td>{t("i_status")}</td>
                  <td>
                    <span className={`chip ${statusClass(lease.status)}`}>{t(statusKey(lease.status))}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card pad">
            <h3>{displaySampleName(lease.tenant)}</h3>
            <p data-testid="tenant-phone">{lease.phone || "•••"}</p>
            <p className="small muted">{lease.email}</p>
            {showDemoLineCopy(session.environment) && lease.line_user_id ? <p data-testid="tenant-line-id">{lease.line_user_id}</p> : null}
            {canInvite ? (
              <div key={id} data-lease-page={id}>
                <PortalInviteButton
                  key={`${lease.tenant_contact_id}:${id}`}
                  kind="tenant"
                  contactId={lease.tenant_contact_id}
                  leaseId={id}
                  activated={tenantActivated}
                />
              </div>
            ) : null}
            {lease.status !== "active" ? (
              <p>
                <Link href={`/m/leases/${id}?tab=sign`}>{t("s_8ecfcf9")}</Link>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {tab === "summary" && (session.role === "admin" || session.role === "manager") ? (
        leaseTermsEditable({
          status: lease.status,
          esign: lease.esign,
          signed: Boolean(lease.signed_at) || signatures.some((row) => row.status === "signed"),
        }) ? (
          <LeaseTermsForm
            key={lease.updated_at}
            leaseId={id}
            rent={majorField(lease.rent, lease.currency)}
            depositMonths={lease.deposit_months ?? ""}
            depositReason={lease.deposit_override_reason ?? ""}
            updatedAt={lease.updated_at}
          />
        ) : (
          <p className="small muted" data-testid="lease-terms-locked" style={{ marginTop: 16 }}>
            {t("lease_terms_locked")}
          </p>
        )
      ) : null}
      {tab === "ledger" ? (
        <div className="card">
          <div className="hd">
            <h3>{t("i_invoice")}</h3>
            <span className="sp" />
            {detail.dueMinor > 0 ? (
              <PayDialog leaseId={id} dueMinor={detail.dueMinor} currency={lease.currency} label={t("s_a924c4c")} returnTo="staff" />
            ) : null}
          </div>
          {detail.invoices.length === 0 ? (
            <div className="empty">
              {t("i_no_invoice_yet")} <Link href={`/m/leases/${id}?tab=sign`}>{t("s_8ecfcf9")}</Link>
            </div>
          ) : (
            <table className="t">
              <tbody>
                <tr>
                  <td>{t("i_charge_rent")}</td>
                  <td className="num" data-testid="invoice-rent" data-minor={detail.rentMinor}>
                    {money(detail.rentMinor)}
                  </td>
                </tr>
                <tr>
                  <td>{t("i_charge_utility")}</td>
                  <td className="num" data-testid="invoice-utility" data-minor={detail.utilityMinor}>
                    {money(detail.utilityMinor)}
                  </td>
                </tr>
                <tr>
                  <td>{t("i_charge_deposit")}</td>
                  <td className="num" data-testid="invoice-deposit" data-minor={detail.depositMinor}>
                    {money(detail.depositMinor)}
                  </td>
                </tr>
                {detail.lines
                  .filter((line) => !["rent", "utility", "deposit"].includes(line.charge_type))
                  .map((line, index) => (
                    <tr key={`${line.invoice_id}-${index}`}>
                      <td>{t(chargeKey(line.charge_type))}</td>
                      <td className="num">{money(Number(line.amount))}</td>
                    </tr>
                  ))}
                <tr className="grp">
                  <td>{t("i_open_balance")}</td>
                  <td className="num">{money(detail.invoices.reduce((sum, invoice) => sum + Number(invoice.balance), 0))}</td>
                </tr>
              </tbody>
            </table>
          )}
          <div className="bd">
            <p className="small">{t("i_money_note", { brand: t("i_brand") })}</p>
          </div>
        </div>
      ) : null}
      {tab === "sign" ? (
        <div className="grid2">
          <div className="card pad">
            <h3>{t("i_tenant_pending")}</h3>
            <ul className="tl">
              <li className={tenantSig?.status === "signed" ? "on" : ""}>
                <b>{tenantSig?.status === "signed" ? t("i_tenant_signed") : t("i_tenant_pending")}</b>
                <div className="small muted">{tenantSig?.signed_at ? t("i_signed_at", { time: tenantSig.signed_at }) : t("i_sign_pending")}</div>
              </li>
              <li className={managerSig?.status === "signed" ? "on" : ""}>
                <b>{managerSig?.status === "signed" ? t("i_fully_signed") : t("i_await_manager")}</b>
                <div className="small muted">{managerSig?.signed_at ? t("i_signed_at", { time: managerSig.signed_at }) : t("i_sign_pending")}</div>
              </li>
            </ul>
            {tenantSig?.status !== "signed" ? (
              <form action={actionSimulateSign}>
                <input type="hidden" name="leaseId" value={id} />
                <button className="btn pri lg block" type="submit" data-testid="simulate-tenant-sign">
                  {t("s_bbba58a")}
                </button>
              </form>
            ) : null}
            <div style={{ marginTop: 16 }} data-testid="paper-sign">
              <h3>{t("lease_paper_upload")}</h3>
              <p className="small muted">{t("lease_paper_hint")}</p>
              {lease.signed_pdf ? (
                <p data-testid="paper-signed">
                  {t("lease_paper_signed")}{" "}
                  <a href={`/m/leases/${id}/signed`}>{lease.signed_pdf}</a>
                </p>
              ) : null}
              {session.role === "admin" || session.role === "manager" ? (
                <form action={actionUploadSignedPdf}>
                  <input type="hidden" name="leaseId" value={id} />
                  <input className="inp" type="file" name="signedPdf" accept="application/pdf,.pdf" data-testid="signed-pdf" />
                  <button className="btn" type="submit" data-testid="upload-signed-pdf" style={{ marginTop: 8 }}>
                    {t("lease_paper_upload")}
                  </button>
                </form>
              ) : null}
            </div>
          </div>
          <div className="card pad">
            <h3>{t("i_manager_sign")}</h3>
            {managerSig?.status === "signed" ? (
              <div className="alert ok">{t("i_fully_signed")}</div>
            ) : (
              <form action={actionSign}>
                <input type="hidden" name="leaseId" value={id} />
                <div className="fg">
                  <label className="f">{t("i_sign_name")}</label>
                  <input className="inp" name="signedName" data-testid="sign-name" defaultValue="" placeholder={session.name} />
                </div>
                <label className="small">
                  <input type="checkbox" name="consent" data-testid="sign-consent" /> {t("i_sign_consent")}
                </label>
                <div style={{ marginTop: 12 }}>
                  <button className="btn pri" type="submit" data-testid="submit-sign">
                    {t("s_fc0cfbd")}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
      {tab === "msg" ? (
        <div className="card pad">
          {messages.map((message) => (
            <p key={message.id} className={message.mine ? "b" : ""}>
              {message.body}
            </p>
          ))}
          {lease.thread_id ? (
            <form action={actionMessage}>
              <input type="hidden" name="threadId" value={lease.thread_id} />
              <textarea className="inp" name="body" rows={3} placeholder={t("i_message")} />
              <button className="btn pri" type="submit" style={{ marginTop: 8 }}>
                {t("i_send")}
              </button>
            </form>
          ) : (
            <p className="muted">{t("i_no_invoice_yet")}</p>
          )}
        </div>
      ) : null}
      <AuditHistory
        table="leases"
        rowId={id}
        cursor={query.audit}
        path={`/m/leases/${id}`}
        preserve={{ tab: tab === "summary" ? undefined : tab, error: query.error }}
      />
    </>
  );
}
