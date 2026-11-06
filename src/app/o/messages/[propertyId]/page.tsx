import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionary } from "@/i18n";
import { ownerRepliesCopy } from "@/i18n/owner-replies-messages";
import { OwnerTextReplyForm } from "@/components/owner-text-reply-form";
import { requireCurrentConsent } from "@/server/consent-gate";
import { formatDate } from "@/server/format";
import { ownerThread } from "@/server/owner-replies-messages";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-023 the owner's own thread with the company for one property. Text only. Flag OFF ⇒ 404. */
export default async function OwnerThreadPage({ params }: { params: Promise<{ propertyId: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const { propertyId } = await params;
  const view = await ownerThread(session, propertyId);
  if (!view) notFound();
  const c = ownerRepliesCopy(session.locale), dict = dictionary(session.locale);
  const day = (iso: string | null) => formatDate(iso, session.locale, session.calendar, dict);
  return (
    <div data-testid="owner-thread-detail">
      <p><Link href="/o/messages">{c.threadBack}</Link></p>
      <h2>{view.property_name}</h2>
      <section className="card pad">
        {view.messages.length === 0 ? <p>{c.noMessages}</p> : view.messages.map((m) => (
          <p key={m.message_id} data-testid="owner-thread-message" data-sender={m.sender} className={m.sender === "owner" ? "b" : ""}>
            <span className="small muted">{m.sender === "owner" ? c.fromOwner : c.fromCompany} · {day(m.created_at)}{m.edited ? <span className="chip" data-testid="owner-message-edited"> {c.edited}</span> : null}</span><br />{m.body}
          </p>
        ))}
        <OwnerTextReplyForm target={{ kind: "message", propertyId: view.property_id }} locale={session.locale} />
      </section>
    </div>
  );
}
