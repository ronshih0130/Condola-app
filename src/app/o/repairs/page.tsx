import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionary, makeT } from "@/i18n";
import { ownerPortalCopy } from "@/i18n/owner-portal-access";
import { statusClass, statusKey } from "@/components/ui";
import { REPAIR_CAT_KEY } from "@/lib/repair-labels";
import { requireCurrentConsent } from "@/server/consent-gate";
import { formatDate } from "@/server/format";
import { ownerRepairs } from "@/server/owner-portal-access";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-023 read-only owner repair progress. Flag OFF (owner_portal_extensions) ⇒ 404. */
export default async function OwnerRepairsPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const rows = await ownerRepairs(session);
  if (!rows) notFound();
  const c = ownerPortalCopy(session.locale), t = makeT(session.locale), dict = dictionary(session.locale);
  const day = (iso: string | null) => formatDate(iso, session.locale, session.calendar, dict);
  return (
    <div data-testid="owner-repairs">
      <h2>{c.repairsTitle}</h2>
      <p className="small muted">{c.repairsIntro}</p>
      {rows.length === 0 ? <p>{c.noRepairs}</p> : rows.map((row) => (
        <div key={row.ticket_id} className="card pad" data-testid="owner-repair" data-access={row.access} style={{ marginBottom: 12 }}>
          <b>{c.number(row.ticket_number)} · {row.title}</b>
          <div className="small muted">{[row.property_name, row.unit_label, row.room_label].filter(Boolean).join(" ")} · {t(REPAIR_CAT_KEY[row.category] ?? "i_cat_other")}</div>
          <div className="small">
            <span className={`chip ${statusClass(row.status)}`}>{t(statusKey(row.status))}</span>
            {row.access === "history" ? <span className="chip"> {c.historyBadge}</span> : null}
          </div>
          <div className="small muted">{c.reportedOn(day(row.reported_at))}{row.last_status_at ? ` · ${c.lastUpdate(day(row.last_status_at))}` : ""}</div>
          <p><Link href={`/o/repairs/${row.ticket_id}`}>{c.detail}</Link></p>
        </div>
      ))}
    </div>
  );
}
