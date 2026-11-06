import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionary } from "@/i18n";
import { ownerRepliesCopy } from "@/i18n/owner-replies-messages";
import { requireCurrentConsent } from "@/server/consent-gate";
import { formatDate } from "@/server/format";
import { ownerLifecycleItems } from "@/server/owner-replies-messages";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-023 owner lifecycle items (current authority only). Flag OFF (owner_portal_extensions) ⇒ 404. Listing writes nothing. */
export default async function OwnerLifecyclePage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const rows = await ownerLifecycleItems(session);
  if (!rows) notFound();
  const c = ownerRepliesCopy(session.locale), dict = dictionary(session.locale);
  const day = (iso: string | null) => formatDate(iso, session.locale, session.calendar, dict);
  return (
    <div data-testid="owner-lifecycle">
      <h2>{c.lifecycleTitle}</h2>
      <p className="small muted">{c.lifecycleIntro}</p>
      {rows.length === 0 ? <p>{c.noItems}</p> : rows.map((row) => (
        <div key={row.record_id} className="card pad" data-testid="owner-lifecycle-item" style={{ marginBottom: 12 }}>
          <b>{c.kind[row.kind] ?? row.kind}</b> <span className="chip">{c.filedBy[row.filed_by] ?? row.filed_by}</span>
          <div className="small">{[row.property_name, row.unit_label, row.room_label].filter(Boolean).join(" ")}</div>
          <div className="small muted">{c.term(day(row.lease_start), row.lease_end ? day(row.lease_end) : null)}</div>
          {row.effective_on ? <div className="small muted">{c.effectiveOn(day(row.effective_on))}</div> : null}
          <div className="small muted">{c.myReplies(row.my_reply_count)}</div>
          <p><Link href={`/o/lifecycle/${row.record_id}`}>{c.open}</Link></p>
        </div>
      ))}
    </div>
  );
}
