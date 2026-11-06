import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionary, makeT } from "@/i18n";
import { ownerPortalCopy } from "@/i18n/owner-portal-access";
import { statusClass, statusKey } from "@/components/ui";
import { REPAIR_CAT_KEY } from "@/lib/repair-labels";
import { requireCurrentConsent } from "@/server/consent-gate";
import { formatDate } from "@/server/format";
import { ownerRepairDetail } from "@/server/owner-portal-access";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-023 read-only repair detail: owner-safe fields and status history only. Flag OFF ⇒ 404. */
export default async function OwnerRepairDetailPage({ params }: { params: Promise<{ ticketId: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const { ticketId } = await params;
  const row = await ownerRepairDetail(session, ticketId);
  if (!row) notFound();
  const c = ownerPortalCopy(session.locale), t = makeT(session.locale), dict = dictionary(session.locale);
  const day = (iso: string | null) => formatDate(iso, session.locale, session.calendar, dict);
  return (
    <div data-testid="owner-repair-detail" data-access={row.access}>
      <p><Link href="/o/repairs">{c.back}</Link></p>
      <h2>{c.number(row.ticket_number)} · {row.title}</h2>
      <div className="small muted">{[row.property_name, row.unit_label, row.room_label].filter(Boolean).join(" ")} · {t(REPAIR_CAT_KEY[row.category] ?? "i_cat_other")}</div>
      <p>
        <span className={`chip ${statusClass(row.status)}`}>{t(statusKey(row.status))}</span>
        {row.access === "history" ? <span className="chip"> {c.historyBadge}</span> : null}
      </p>
      <div className="small muted">{c.reportedOn(day(row.reported_at))}</div>
      <h3>{c.timeline}</h3>
      {row.timeline.length === 0 ? <p>{c.noTimeline}</p> : (
        <ol data-testid="owner-repair-timeline">
          {row.timeline.map((event, index) => (
            <li key={`${event.at}-${index}`}>{day(event.at)} · {t(statusKey(event.to))}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
