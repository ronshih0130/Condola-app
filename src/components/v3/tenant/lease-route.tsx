import React, { Suspense } from "react";
import Link from "next/link";
import { makeT } from "../../../i18n";
import { tenantSignedPdfStrings } from "../../../i18n/tenant-signed-pdf";
import { tenantLeaseView } from "../../../server/b090-tenant-lease-repair";
import { signedPdfUploadedAt } from "../../../server/paper-lease-history-time";
import { displaySampleName } from "../../../server/sandbox-data";
import type { Session } from "../../../server/types";
import { FirstPeriodSummary } from "../../first-period-summary";
import { PdfDownloadButton } from "../../pdf-download-button";
import { TenantLeaseError, TenantLeaseLoading, TenantLeaseV3 } from "./lease";

type Props = { session: Session; leaseId: string };

/**
 * RT-LEASE body in its own boundary so the skeleton shows while the readers run (G-LOAD); a failed read is G-ERR.
 * Today's ID check (above the terms), lease PDF, signed copies (same links), first-period summary and firm line stay.
 */
async function TenantLeaseBody({ session, leaseId }: Props) {
  const t = makeT(session.locale);
  const view = await tenantLeaseView(session, leaseId);
  if (view.state === "error") return <TenantLeaseError locale={session.locale} />;
  if (view.state === "empty") return <p>{t("i_empty")}</p>;
  const { money, signedPdfs } = view;
  const signedCopy = tenantSignedPdfStrings(session.locale);
  return <TenantLeaseV3 terms={view.terms} place={displaySampleName(money.lease.place)} locale={session.locale} calendar={session.calendar}
    before={view.idGate ? <div className="card pad" id="idvGate" data-testid="idv-gate">
      <h3>{t("idv_gate_h")}</h3>
      <p>{t("idv_gate")}</p>
      <Link className="btn pri" href="/t/id">{t("idv_start")}</Link>
    </div> : null}
    after={<>
      <FirstPeriodSummary basis={money.lease.first_period_basis} locale={session.locale} />
      <div className="t-ls-card t-ls-docs">
        <p><PdfDownloadButton href={`/api/pdf/leases/${leaseId}`} label={t("s_874a842")} failed={t("pdf_failed")} fontFailed={t("pdf_font_missing")} testId="download-lease-pdf" /></p>
        {signedPdfs.length > 0 ? <section aria-label={signedCopy.title}>
          <h3>{signedCopy.title}</h3>
          <p>{signedCopy.notice}</p>
          <ul>
            {signedPdfs.map(pdf => <li key={pdf.id}>
              <span>{pdf.current ? signedCopy.current : signedCopy.historical}</span>
              {" · "}
              <span>{signedCopy.uploaded}: {signedPdfUploadedAt(pdf.created_at, session.locale, session.calendar)?.label}</span>
              {" · "}
              <a href={`/t/lease/signed/${pdf.id}`} target="_blank" rel="noopener noreferrer">{signedCopy.view}</a>
              {" · "}
              <a href={`/t/lease/signed/${pdf.id}`} download>{signedCopy.download}</a>
            </li>)}
          </ul>
        </section> : null}
      </div>
      <p className="fn">{t("i_firm_uses", { firm: money.lease.firm, brand: t("i_brand") })}</p>
    </>} />;
}

export function TenantLeaseV3Route(props: Props) {
  return <Suspense fallback={<TenantLeaseLoading />}><TenantLeaseBody {...props} /></Suspense>;
}
