import React from "react";
import type { Locale } from "@/i18n";
import { partnerConsentCopy } from "@/i18n/lanes/partner-consent";
import { partnerConsentHistory, readPartnerState, type PartnerHistoryRow } from "@/server/partner-consent";
import { formatTaipei } from "@/server/time";
import type { Session } from "@/server/types";

export function PartnerConsentHistoryView({ locale, rows }: { locale: Locale; rows: readonly PartnerHistoryRow[] }) {
  const copy = partnerConsentCopy(locale);
  return (
    <section className="card pad" data-testid="partner-consent-history" style={{ maxWidth: 720, marginBottom: 16 }}>
      <h2>{copy.history}</h2>
      {rows.map((row) => (
        <div key={row.doc_type}>
          <h3>{copy[row.doc_type]}</h3>
          <dl>
            <dt>{copy.version}</dt><dd>{row.version}</dd>
            <dt>{copy.time}</dt><dd>{formatTaipei(row.consented_at)}</dd>
            <dt>{copy.consenter}</dt><dd>{row.consenter}</dd>
          </dl>
        </div>
      ))}
    </section>
  );
}

export async function PartnerConsentHistory({ session }: { session: Session }) {
  const state = session.partnerConsent ?? await readPartnerState(session);
  if (!state.active || session.kind !== "staff") return null;
  return <PartnerConsentHistoryView locale={session.locale} rows={await partnerConsentHistory({ ...session, partnerConsent: state })} />;
}
