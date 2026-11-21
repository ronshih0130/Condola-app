import React from "react";
import type { Locale } from "../../../../i18n";
import { vendorDocsCopy } from "../../../../i18n/lanes/brand-v3-vendor-docs";
import type { TicketDocument } from "../../../../server/gs32-vendor-docs";

function money(currency: string, minor: string) {
  const grouped = minor.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return currency === "TWD" ? `NT$${grouped}` : `${currency} ${grouped}`;
}

/**
 * DOC-VOID on the manager repair page (m-docs): every document keeps its nature mark; voided ones stay, listed
 * last, muted, amount struck, number unchanged. 請款單 and 上傳之統一發票 have no data yet (B-067), so only
 * 收據 and 完工明細 appear. The PDF face mark stays hidden (Design Session ruling). No buttons, no writes.
 */
export function TicketDocumentsV3({ locale, currency, documents }: { locale: Locale; currency: string; documents: TicketDocument[] }) {
  const copy = vendorDocsCopy(locale);
  if (!documents.length) return null;
  return <section className="card stack v3-docs" aria-labelledby="v3-docs-title" data-testid="ticket-documents">
    {/* eslint-disable-next-line @next/next/no-css-tags */}
    <link rel="stylesheet" href="/brand/v3/vendor-docs.css" />
    <h2 id="v3-docs-title">{copy.documents}</h2>
    {documents.map(doc => {
      const voided = doc.status === "voided";
      const nature = doc.kind === "receipt" ? copy.markReceipt : copy.markStatement;
      const title = doc.kind === "receipt" ? copy.markReceipt : copy.statementTitle;
      return <div key={doc.id} className={`v3-doc${voided ? " v3-doc-void" : ""}`} data-status={doc.status}>
        <div className="v3-doc-row"><b>{title} {doc.docNo}</b>
          <span className={`v3-doc-mark${voided ? " v3-doc-mark-void" : ""}`}>{voided ? copy.markVoid : nature}</span></div>
        <dl>
          <div><dt>{copy.amount}</dt><dd>{voided
            ? <s className="v3-doc-num"><span className="v3-sr">{copy.markVoid} </span>{money(currency, doc.totalMinor)}</s>
            : <span className="v3-doc-num">{money(currency, doc.totalMinor)}</span>}</dd></div>
          {doc.buyerName ? <div><dt>{copy.billedTo}</dt><dd>{doc.buyerName}</dd></div> : null}
        </dl>
      </div>;
    })}
  </section>;
}
