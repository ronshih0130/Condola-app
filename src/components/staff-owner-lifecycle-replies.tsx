import { dictionary } from "@/i18n";
import { staffOwnerCopy } from "@/i18n/owner-replies-messages";
import { formatDate } from "@/server/format";
import { staffOwnerLifecycleReplies } from "@/server/owner-replies-messages";
import type { Session } from "@/server/types";

/**
 * B-023 read-only owner lifecycle replies on the staff lease page. Renders nothing
 * when owner_portal_extensions (or lease_renewal) is OFF or the role lacks leases.edit.
 */
export async function StaffOwnerLifecycleReplies({ session, leaseId }: { session: Session; leaseId: string }) {
  const rows = await staffOwnerLifecycleReplies(session, leaseId);
  if (!rows) return null;
  const c = staffOwnerCopy(session.locale), dict = dictionary(session.locale);
  const day = (iso: string) => formatDate(iso, session.locale, session.calendar, dict);
  return (
    <section className="card pad" data-testid="staff-owner-lifecycle-replies" style={{ marginBottom: 16 }}>
      <b>{c.repliesTitle}</b>
      <p className="small muted">{c.repliesNote}</p>
      {rows.length === 0 ? <p>{c.noReplies}</p> : (
        <ul>
          {rows.map((r) => (
            <li key={r.reply_id}>{day(r.created_at)} · {c.kind[r.notice_kind] ?? r.notice_kind} · {c.version(r.notice_version)} · {c.owner(r.owner_name)}：{r.body}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
