import { notFound } from "next/navigation";
import { dictionary, makeT } from "@/i18n";
import { ownerPortalCopy } from "@/i18n/owner-portal-access";
import { statusKey } from "@/components/ui";
import { requireCurrentConsent } from "@/server/consent-gate";
import { formatDate } from "@/server/format";
import { ownerDocuments } from "@/server/owner-portal-access";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-023 owner document center. Flag OFF (owner_portal_extensions) ⇒ 404. Listing writes nothing. */
export default async function OwnerFilesPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const rows = await ownerDocuments(session);
  if (!rows) notFound();
  const c = ownerPortalCopy(session.locale), t = makeT(session.locale), dict = dictionary(session.locale);
  const day = (iso: string | null) => formatDate(iso, session.locale, session.calendar, dict);
  return (
    <div data-testid="owner-files">
      <h2>{c.filesTitle}</h2>
      <p className="small muted">{c.filesIntro}</p>
      {rows.length === 0 ? <p>{c.noFiles}</p> : rows.map((row) => (
        <div key={row.document_id} className="card pad" data-testid="owner-file" data-access={row.access} style={{ marginBottom: 12 }}>
          <b>{[row.property_name, row.unit_label, row.room_label].filter(Boolean).join(" ")}</b>
          <div className="small muted">{c.term(day(row.lease_start), row.lease_end ? day(row.lease_end) : null)} · {t(statusKey(row.lease_status))}</div>
          <div className="small">
            <span className={`chip ${row.is_current_version ? "ok" : ""}`}>{row.is_current_version ? c.current : c.superseded}</span>
            {row.access === "history" ? <span className="chip" data-testid="owner-file-history"> {c.historyBadge}</span> : null}
          </div>
          <div className="small muted">{c.uploadedOn(day(row.uploaded_at))}</div>
          <p>
            <a href={`/o/files/${row.document_id}?view=1`} target="_blank" rel="noopener noreferrer">{c.view}</a>
            {" · "}
            <a href={`/o/files/${row.document_id}`} download>{c.download}</a>
          </p>
        </div>
      ))}
    </div>
  );
}
