import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionary } from "@/i18n";
import { ownerRepliesCopy } from "@/i18n/owner-replies-messages";
import { OwnerTextReplyForm } from "@/components/owner-text-reply-form";
import { requireCurrentConsent } from "@/server/consent-gate";
import { formatDate } from "@/server/format";
import { ownerLifecycleDetail } from "@/server/owner-replies-messages";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * B-023 lifecycle item + the owner's own replies. Tenant and company responses are
 * separate B-012 records and are not shown or altered here. Flag OFF ⇒ 404.
 */
export default async function OwnerLifecycleDetailPage({ params }: { params: Promise<{ recordId: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const { recordId } = await params;
  const row = await ownerLifecycleDetail(session, recordId);
  if (!row) notFound();
  const c = ownerRepliesCopy(session.locale), dict = dictionary(session.locale);
  const day = (iso: string | null) => formatDate(iso, session.locale, session.calendar, dict);
  return (
    <div data-testid="owner-lifecycle-detail">
      <p><Link href="/o/lifecycle">{c.back}</Link></p>
      <h2>{c.kind[row.kind] ?? row.kind}</h2>
      <div className="small"><span className="chip">{c.filedBy[row.filed_by] ?? row.filed_by}</span> {[row.property_name, row.unit_label, row.room_label].filter(Boolean).join(" ")}</div>
      <div className="small muted">{c.term(day(row.lease_start), row.lease_end ? day(row.lease_end) : null)}</div>
      {row.occurred_on ? <div className="small muted">{c.occurredOn(day(row.occurred_on))}</div> : null}
      {row.effective_on ? <div className="small muted">{c.effectiveOn(day(row.effective_on))}</div> : null}
      <p className="small muted">{c.lifecycleIntro}</p>
      <section className="card pad" data-testid="owner-lifecycle-replies">
        <h3>{c.repliesTitle}</h3>
        <p className="small muted">{c.repliesNote}</p>
        {row.my_replies.length === 0 ? <p>{c.noReplies}</p> : (
          <ul>{row.my_replies.map((reply) => <li key={reply.id}>{day(reply.created_at)} · {reply.body}</li>)}</ul>
        )}
        <OwnerTextReplyForm target={{ kind: "lifecycle", recordId: row.record_id, noticeVersion: row.notice_version }} locale={session.locale} />
      </section>
    </div>
  );
}
