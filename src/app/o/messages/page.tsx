import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionary } from "@/i18n";
import { ownerRepliesCopy } from "@/i18n/owner-replies-messages";
import { requireCurrentConsent } from "@/server/consent-gate";
import { formatDate } from "@/server/format";
import { ownerMessageThreads } from "@/server/owner-replies-messages";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-023 owner ↔ company threads, one per currently authorized property. Flag OFF ⇒ 404. Listing writes nothing. */
export default async function OwnerMessagesPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const rows = await ownerMessageThreads(session);
  if (!rows) notFound();
  const c = ownerRepliesCopy(session.locale), dict = dictionary(session.locale);
  const day = (iso: string | null) => formatDate(iso, session.locale, session.calendar, dict);
  return (
    <div data-testid="owner-messages">
      <h2>{c.messagesTitle}</h2>
      <p className="small muted">{c.messagesIntro}</p>
      {rows.length === 0 ? <p>{c.noProperties}</p> : rows.map((row) => (
        <div key={row.property_id} className="card pad" data-testid="owner-thread" style={{ marginBottom: 12 }}>
          <b>{row.property_name}</b>
          <div className="small muted">{c.messageCount(row.message_count)}{row.last_message_at ? ` · ${c.lastAt(day(row.last_message_at))}` : ""}</div>
          <p><Link href={`/o/messages/${row.property_id}`}>{c.openThread}</Link></p>
        </div>
      ))}
    </div>
  );
}
