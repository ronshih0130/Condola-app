import { notFound } from "next/navigation";
import { dictionary } from "@/i18n";
import { ownerAccountCopy } from "@/i18n/owner-account";
import { OwnerPreferenceToggle, OwnerProfileForm, OwnerRevokeSessionButton } from "@/components/owner-account-forms";
import { requireCurrentConsent } from "@/server/consent-gate";
import { formatDate } from "@/server/format";
import { ownerAccountView } from "@/server/owner-account";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * B-023 owner account: own signed-in devices, own contact details and owner
 * notification settings. Flag OFF ⇒ 404. Viewing writes nothing.
 */
export default async function OwnerAccountPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const view = await ownerAccountView(session);
  if (!view) notFound();
  const c = ownerAccountCopy(session.locale), dict = dictionary(session.locale);
  const day = (iso: string | null) => formatDate(iso, session.locale, session.calendar, dict);
  const current = view.sessions.find((s) => s.is_current);
  return (
    <div data-testid="owner-account">
      <h2>{c.title}</h2>
      <p className="small muted">{c.intro}</p>
      <section className="card pad" data-testid="owner-profile" style={{ marginBottom: 12 }}>
        <h3>{c.profileTitle}</h3>
        <p className="small muted">{c.profileNote}</p>
        <p className="small"><b>{c.email}</b> {view.profile.email ?? c.notSet} <span className="chip">{c.readOnly}</span></p>
        <p className="small"><b>{c.phone}</b> {view.profile.phone_e164 ?? c.notSet} <span className="chip">{c.readOnly}</span></p>
        <OwnerProfileForm locale={session.locale} profile={view.profile} />
      </section>
      <section className="card pad" data-testid="owner-preferences" style={{ marginBottom: 12 }}>
        <h3>{c.prefsTitle}</h3>
        <p className="small muted">{c.prefsNote}</p>
        {view.preferences.map((p) => (
          <div key={p.category} className="row" data-testid="owner-preference" data-category={p.category} data-enabled={p.enabled ? "on" : "off"}>
            <span>{c.categories[p.category]} · {p.enabled ? c.on : c.off}</span>{" "}
            <OwnerPreferenceToggle locale={session.locale} category={p.category} enabled={p.enabled} />
          </div>
        ))}
      </section>
      <section className="card pad" data-testid="owner-sessions">
        <h3>{c.sessionsTitle}</h3>
        <p className="small muted">{c.sessionsNote}</p>
        <p className="small muted" data-testid="owner-session-scope">{c.sessionScope}</p>
        {current && !current.recent_auth && view.sessions.length > 1 ? <p className="small" data-testid="owner-reauth-note">{c.reauthNote}</p> : null}
        <ul>
          {view.sessions.map((s) => (
            <li key={s.session_id} data-testid="owner-session" style={{ marginTop: 8 }}>
              <div className="small">{s.device ?? c.unknownDevice}</div>
              <div className="tiny muted">{c.signedInAt(day(s.created_at))} · {c.lastSeen(day(s.last_active_at))}</div>
              {s.is_current ? <span className="chip pri">{c.thisDevice}</span>
                : current?.recent_auth ? <OwnerRevokeSessionButton locale={session.locale} sessionId={s.session_id} /> : null}
            </li>
          ))}
        </ul>
        <p className="tiny muted">{c.passwordDeferred}</p>
      </section>
    </div>
  );
}
