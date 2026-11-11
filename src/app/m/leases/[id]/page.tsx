import { archiveCopy } from "@/i18n/record-archive";
import { HandoverEntry } from "@/components/handover-entry";
import { RenewalComparisonEntry } from "@/components/renewal-comparison-entry";
import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionary, makeT } from "@/i18n";
import { AuditHistory } from "@/components/audit-log";
import { ActualMoveOut } from "@/components/actual-moveout";
import { PayDialog } from "@/components/dialogs";
import { IdvCard } from "@/components/idv-card";
import { LeaseTermsForm } from "@/components/lease-terms-form";
import { FirstPeriodSummary } from "@/components/first-period-summary";
import { MoveInInvoicePreview } from "@/components/move-in-invoice-preview";
import { moveInPreview } from "@/server/move-in-preview";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { PortalResendEntry } from "@/components/portal-resend-entry";
import { PortalInviteButton } from "@/components/portal-invite-button";
import { ErrorBanner, PageHeader, chargeKey, statusClass, statusKey } from "@/components/ui";
import { actionMessage, actionSign, actionSimulateSign, actionUploadSignedPdf } from "@/server/actions";
import { showDemoLineCopy } from "@/server/demo";
import { maybe, tx } from "@/server/db";
import { formatDate, moneyLabel } from "@/server/format";
import { taipeiStamp } from "@/server/id-crypto";
import { canReviewId, loadLeaseIdCheck } from "@/server/id-docs";
import { leaseTermsEditable } from "@/server/lease-rules";
import { portalLoginReady } from "@/server/portal-invite";
import { isMoveOutNoticeEnabled } from "@/server/move-out-notice";
import { can } from "@/server/perms";
import { majorField } from "@/server/portfolio";
import { isUuid } from "@/server/repair-rules";
import { leaseDetail, threadMessages } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";
import { billingPreviewsEnabled } from "@/server/billing-preview-rules";
import { paymentRequestEnabled } from "@/server/payment-request-status";
import { paymentRequestCopy } from "@/i18n/lanes/reminders";

export const dynamic = "force-dynamic";

export default async function LeasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; error?: string; audit?: string; created?: string; idv?: string; utility?: string; bill?: string; saved?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
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
  const firstInvoicePreview = tab === "summary" ? await moveInPreview(session, id) : null;
  const paymentRequestScoped = tab === "ledger" && detail.dueMinor > 0 && await paymentRequestEnabled(session);
  const canInvite = session.role === "admin" || session.role === "manager";
  const billingEnabled = canInvite && lease.rent_frequency === "monthly" ? await tx(session.userId, (client) => billingPreviewsEnabled(client, session.orgId), { orgId: session.orgId, environment: session.environment }, { readOnly: true }) : false;
  const tenantActivated = canInvite ? await portalLoginReady(lease.tenant_user_id) : false;
  const reviewer = canReviewId(session);
  const idCheck = reviewer ? await loadLeaseIdCheck(session, id) : null;
  if (idCheck?.uploadedAt) idCheck.uploadedAt = taipeiStamp(new Date(idCheck.uploadedAt));
  const idvToast =
    query.idv === "ok" ? t("idv_ok_toast") : query.idv === "returned" ? t("idv_return_toast") : undefined;
  const money = (minor: number) => moneyLabel(minor, lease.currency, session.locale);
  const tenantSig = signatures.find((row) => row.role === "tenant");
  const managerSig = signatures.find((row) => row.role === "manager");
  const signingOpen = tenantSig?.status !== "signed" || managerSig?.status !== "signed";
  const idBlocked = Boolean(lease.esign !== "imported" && reviewer && idCheck && !idCheck.ready && signingOpen);
  const tabs = [
    ["summary", "s_6b6fe14"],
    ["ledger", "s_6ef99a0"],
    ["sign", "s_8ecfcf9"],
    ["msg", "s_b95abdb"],
  ] as const;
  const messages = tab === "msg" && lease.thread_id ? await threadMessages(session, lease.thread_id) : [];
  const moveOut = tab === "summary" && session.kind === "staff" && can(session, "leases.edit") && !session.needsSandbox
    ? await tx(session.userId, async (client) => {
        if (!(await isMoveOutNoticeEnabled(client, session.orgId))) return null;
        return maybe<{ moved_out_on: string | null }>(client,
          `SELECT moved_out_on::text FROM leases WHERE id=$1 AND org_id=$2`, [id, session.orgId]);
      }, { orgId: session.orgId, environment: session.environment })
    : null;
  return (
    <>
      {lease.archiveState !== "active" && <p>{lease.archiveState === "inherited" ? archiveCopy(session.locale).inherited : archiveCopy(session.locale).archived}</p>}
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
      <FirstPeriodSummary basis={lease.first_period_basis} locale={session.locale} />
      {firstInvoicePreview ? <MoveInInvoicePreview preview={firstInvoicePreview} locale={session.locale} calendar={session.calendar} /> : null}
      {tab === "summary" ? <HandoverEntry session={session} leaseId={id} /> : null}
      {tab === "summary" ? <RenewalComparisonEntry session={session} leaseId={id} /> : null}
      {query.created === "1" ? (
        <div className="alert ok" data-testid="lease-created">
          {t("i_lease_created")}
        </div>
      ) : null}
      {query.saved === "rent" ? (
        <div className="alert ok" data-testid="rent-updated" role="status">
          {t("i_rent_updated")}
        </div>
      ) : null}
      {query.utility === "kept" ? (
        <div className="alert warn" data-testid="utility-run-kept">
          {t("i_utility_run_kept")}
        </div>
      ) : null}
      {query.bill === "kept" ? (
        <div className="alert warn" data-testid="utility-bill-kept">
          {t("i_utility_bill_kept")}
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
                    <td>{t("deposit_policy_reason")}</td>
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
                    {lease.esign === "imported" ? (
                      <span className="chip" data-testid="lease-imported" style={{ marginLeft: 8 }}>
                        {t("i_esign_imported")}
                      </span>
                    ) : null}
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
                <PortalResendEntry session={session} kind="tenant" contactId={lease.tenant_contact_id} leaseId={id} />
              </div>
            ) : null}
            {lease.status !== "active" ? (
              <p>
                <Link href={`/m/leases/${id}?tab=sign`}>{t("s_8ecfcf9")}</Link>
              </p>
            ) : null}
          </div>
          {reviewer && idCheck ? <IdvCard check={idCheck} toast={idvToast} /> : null}
          {!reviewer ? (
            <div className="card pad" id="idvNoAccess" data-testid="idv-no-access">
              <h3>{t("idv_mgr_h")}</h3>
              <p>{t("idv_no_access")}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {moveOut ? <ActualMoveOut leaseId={id} currentDate={moveOut.moved_out_on} locale={session.locale} /> : null}
      {tab === "summary" && (session.role === "admin" || session.role === "manager") ? (
        lease.archiveState === "active" && leaseTermsEditable({
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
            billingEnabled={billingEnabled}
            startDate={lease.start_date}
            endDate={lease.end_date}
            currency={lease.currency}
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
              <PayDialog key={`${session.userId}:${session.orgId}:${id}:${paymentRequestScoped}`} leaseId={id} dueMinor={detail.dueMinor} currency={lease.currency} label={t("s_a924c4c")} returnTo="staff" requestScope={paymentRequestScoped ? { actorId:session.userId, orgId:session.orgId, copy:paymentRequestCopy[session.locale] } : undefined} />
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
                  <td>
                    {detail.lines.some((line) => line.charge_type === "utility" && line.description.startsWith("電費"))
                      ? detail.lines
                          .filter((line) => line.charge_type === "utility" && line.description.startsWith("電費"))
                          .map((line) => (
                            <div key={line.id} data-testid="invoice-utility-line">
                              {line.description}
                            </div>
                          ))
                      : t("i_charge_utility")}
                  </td>
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
                  .filter((line) => !(line.charge_type === "credit" && line.description.startsWith("沖銷電費")))
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
          {idBlocked ? (
            <div className="card pad" id="idvSignWait" data-testid="idv-sign-wait">
              <h3>{t("idv_gate_h")}</h3>
              <p>{t("idv_sign_wait")}</p>
            </div>
          ) : null}
          {!idBlocked ? (
          <>
          <div className="card pad">
            {lease.esign === "imported" ? (
              <p data-testid="lease-imported-sign">{t("i_esign_imported")}</p>
            ) : (
              <>
                <h3>{tenantSig?.status === "signed" ? t("i_tenant_signed") : t("i_tenant_pending")}</h3>
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
                {lease.archiveState === "active" && session.environment === "sandbox" && !session.needsSandbox && tenantSig?.status !== "signed" ? (
                  <form action={actionSimulateSign}>
                    <input type="hidden" name="leaseId" value={id} />
                    <button className="btn pri lg block" type="submit" data-testid="simulate-tenant-sign">
                      {t("s_bbba58a")}
                    </button>
                  </form>
                ) : null}
              </>
            )}
            {(await (await import("@/server/paper-lease-versions-panel")).paperLeaseVersionPanel(session, id, actionUploadSignedPdf)) ?? (
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
            )}
          </div>
          {lease.esign === "imported" ? null : (
          <div className="card pad">
            <h3>{t("i_manager_sign")}</h3>
            {managerSig?.status === "signed" ? (
              <div className="alert ok">{t("i_fully_signed")}</div>
            ) : lease.archiveState !== "active" ? (
              <p>{archiveCopy(session.locale).readOnly}</p>
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
          )}
          </>
          ) : null}
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
